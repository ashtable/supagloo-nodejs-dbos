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
 * Is this session past its expiry?
 *
 * Sessions are SLIDING — every authenticated request re-stamps `expiresAt` — so
 * `createdAt` and `lastUsedAt` describe nothing about liveness and must never be inputs
 * here: keying on either would evict active users. STRICT comparison, matching the
 * retention boundary above.
 */
export function isExpiredSession(session: { expiresAt: Date }, now: Date): boolean {
  return session.expiresAt.getTime() < now.getTime();
}
