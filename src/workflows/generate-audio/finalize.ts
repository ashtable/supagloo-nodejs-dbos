import {
  Prisma,
  type NarrationResult,
  type PrismaClient,
} from "@supagloo/database-lib";

// Cast helper for Prisma Json columns (mirrors generate-script/finalize.ts): a plain object
// with a possibly-null property is a valid JSON value, but Prisma's InputJsonValue type is
// stricter about nulls, so we cast at the boundary.
const toJson = (v: unknown): Prisma.InputJsonValue => v as unknown as Prisma.InputJsonValue;

/**
 * The `AiGeneration` status/result writes for the audio workflow (design-delta §7 workflow 7).
 * This workflow ONLY touches the `AiGeneration` row — status lifecycle + `resultAssetKey`
 * (the S3 key of the uploaded WAV audio) + a small `resultJson` metadata blob holding the
 * provider generation id (parsed from the SSE `delta.audio.id` field — decision D6: traceability
 * without a new column). It NEVER writes
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

/**
 * Idempotent success upsert: status succeeded + resultAssetKey + resultJson metadata
 * (the provider generation id, the audio kind, and — for narration — the per-scene map)
 * + completedAt.
 *
 * `resultAssetKey` remains exactly ONE key, preserving the row invariant. Narration now
 * produces one clip per scene, and those extra keys ride in `resultJson.narration` (see
 * db-lib `NarrationResultSchema`); `resultAssetKey` names the first scene's clip so every
 * existing consumer of the column keeps working unchanged. `resultJson` was already the
 * agreed home for audio metadata (decision D6), so this is that seam widening, not a new one.
 *
 * For music, `durationSeconds` is the MEASURED length of the returned bed — the number the
 * composition needs in order to loop it far enough to cover the video.
 */
export async function persistAudioResult(
  prisma: PrismaClient,
  generationId: string,
  args: {
    assetKey: string;
    kind: "narration" | "music";
    providerGenerationId: string | null;
    /** Per-scene narration clips (narration only). */
    narration?: NarrationResult;
    /** Measured length of the synthesized track (music only). */
    durationSeconds?: number | null;
  },
): Promise<void> {
  await prisma.aiGeneration.update({
    where: { id: generationId },
    data: {
      status: "succeeded",
      resultAssetKey: args.assetKey,
      resultJson: toJson({
        kind: args.kind,
        providerGenerationId: args.providerGenerationId,
        ...(args.narration ? { narration: args.narration } : {}),
        ...(typeof args.durationSeconds === "number"
          ? { durationSeconds: args.durationSeconds }
          : {}),
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
