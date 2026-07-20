import {
  PUBLISH_STAGES,
  buildInitialStages,
  type JobStage,
} from "@supagloo/database-lib";

/**
 * `ProjectJob.stages` helper for the publish-version workflow.
 *
 * The read-modify-write mechanics (`markStageDone`, `markJobRunning`, `mergeStage`,
 * `toJson`) are GENERIC and reused from the scaffold module — publish keys off the same
 * stage array. The only publish-specific piece is the seven-stage initial log; publish has
 * NO content-failure recorder (its transport failures follow scaffold/commit parity — DBOS
 * retry/recovery).
 */

export { PUBLISH_STAGES };

/** A fresh publish stage log with every stage `pending` (what the API seeds at enqueue). */
export function initialPublishStages(): JobStage[] {
  return buildInitialStages(PUBLISH_STAGES);
}
