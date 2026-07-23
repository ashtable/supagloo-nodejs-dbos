import { Prisma, type PrismaClient } from "@supagloo/database-lib";

// Cast helper for Prisma Json columns (mirrors generate-audio/finalize.ts): a plain object with a
// possibly-null property is a valid JSON value, but Prisma's InputJsonValue type is stricter about
// nulls, so we cast at the boundary.
const toJson = (v: unknown): Prisma.InputJsonValue => v as unknown as Prisma.InputJsonValue;

/**
 * The `AiGeneration` status/result writes for the video workflow (design-delta §7 workflow 8).
 * This workflow ONLY touches the `AiGeneration` row — status lifecycle + `providerJobId` (persisted
 * IMMEDIATELY post-submit for replay safety, design §2.8) + `resultAssetKey` (the S3 key of the
 * uploaded mp4) + a small `resultJson` metadata blob. It NEVER writes `ProjectVersion` or the
 * manifest. All writes are idempotent (keyed by the generation id = workflow id) so DBOS replay is
 * safe.
 */

/** Flip queued → running at the start of the workflow. */
export async function markVideoGenerationRunning(
  prisma: PrismaClient,
  generationId: string,
): Promise<void> {
  await prisma.aiGeneration.update({
    where: { id: generationId },
    data: { status: "running" },
  });
}

/** Persist the provider job id IMMEDIATELY after submit, in the SAME step as the submit call
 *  (design §2.8 / D1) — so a worker crash/replay resumes polling the existing job without
 *  re-submitting. */
export async function persistVideoProviderJobId(
  prisma: PrismaClient,
  generationId: string,
  providerJobId: string,
): Promise<void> {
  await prisma.aiGeneration.update({
    where: { id: generationId },
    data: { providerJobId },
  });
}

/** Idempotent success upsert: status succeeded + resultAssetKey + resultJson metadata
 *  (the video kind + the provider job id) + completedAt. */
export async function persistVideoResult(
  prisma: PrismaClient,
  generationId: string,
  args: { assetKey: string; providerJobId: string },
): Promise<void> {
  await prisma.aiGeneration.update({
    where: { id: generationId },
    data: {
      status: "succeeded",
      resultAssetKey: args.assetKey,
      resultJson: toJson({ kind: "video", providerJobId: args.providerJobId }),
      completedAt: new Date(),
      error: null,
    },
  });
}

/** Idempotent failure write: status failed + the terminal error + completedAt. */
export async function markVideoGenerationFailed(
  prisma: PrismaClient,
  generationId: string,
  error: string,
): Promise<void> {
  await prisma.aiGeneration.update({
    where: { id: generationId },
    data: { status: "failed", error, completedAt: new Date() },
  });
}
