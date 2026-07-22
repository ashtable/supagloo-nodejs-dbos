import { GenerateImageInputSchema } from "@supagloo/database-lib";
import { GenerationRequestInvalidError } from "./errors";

/**
 * Pure validator for the image-generation request row (the loadRequestAndCredentials step
 * wraps it). An image generation MUST be `image`-kind, MUST be project-scoped (design §8
 * defines no project-less asset S3 layout — an image asset has nowhere to live without a
 * project) and MUST carry a `prompt` (the real `GenerateImageInputSchema`). Any violation is
 * a PERMANENT `GenerationRequestInvalidError` (the workflow marks the row `failed`, no retry).
 *
 * Returns the CHECKPOINT-SAFE request context (no secret) — the OpenRouter key is (re)loaded
 * INSIDE the provider-call step so it never lands in a DBOS checkpoint.
 */
export interface ImageRequestRow {
  userId: string;
  kind: string;
  provider: string;
  model: string;
  projectId: string | null;
  input: unknown;
}

export interface ImageRequest {
  userId: string;
  model: string;
  projectId: string;
  prompt: string;
}

export function parseImageRequest(row: ImageRequestRow): ImageRequest {
  if (row.kind !== "image") {
    throw new GenerationRequestInvalidError(
      `generateImage does not handle the "${row.kind}" kind`,
    );
  }
  if (!row.projectId) {
    throw new GenerationRequestInvalidError(
      "image generation requires a projectId (a generated image asset is stored under " +
        "projects/{projectId}/assets/…)",
    );
  }
  const parsed = GenerateImageInputSchema.safeParse(row.input);
  if (!parsed.success) {
    throw new GenerationRequestInvalidError(
      `image generation input failed validation: ${parsed.error.message}`,
    );
  }
  return {
    userId: row.userId,
    model: row.model,
    projectId: row.projectId,
    prompt: parsed.data.prompt,
  };
}
