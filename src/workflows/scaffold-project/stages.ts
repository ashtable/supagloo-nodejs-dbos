import {
  Prisma,
  type PrismaClient,
  SCAFFOLD_STAGES,
  STAGE_STATES,
  buildInitialStages,
  JobStageSchema,
  JobStagesSchema,
  type JobStage,
  type StageState,
} from "@supagloo/database-lib";

/**
 * The `ProjectJob.stages` helpers for the scaffold workflow.
 *
 * SCOPE (task 18): the stage CONTRACT — `STAGE_STATES`/`JobStage`/`JobStageSchema`,
 * the `SCAFFOLD_STAGES` catalogue, and `buildInitialStages` — was promoted to
 * database-lib as the SHARED API↔DBOS format (the API seeds the row, this workflow
 * updates it). They are re-exported here so this module stays the scaffold workflow's
 * single stages import site. The read-modify-write helpers below stay local (they are
 * DBOS-runtime concerns: they touch Prisma + the `InputJsonValue` cast).
 *
 * Each workflow step updates its OWN entry by `key` — an upsert-in-place via the pure
 * {@link mergeStage} fold, never an append — so a step that replays after a crash
 * simply re-writes `done` (a no-op relative to the already-recorded state).
 */

export {
  SCAFFOLD_STAGES,
  STAGE_STATES,
  JobStageSchema,
  JobStagesSchema,
  type JobStage,
  type StageState,
};

/** A fresh scaffold stage log with every stage `pending` (what the API seeds at
 *  enqueue). Zero-arg wrapper over the shared `buildInitialStages`. */
export function initialStages(): JobStage[] {
  return buildInitialStages(SCAFFOLD_STAGES);
}

/**
 * Pure upsert-by-key: return a NEW array with the matching stage's `state` set.
 * Order and every other stage are preserved; an unknown key is a no-op (never
 * appends). Idempotent — applying the same update twice equals applying it once.
 */
export function mergeStage(
  stages: JobStage[],
  key: string,
  state: StageState,
): JobStage[] {
  return stages.map((stage) =>
    stage.key === key ? { ...stage, state } : stage,
  );
}

/**
 * Read-modify-write the job's `stages` Json, marking one stage `done`. Idempotent:
 * safe to re-run on replay. Validates the persisted shape defensively (the column
 * is untyped `Json`).
 */
export async function markStageDone(
  prisma: PrismaClient,
  jobId: string,
  key: string,
): Promise<void> {
  const job = await prisma.projectJob.findUniqueOrThrow({
    where: { id: jobId },
    select: { stages: true },
  });
  const stages = JobStagesSchema.parse(job.stages);
  await prisma.projectJob.update({
    where: { id: jobId },
    data: { stages: toJson(mergeStage(stages, key, "done")) },
  });
}

/**
 * Flip the job's top-level `status` to `running` (design-delta §2.9 lifecycle). The
 * first thing the scaffold workflow does, so the polling UI observes queued→running
 * before any stage completes. Status ONLY — the stage log is untouched here. Idempotent
 * and DBOS-checkpointed (skipped on replay; `finalizeRecords` later sets `succeeded`).
 */
export async function markJobRunning(
  prisma: PrismaClient,
  jobId: string,
): Promise<void> {
  await prisma.projectJob.update({
    where: { id: jobId },
    data: { status: "running" },
  });
}

/** `JobStage[]` lacks an index signature so is not structurally `InputJsonObject`;
 *  it IS valid JSON at runtime, so narrow it to the Prisma JSON input type. */
export function toJson(stages: JobStage[]): Prisma.InputJsonValue {
  return stages as unknown as Prisma.InputJsonValue;
}
