import {
  GenerateVideoInputSchema,
  type GenerateVideoInput,
} from "@supagloo/database-lib";
import { GenerationRequestInvalidError } from "./errors";

/**
 * Pure validator for the video-generation request row (the `loadRequestAndCredentials` step
 * wraps it). A video generation MUST be video-kind, MUST be openrouter (defense-in-depth on the
 * API's 422 matrix gate), and MUST be project-scoped (design §8 defines no project-less asset S3
 * layout — a video asset has nowhere to live without a project). The `input` is validated against
 * db-lib's `GenerateVideoInputSchema` (requires a prompt). Any violation is a PERMANENT
 * `GenerationRequestInvalidError` (the workflow marks the row `failed`, no retry).
 *
 * Returns the CHECKPOINT-SAFE request context (no secret) — the OpenRouter key is (re)loaded
 * INSIDE the provider-call steps so it never lands in a DBOS checkpoint.
 */
export interface VideoRequestRow {
  userId: string;
  kind: string;
  provider: string;
  model: string;
  projectId: string | null;
  input: unknown;
}

export interface VideoRequest {
  kind: "video";
  userId: string;
  model: string;
  projectId: string;
  input: GenerateVideoInput;
}

export function parseVideoRequest(row: VideoRequestRow): VideoRequest {
  if (row.kind !== "video") {
    throw new GenerationRequestInvalidError(
      `generateVideo does not handle the "${row.kind}" kind`,
    );
  }
  if (row.provider !== "openrouter") {
    // The API's kind→provider matrix rejects non-openrouter video rows with a 422 at creation
    // time, but the workflow must not silently trust that upstream guard (the provider-call
    // steps unconditionally load an OpenRouter credential).
    throw new GenerationRequestInvalidError(
      `generateVideoWorkflow only supports the openrouter provider, got: "${row.provider}"`,
    );
  }
  if (!row.projectId) {
    throw new GenerationRequestInvalidError(
      "video generation requires a projectId (a generated video asset is stored under " +
        "projects/{projectId}/assets/…)",
    );
  }
  const parsed = GenerateVideoInputSchema.safeParse(row.input);
  if (!parsed.success) {
    throw new GenerationRequestInvalidError(
      `video generation input failed validation: ${parsed.error.message}`,
    );
  }
  return {
    kind: "video",
    userId: row.userId,
    model: row.model,
    projectId: row.projectId,
    input: parsed.data,
  };
}
