import {
  COMMIT_STAGES,
  buildInitialStages,
  type JobStage,
} from "@supagloo/database-lib";

/**
 * `ProjectJob.stages` helper for the commit-version workflow.
 *
 * The read-modify-write mechanics (`markStageDone`, `markJobRunning`, `mergeStage`,
 * `toJson`) are GENERIC and reused from the scaffold module — commit keys off the same
 * stage array. The only commit-specific piece is the five-stage initial log; commit has
 * NO content-failure recorder (its manifest is validated at the API boundary, and
 * transport failures follow scaffold parity — DBOS retry/recovery).
 */

export { COMMIT_STAGES };

/** A fresh commit stage log with every stage `pending` (what the API seeds at enqueue). */
export function initialCommitStages(): JobStage[] {
  return buildInitialStages(COMMIT_STAGES);
}
