import { DBOS } from "@dbos-inc/dbos-sdk";
import { WORKFLOW_NAMES } from "../dbos/registry";
import { getAppDb } from "../db/app-db";
import { getS3Config } from "../files/s3-config";
import { deleteAssets, listAssets } from "../files/s3-client";
import { getCleanupConfig } from "./cleanup-orphaned-assets/config";
import {
  ORPHAN_STATUSES,
  excludeReferencedKeys,
  generationAssetCandidates,
  isDeletableRenderObjectKey,
  renderKeyCandidates,
  renderObjectPrefix,
  retentionCutoff,
  selectOrphanedGenerations,
  selectOrphanedRenderJobs,
  type CleanupCandidate,
} from "./cleanup-orphaned-assets/selection";

/**
 * `cleanupOrphanedAssetsWorkflow` (queue `maintenance`) — design-delta §7 workflow 10,
 * plan row 42. The scheduled daily janitor: it deletes the S3 objects of failed/canceled
 * jobs past the retention window, and purges `Session` rows past `expiresAt`.
 *
 * READ `dbos/scheduled-cleanup.ts` BEFORE CHANGING ANYTHING HERE. This is the only
 * destructive workflow in the system and the only S3 delete path in the design, and it
 * operates on state that fifteen in-process e2e lanes share. The SCHEDULE that arms it
 * lives in a module only `src/main.ts` imports, so the schedule is inert in every lane by
 * construction (D42.1); `src/dbos/scheduled-cleanup.fence.test.ts` holds that property.
 * The workflow ITSELF registers here at module load like every other workflow, so its name
 * is in the frozen registry and a test can invoke it directly.
 *
 * FOUR STEPS, in this order:
 *   selectOrphanCandidates → listOrphanObjects → deleteOrphanObjects → purgeExpiredSessions
 *
 * The DETERMINISM contract that shapes them: the clock is read INSIDE step 1 and both the
 * cutoff and the candidate set are part of that step's checkpointed result, so a replay
 * re-uses the same instant and the same decisions rather than re-deciding against a later
 * `now`. Nothing in the workflow body reads a clock or the environment.
 *
 * The two destructive steps are SKIPPED entirely under `CLEANUP_DRY_RUN` — no S3 command
 * is constructed and no `deleteMany` is issued — so a dry run cannot delete by accident;
 * it is not a flag checked deep inside a mutation helper.
 */

export const CLEANUP_ORPHANED_ASSETS_WORKFLOW_NAME =
  WORKFLOW_NAMES.cleanupOrphanedAssets;

export interface CleanupOrphanedAssetsResult {
  /** True when nothing was mutated. */
  dryRun: boolean;
  /** The instant step 1 read, ISO — the basis for both the retention cutoff and the session purge. */
  now: string;
  /** Objects older than this were in scope, ISO. */
  cutoff: string;
  /** Keys that exist in the bucket, are in scope, and are referenced by no live row. */
  plannedKeys: string[];
  /** Keys actually removed. Empty on a dry run. */
  deletedKeys: string[];
  /** Per-key S3 delete failures, surfaced rather than swallowed. */
  deleteErrors: Array<{ key?: string; code?: string; message?: string }>;
  /** How many `Session` rows were past `expiresAt`. */
  expiredSessions: number;
  /** How many were actually removed. Zero on a dry run. */
  sessionsPurged: number;
}

interface SelectionResult {
  now: string;
  cutoff: string;
  /** Candidate keys grouped by the render job that owns them, for the prefix listing. */
  renderJobIds: string[];
  /** Candidates whose key is known exactly (generations) — no listing needed to name them. */
  directCandidates: CleanupCandidate[];
  /** Every key a live row still points at. */
  referencedKeys: string[];
}

