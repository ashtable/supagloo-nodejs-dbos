import { Prisma, type PrismaClient } from "@supagloo/database-lib";

// Cast helper for Prisma Json columns (mirrors generate-script/finalize.ts): a plain object
// with a possibly-null property is a valid JSON value, but Prisma's InputJsonValue type is
// stricter about nulls, so we cast at the boundary.
const toJson = (v: unknown): Prisma.InputJsonValue => v as unknown as Prisma.InputJsonValue;

/**
 * The `AiGeneration` status/result writes for the audio workflow (design-delta §7 workflow 7).
 * This workflow ONLY touches the `AiGeneration` row — status lifecycle + `resultAssetKey`
 * (the S3 key of the uploaded mp3) + a small `resultJson` metadata blob holding the provider's
 * `X-Generation-Id` (decision D6: traceability without a new column). It NEVER writes
 * `ProjectVersion` or the manifest. All writes are idempotent (keyed by the generation id =
 * workflow id) so DBOS replay is safe. `providerJobId` is left null (no async-job pattern for
 * audio, unlike video).
 */

/** Flip queued → running at the start of the workflow. */
export async function markAudioGenerationRunning(
  prisma: PrismaClient,
  generationId: string,
): Promise<void> {
  await prisma.aiGeneration.update({
    where: { id: generationId },
    data: { status: "running" },
  });
}

/** Idempotent success upsert: status succeeded + resultAssetKey + resultJson metadata
 *  (the provider generation id + the audio kind) + completedAt. */
export async function persistAudioResult(
  prisma: PrismaClient,
  generationId: string,
  args: { assetKey: string; kind: "narration" | "music"; providerGenerationId: string | null },
): Promise<void> {
  await prisma.aiGeneration.update({
    where: { id: generationId },
    data: {
      status: "succeeded",
      resultAssetKey: args.assetKey,
      resultJson: toJson({
        kind: args.kind,
        providerGenerationId: args.providerGenerationId,
      }),
      completedAt: new Date(),
      error: null,
    },
  });
}

/** Idempotent failure write: status failed + the terminal error + completedAt. */
export async function markAudioGenerationFailed(
  prisma: PrismaClient,
  generationId: string,
  error: string,
): Promise<void> {
  await prisma.aiGeneration.update({
    where: { id: generationId },
    data: { status: "failed", error, completedAt: new Date() },
  });
}
