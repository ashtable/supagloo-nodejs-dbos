import {
  IMPORT_STAGES,
  JobStagesSchema,
  buildInitialStages,
  type JobStage,
  type PrismaClient,
} from "@supagloo/database-lib";
import { mergeStage, toJson } from "../scaffold-project/stages";

/**
 * `ProjectJob.stages` helpers for the import-verify workflow.
 *
 * The read-modify-write mechanics (`mergeStage` fold, `toJson` cast) and the
 * per-step/per-status writers (`markStageDone`, `markJobRunning`) are GENERIC — they
 * key off the stage array, not the catalogue — so import reuses them from the scaffold
 * module rather than duplicating them. Only the import-specific pieces live here: the
 * six-stage initial log, and `markJobFailed`, which records the terminal 12b state on a
 * permanent content failure.
 */

export { IMPORT_STAGES };

/** A fresh import stage log with every stage `pending` (what the API seeds at enqueue).
 *  Zero-arg wrapper over the shared `buildInitialStages`. */
export function initialImportStages(): JobStage[] {
  return buildInitialStages(IMPORT_STAGES);
}

/**
 * Record a PERMANENT failure onto the job: flip `status = failed`, mark the offending
 * stage `failed` (an upsert-in-place via {@link mergeStage}), stamp `completedAt`, and
 * write the human-readable `error`. Idempotent under replay (the failed workflow only
 * re-runs if explicitly resumed; a re-write of the same failed state is a no-op).
 */
export async function markJobFailed(
  prisma: PrismaClient,
  jobId: string,
  failedStageKey: string,
  errorMessage: string,
): Promise<void> {
  const job = await prisma.projectJob.findUniqueOrThrow({
    where: { id: jobId },
    select: { stages: true },
  });
  const stages = JobStagesSchema.parse(job.stages);
  await prisma.projectJob.update({
    where: { id: jobId },
    data: {
      status: "failed",
      completedAt: new Date(),
      error: errorMessage,
      stages: toJson(mergeStage(stages, failedStageKey, "failed")),
    },
  });
}
