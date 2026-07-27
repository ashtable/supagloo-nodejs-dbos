import {
  buildAssetKey,
  buildRenderOutputKey,
  buildRenderThumbnailKey,
  parseS3Key,
} from "@supagloo/database-lib";

/**
 * Plan row 42 — the PURE selection rules of `cleanupOrphanedAssetsWorkflow`.
 *
 * No Prisma, no S3, no clock: everything here is a total function of its arguments, so
 * the rules that decide what gets permanently deleted from the ONE shared bucket can be
 * tested exhaustively without a database or a network. The workflow supplies the rows,
 * the cutoff and the listing; this module supplies the judgement.
 *
 * THE NON-OBVIOUS PART (brief §1.2 item 4). Failed and canceled jobs have **NULL asset
 * keys**: `RenderJob.outputAssetKey`/`thumbnailAssetKey` are written only by
 * `markRenderCompleted` (step 15), *after* `uploadOutputs` (step 14), and
 * `AiGeneration.resultAssetKey` likewise only on success. So an orphan cannot be found by
 * reading a column — the column is null precisely in the cases we care about. Orphans are
 * found by the DETERMINISTIC KEY FAMILY instead, always through db-lib's shared builders
 * and `parseS3Key`, never a hand-built string: the layout is a cross-service contract
 * (the API presigns downloads against the same keys), and a locally-composed
 * `renders/${id}/output.mp4` here would be a second, silently-drifting copy of it.
 *
 * TWO INDEPENDENT SAFETY RULES, both required:
 *   • selection is STATUS-DRIVEN (`failed`/`canceled` only), never "this object looks
 *     unreferenced" — a succeeded render's objects back `GET /v1/gallery/:id/stream-url`
 *     and the `makingOf` snapshot, and must never be reachable by this sweep at all;
 *   • whatever survives that is then filtered against every key a live row still points
 *     at, because a CANCELED render can have uploaded a thumbnail that
 *     `Project.thumbnailAssetKey` now references (design-delta §2.6:228).
 */

/** D42.2 — 7 days. See {@link retentionCutoff} for why the number is load-bearing. */
export const CLEANUP_RETENTION_HOURS_DEFAULT = 168;

/**
 * D42.2's floor: the retention window may never be configured below 24 hours (Step-11
 * item 21 / R42-6).
 *
 * §10 R3 states the two safety properties of this sweep are D42.1's structural fence AND
 * this window, "neither alone sufficient". The fence keeps the SCHEDULE out of the fifteen
 * in-process e2e lanes; the window is what keeps the Compose `dbos` container's own 03:00
 * sweep away from the seconds-old fixtures those lanes leave in the SHARED app database and
 * the SHARED `supagloo-dev` bucket. `z.coerce.number().positive()` accepted `0.001`, which
 * would have made every fixture in the system deletable within four seconds of creation.
 * 24 hours is the smallest window that puts an entire working day of fixtures out of reach.
 */
export const CLEANUP_RETENTION_HOURS_MIN = 24;

/**
 * `CLEANUP_MAX_ITEMS_PER_RUN`'s default (Step-11 item 12 / R42-3).
 *
 * The candidate set grows monotonically — a failed job whose objects never existed stays a
 * candidate for ever — and the measured dev-DB trajectory was already 315 sequential S3
 * LISTs inside ONE step, with a correspondingly large single `operation_outputs` checkpoint.
 * 500 per model bounds a run at 2 × 500 LISTs worst case while comfortably exceeding the
 * observed nightly arrival rate, so a healthy system still drains its backlog in one pass and
 * an unhealthy one degrades into "several nights" rather than "one unbounded step".
 */
export const CLEANUP_MAX_ITEMS_PER_RUN_DEFAULT = 500;

/** The only two job statuses whose objects are ever candidates for deletion. */
export const ORPHAN_STATUSES = ["failed", "canceled"] as const;

export type OrphanReason = "render-output" | "render-thumbnail" | "generation-asset";

export interface CleanupCandidate {
  /** The S3 key, always produced by a db-lib builder. */
  key: string;
  reason: OrphanReason;
  /** The RenderJob / AiGeneration id the key belongs to. */
  sourceId: string;
}

export interface RenderJobRow {
  id: string;
  status: string;
  createdAt: Date;
  completedAt: Date | null;
}

export interface GenerationRow {
  id: string;
  projectId: string | null;
  status: string;
  createdAt: Date;
  completedAt: Date | null;
}

/**
 * The instant before which a terminal job is old enough to sweep.
 *
 * The default window is not merely a policy preference: it is the second half of D42.1's
 * safety argument. The Compose `dbos` container runs this sweep nightly against the SAME
 * app database and the SAME `supagloo-dev` bucket that fifteen in-process e2e lanes use,
 * and those lanes' fixtures are seconds old. A 7-day window puts every fixture out of
 * reach by a margin of days.
 */
export function retentionCutoff(now: Date, retentionMs: number): Date {
  return new Date(now.getTime() - retentionMs);
}

