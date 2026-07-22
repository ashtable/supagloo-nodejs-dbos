import {
  GenerateMusicInputSchema,
  GenerateNarrationInputSchema,
  type GenerateMusicInput,
  type GenerateNarrationInput,
} from "@supagloo/database-lib";
import { GenerationRequestInvalidError } from "./errors";

/**
 * Pure validator + dispatcher for the audio-generation request row (the
 * `loadRequestAndCredentials` step wraps it). ONE workflow covers BOTH audio kinds
 * (`narration` TTS + `music`), so this parses the row's `kind` and validates its `input`
 * against the matching db-lib synthesis schema — the generateScript schema-by-kind
 * precedent. An audio generation MUST be `narration`/`music`-kind, MUST be openrouter
 * (defense-in-depth on the API's 422 matrix gate), and MUST be project-scoped (design §8
 * defines no project-less asset S3 layout — an audio asset has nowhere to live without a
 * project). Any violation is a PERMANENT `GenerationRequestInvalidError` (the workflow marks
 * the row `failed`, no retry).
 *
 * Returns the CHECKPOINT-SAFE, discriminated request context (no secret) — the OpenRouter
 * key is (re)loaded INSIDE the provider-call step so it never lands in a DBOS checkpoint.
 */
export interface AudioRequestRow {
  userId: string;
  kind: string;
  provider: string;
  model: string;
  projectId: string | null;
  input: unknown;
}

export type AudioRequest =
  | {
      kind: "narration";
      userId: string;
      model: string;
      projectId: string;
      input: GenerateNarrationInput;
    }
  | {
      kind: "music";
      userId: string;
      model: string;
      projectId: string;
      input: GenerateMusicInput;
    };

export function parseAudioRequest(row: AudioRequestRow): AudioRequest {
  if (row.kind !== "narration" && row.kind !== "music") {
    throw new GenerationRequestInvalidError(
      `generateAudio does not handle the "${row.kind}" kind`,
    );
  }
  if (row.provider !== "openrouter") {
    // Defense-in-depth on the workflow's own invariant: the provider-call step
    // unconditionally loads an OpenRouter credential. The API's kind→provider matrix
    // rejects non-openrouter audio rows with a 422 at creation time, but the workflow
    // must not silently trust that upstream guard.
    throw new GenerationRequestInvalidError(
      `generateAudioWorkflow only supports the openrouter provider, got: "${row.provider}"`,
    );
  }
  if (!row.projectId) {
    throw new GenerationRequestInvalidError(
      "audio generation requires a projectId (a generated audio asset is stored under " +
        "projects/{projectId}/assets/…)",
    );
  }

  if (row.kind === "narration") {
    const parsed = GenerateNarrationInputSchema.safeParse(row.input);
    if (!parsed.success) {
      throw new GenerationRequestInvalidError(
        `narration generation input failed validation: ${parsed.error.message}`,
      );
    }
    return {
      kind: "narration",
      userId: row.userId,
      model: row.model,
      projectId: row.projectId,
      input: parsed.data,
    };
  }

  const parsed = GenerateMusicInputSchema.safeParse(row.input);
  if (!parsed.success) {
    throw new GenerationRequestInvalidError(
      `music generation input failed validation: ${parsed.error.message}`,
    );
  }
  return {
    kind: "music",
    userId: row.userId,
    model: row.model,
    projectId: row.projectId,
    input: parsed.data,
  };
}