async function cleanupOrphanedAssetsFn(
  _scheduledTime: Date,
  _startTime: Date,
): Promise<CleanupOrphanedAssetsResult> {
  const prisma = getAppDb();
  const cfg = getCleanupConfig();

  // 1) selectOrphanCandidates — every DB read, and the ONE clock read, in one checkpoint.
  const selection = await DBOS.runStep<SelectionResult>(
    async () => {
      const now = new Date();
      const cutoff = retentionCutoff(now, cfg.retentionMs);

      // Status-filtered AT THE DATABASE: a succeeded render's rows never enter this
      // process, which is a stronger guarantee than filtering them out afterwards.
      const renders = await prisma.renderJob.findMany({
        where: { status: { in: [...ORPHAN_STATUSES] } },
        select: { id: true, status: true, createdAt: true, completedAt: true },
      });
      const generations = await prisma.aiGeneration.findMany({
        where: { status: { in: [...ORPHAN_STATUSES] } },
        select: {
          id: true,
          projectId: true,
          status: true,
          createdAt: true,
          completedAt: true,
        },
      });

      // Every key a live row still points at. Read WHOLE-TABLE and unfiltered on purpose:
      // the question is "does anything reference this key", and a `where` clause here
      // would be a second place for the exclusion rule to be wrong.
      const [projects, allRenders, allGenerations, gallery] = await Promise.all([
        prisma.project.findMany({ select: { thumbnailAssetKey: true } }),
        prisma.renderJob.findMany({
          select: { outputAssetKey: true, thumbnailAssetKey: true },
        }),
        prisma.aiGeneration.findMany({ select: { resultAssetKey: true } }),
        prisma.galleryItem.findMany({
          select: { videoAssetKey: true, thumbnailAssetKey: true },
        }),
      ]);

      const referencedKeys = [
        ...projects.map((p) => p.thumbnailAssetKey),
        ...allRenders.flatMap((r) => [r.outputAssetKey, r.thumbnailAssetKey]),
        ...allGenerations.map((g) => g.resultAssetKey),
        ...gallery.flatMap((g) => [g.videoAssetKey, g.thumbnailAssetKey]),
      ].filter((k): k is string => typeof k === "string" && k !== "");

      return {
        now: now.toISOString(),
        cutoff: cutoff.toISOString(),
        renderJobIds: selectOrphanedRenderJobs(renders, cutoff).map((r) => r.id),
        directCandidates: selectOrphanedGenerations(generations, cutoff).flatMap(
          generationAssetCandidates,
        ),
        referencedKeys,
      };
    },
    { name: "selectOrphanCandidates" },
  );

  // 2) listOrphanObjects — narrow to what ACTUALLY exists. The common case for a failed
  //    render is that nothing was ever uploaded (asset keys are written only on success),
  //    so this is also what keeps the delete step from being called at all most nights.
  const plannedKeys = await DBOS.runStep<string[]>(
    async () => {
      const { client, bucket } = getS3Config();
      const found: CleanupCandidate[] = [];

      for (const renderJobId of selection.renderJobIds) {
        const listed = await listAssets(client, {
          bucket,
          prefix: renderObjectPrefix(renderJobId),
        });
        const admissible = new Set(
          listed.filter((k) => isDeletableRenderObjectKey(k, renderJobId)),
        );
        // Intersect the LISTING with the canonical family: a stray object under the
        // prefix is not deleted, and a canonical key that is not present is not queued.
        found.push(...renderKeyCandidates(renderJobId).filter((c) => admissible.has(c.key)));
      }

      for (const candidate of selection.directCandidates) {
        // The key is known exactly, so the "listing" is an existence check on that key.
        const listed = await listAssets(client, { bucket, prefix: candidate.key });
        if (listed.includes(candidate.key)) found.push(candidate);
      }

      return excludeReferencedKeys(found, selection.referencedKeys).map((c) => c.key);
    },
    { name: "listOrphanObjects" },
  );

  // 3) deleteOrphanObjects — the only object deletion in the system.
  const deletion = await DBOS.runStep<{
    deletedKeys: string[];
    deleteErrors: CleanupOrphanedAssetsResult["deleteErrors"];
  }>(
    async () => {
      // Dry run short-circuits BEFORE any S3 command is constructed.
      if (cfg.dryRun || plannedKeys.length === 0) {
        return { deletedKeys: [], deleteErrors: [] };
      }
      const { client, bucket } = getS3Config();
      const res = await deleteAssets(client, { bucket, keys: plannedKeys });
      return { deletedKeys: res.deleted, deleteErrors: res.errors };
    },
    { name: "deleteOrphanObjects" },
  );

  // 4) purgeExpiredSessions — `expiresAt` ONLY. Sessions are sliding, so `createdAt` or
  //    `lastUsedAt` would evict live users (D42.5: implemented literally, no grace period).
  const sessions = await DBOS.runStep<{ expired: number; purged: number }>(
    async () => {
      // The SAME instant step 1 read, so a replay purges the same set.
      const expiresBefore = new Date(selection.now);
      if (cfg.dryRun) {
        return {
          expired: await prisma.session.count({ where: { expiresAt: { lt: expiresBefore } } }),
          purged: 0,
        };
      }
      const { count } = await prisma.session.deleteMany({
        where: { expiresAt: { lt: expiresBefore } },
      });
      return { expired: count, purged: count };
    },
    { name: "purgeExpiredSessions" },
  );

  return {
    dryRun: cfg.dryRun,
    now: selection.now,
    cutoff: selection.cutoff,
    plannedKeys,
    deletedKeys: deletion.deletedKeys,
    deleteErrors: deletion.deleteErrors,
    expiredSessions: sessions.expired,
    sessionsPurged: sessions.purged,
  };
}

/**
 * STATIC registration at module load, imported by `runtime.ts` — exactly like every other
 * workflow, and deliberately so: the name must be in the frozen registry in every runtime
 * (including the e2e lanes, which invoke it directly). What is NOT here is the SCHEDULE.
 */
export const cleanupOrphanedAssetsWorkflow = DBOS.registerWorkflow(
  cleanupOrphanedAssetsFn,
  { name: CLEANUP_ORPHANED_ASSETS_WORKFLOW_NAME },
);