/** A terminal row's age reference: when it finished, or when it was created if it never did. */
function terminalAt(row: { createdAt: Date; completedAt: Date | null }): Date {
  // `completedAt` is stamped by `markRenderFailed`/`markRenderCanceled`, so it is normally
  // present. The `createdAt` fallback stops a row that died before ANY terminal writer ran
  // from being immortal — otherwise the most broken jobs would be the ones never cleaned.
  return row.completedAt ?? row.createdAt;
}

function isOrphanStatus(status: string): boolean {
  return (ORPHAN_STATUSES as readonly string[]).includes(status);
}

function isPastRetention(
  row: { createdAt: Date; completedAt: Date | null },
  cutoff: Date,
): boolean {
  // STRICT: a row exactly at the cutoff is left for the next run. One extra day of an
  // orphan costs nothing; deleting one second early is unrecoverable.
  return terminalAt(row).getTime() < cutoff.getTime();
}

/** Terminal-and-aged render jobs. A `succeeded` job can never appear here. */
export function selectOrphanedRenderJobs(
  rows: RenderJobRow[],
  cutoff: Date,
): RenderJobRow[] {
  return rows.filter((r) => isOrphanStatus(r.status) && isPastRetention(r, cutoff));
}

/** Terminal-and-aged AI generations. Same rule, same reasons. */
export function selectOrphanedGenerations(
  rows: GenerationRow[],
  cutoff: Date,
): GenerationRow[] {
  return rows.filter((r) => isOrphanStatus(r.status) && isPastRetention(r, cutoff));
}

/** `renders/{renderJobId}/` — the narrowest prefix that can hold this job's objects. */
export function renderObjectPrefix(renderJobId: string): string {
  // Derived from the shared builder rather than composed, so the prefix cannot drift from
  // the layout the writer actually used.
  const output = buildRenderOutputKey(renderJobId);
  return output.slice(0, output.lastIndexOf("/") + 1);
}

/** The two canonical objects a render job can own. */
export function renderKeyCandidates(renderJobId: string): CleanupCandidate[] {
  return [
    {
      key: buildRenderOutputKey(renderJobId),
      reason: "render-output",
      sourceId: renderJobId,
    },
    {
      key: buildRenderThumbnailKey(renderJobId),
      reason: "render-thumbnail",
      sourceId: renderJobId,
    },
  ];
}

/**
 * The single object an AI generation can own. A generation with no `projectId` (the
 * column is nullable) owns nothing this sweep can name, so it contributes nothing —
 * rather than guessing at a key.
 */
export function generationAssetCandidates(row: GenerationRow): CleanupCandidate[] {
  if (!row.projectId) return [];
  return [
    {
      key: buildAssetKey(row.projectId, row.id),
      reason: "generation-asset",
      sourceId: row.id,
    },
  ];
}

/**
 * May a listed object under `renders/{renderJobId}/` be deleted?
 *
 * A `ListObjectsV2` returns whatever is actually there, which is not necessarily what the
 * render workflow wrote. Admission goes through db-lib's `parseS3Key`, so anything the
 * shared layout does not positively recognise as THIS job's output or thumbnail is left
 * alone. String matching would be one typo away from deleting a neighbour's object.
 */
export function isDeletableRenderObjectKey(key: string, renderJobId: string): boolean {
  const parsed = parseS3Key(key);
  if (parsed === null) return false;
  if (parsed.kind !== "render-output" && parsed.kind !== "render-thumbnail") return false;
  return parsed.renderJobId === renderJobId;
}

/**
 * Drop every candidate a live row still points at.
 *
 * The motivating case is real: a render CANCELED after `uploadOutputs` can have a
 * thumbnail that `Project.thumbnailAssetKey` now references, so status alone would blank
 * a live project card. Null/empty reference columns are ignored rather than treated as
 * keys — a null `thumbnailAssetKey` must not match a candidate.
 */
export function excludeReferencedKeys(
  candidates: CleanupCandidate[],
  referenced: Array<string | null | undefined>,
): CleanupCandidate[] {
  const live = new Set(referenced.filter((k): k is string => typeof k === "string" && k !== ""));
  return candidates.filter((c) => !live.has(c.key));
}

/**
 * `isExpiredSession(session, now)` USED TO LIVE HERE, and was DELETED by Step-11 item 20
 * (R42-5). It had no production consumer and could not have had one: `purgeExpiredSessions`
 * issues a Prisma `deleteMany({ where: { expiresAt: { lt: … } } })`, and a row PREDICATE
 * cannot build a query `where`. So its three unit tests exercised nothing that ships, while
 * reading as coverage of the destructive purge's selection rule — the most dangerous kind of
 * dead code, because it makes an untested line look tested.
 *
 * The rule it documented is REAL and still enforced, in the only place it can be: sessions are
 * SLIDING (every authenticated request re-stamps `expiresAt`), so `createdAt`/`lastUsedAt`
 * describe nothing about liveness and keying on either would evict active users. The purge's
 * `where` is pinned whole — column AND shared instant — by U-CLW4/U-CLW4b in
 * `cleanup-orphaned-assets.test.ts`.
 */
