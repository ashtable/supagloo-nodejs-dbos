import { Prisma, type PrismaClient } from "@supagloo/database-lib";

/**
 * The `AiGeneration` status/result writes (design-delta §6d step 8). This workflow ONLY
 * touches the `AiGeneration` row — status lifecycle + the structured result + token usage.
 * It NEVER writes `ProjectVersion` or the manifest (that is the separate commit workflow).
 * All writes are idempotent (keyed by the generation id = workflow id) so DBOS replay is safe.
 */

const toJson = (v: unknown): Prisma.InputJsonValue =>
  v as unknown as Prisma.InputJsonValue;

/** Flip queued → running at the start of the workflow. */
export async function markGenerationRunning(
  prisma: PrismaClient,
  generationId: string,
): Promise<void> {
  await prisma.aiGeneration.update({
    where: { id: generationId },
    data: { status: "running" },
  });
}

/** Idempotent success upsert: status succeeded + resultJson + tokenUsage + completedAt. */
export async function persistGenerationResult(
  prisma: PrismaClient,
  generationId: string,
  args: { resultJson: unknown; tokenUsage: unknown },
): Promise<void> {
  await prisma.aiGeneration.update({
    where: { id: generationId },
    data: {
      status: "succeeded",
      resultJson: toJson(args.resultJson),
      tokenUsage: toJson(args.tokenUsage),
      completedAt: new Date(),
      error: null,
    },
  });
}

/** Idempotent failure write: status failed + the terminal error + completedAt. */
export async function markGenerationFailed(
  prisma: PrismaClient,
  generationId: string,
  error: string,
): Promise<void> {
  await prisma.aiGeneration.update({
    where: { id: generationId },
    data: { status: "failed", error, completedAt: new Date() },
  });
}
