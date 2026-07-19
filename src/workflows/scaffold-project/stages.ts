import { z } from "zod";
import { Prisma, type PrismaClient } from "@supagloo/database-lib";

/**
 * The `ProjectJob.stages` contract for the scaffold workflow.
 *
 * `ProjectJob.stages` is an untyped Prisma `Json` column holding an array of
 * `{ key, label, state }`. It is the progress log the studio UI renders and the
 * workflow updates step-by-step. Each workflow step updates its OWN entry by
 * `key` — an upsert-in-place via the pure {@link mergeStage} fold, never an append
 * — so a step that replays after a crash simply re-writes `done` (a no-op relative
 * to the already-recorded state). Stage-write idempotency works WITH DBOS's
 * step-level checkpointing, not as a second mechanism.
 *
 * SCOPE (design-delta §7 / task 17): the stage catalogue lives here in dbos for
 * now because task 17 is dbos-only and the API-side seeding of these rows (task 18
 * enqueue) does not exist yet. When task 18 builds the enqueue path, promote this
 * catalogue + schema to database-lib as the SHARED contract between the API (which
 * seeds the row) and DBOS (which updates it).
 */

export const STAGE_STATES = ["pending", "running", "done", "failed"] as const;
export type StageState = (typeof STAGE_STATES)[number];

export interface JobStage {
  key: string;
  label: string;
  state: StageState;
}

export const JobStageSchema = z.object({
  key: z.string().min(1),
  label: z.string().min(1),
  state: z.enum(STAGE_STATES),
});
export const JobStagesSchema = z.array(JobStageSchema);

/**
 * The eight scaffold steps, row-for-row (design-delta §6b / §7). The `key` of each
 * entry is EXACTLY the corresponding `DBOS.runStep` name, so the stage log and the
 * step checkpoints line up one-to-one.
 */
export const SCAFFOLD_STAGES: ReadonlyArray<{ key: string; label: string }> = [
  { key: "mintInstallationToken", label: "Authenticating with GitHub" },
  { key: "ensureRepoAccessible", label: "Verifying repository access" },
  { key: "cloneToWorkspace", label: "Cloning repository" },
  { key: "writeRemotionScaffold", label: "Writing project scaffold" },
  { key: "commitBaseVersion", label: "Committing base version (v0.0.0)" },
  { key: "pushOpenMergeBasePr", label: "Opening & merging base pull request" },
  { key: "cutWorkingBranch", label: "Cutting working branch (v0.0.1)" },
  { key: "finalizeRecords", label: "Finalizing project records" },
] as const;

/** A fresh stage log with every stage `pending` (what the API seeds at enqueue). */
export function initialStages(): JobStage[] {
  return SCAFFOLD_STAGES.map((s) => ({ key: s.key, label: s.label, state: "pending" }));
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

/** `JobStage[]` lacks an index signature so is not structurally `InputJsonObject`;
 *  it IS valid JSON at runtime, so narrow it to the Prisma JSON input type. */
export function toJson(stages: JobStage[]): Prisma.InputJsonValue {
  return stages as unknown as Prisma.InputJsonValue;
}
