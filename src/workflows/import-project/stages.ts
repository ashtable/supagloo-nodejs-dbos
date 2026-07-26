import {
  IMPORT_STAGES,
  buildInitialStages,
  type JobStage,
} from "@supagloo/database-lib";
import { markJobFailed } from "../scaffold-project/stages";

/**
 * `ProjectJob.stages` helpers for the import-verify workflow.
 *
 * The read-modify-write mechanics (`mergeStage` fold, `toJson` cast) and the
 * per-step/per-status writers (`markStageDone`, `markJobRunning`, `markJobFailed`) are
 * GENERIC — they key off the stage array, not the catalogue — so import reuses them
 * from the scaffold module rather than duplicating them. Only the import-specific piece
 * lives here: the six-stage initial log.
 *
 * `markJobFailed` moved to the scaffold module in plan row 63, when scaffold gained the
 * same terminal-failure recording (D63.7); it is re-exported here so import's existing
 * import site and its unit suite are unchanged.
 */

export { IMPORT_STAGES, markJobFailed };

/** A fresh import stage log with every stage `pending` (what the API seeds at enqueue).
 *  Zero-arg wrapper over the shared `buildInitialStages`. */
export function initialImportStages(): JobStage[] {
  return buildInitialStages(IMPORT_STAGES);
}
