import { type PrismaClient } from "@supagloo/database-lib";

/**
 * The `AiGeneration` status/result writes for the image workflow (design-delta §7 workflow 6).
 * This workflow ONLY touches the `AiGeneration` row — status lifecycle + `resultAssetKey`
 * (the S3 key of the uploaded asset; image has NO `resultJson` — the asset IS the result).
 * It NEVER writes `ProjectVersion` or the manifest (that is the commit workflow). All writes
 * are idempotent (keyed by the generation id = workflow id) so DBOS replay is safe.
 */

/** Flip queued → running at the start of the workflow. */
export async function markImageGenerationRunning(
  prisma: PrismaClient,
  generationId: string,
): Promise<void> {
  await prisma.aiGeneration.update({
    where: { id: generationId },
    data: { status: "running" },
  });
}

/** Idempotent success upsert: status succeeded + resultAssetKey + completedAt. */
export async function persistImageResult(
  prisma: PrismaClient,
  generationId: string,
  args: { assetKey: string },
): Promise<void> {
  await prisma.aiGeneration.update({
    where: { id: generationId },
    data: {
      status: "succeeded",
      resultAssetKey: args.assetKey,
      completedAt: new Date(),
      error: null,
    },
  });
}

/** Idempotent failure write: status failed + the terminal error + completedAt. */
export async function markImageGenerationFailed(
  prisma: PrismaClient,
  generationId: string,
  error: string,
): Promise<void> {
  await prisma.aiGeneration.update({
    where: { id: generationId },
    data: { status: "failed", error, completedAt: new Date() },
  });
}
