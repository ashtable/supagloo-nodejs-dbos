import { isPermanentProviderFailure } from "../../providers/errors";

/**
 * Terminal (permanent) failures specific to the audio-generation workflow (design-delta §7
 * workflow 7 — narration TTS + music), plus the composed retry classifier the workflow's
 * outer catch uses to decide whether to mark the `AiGeneration` row `failed` (permanent) or
 * let DBOS retry/recover (transient). Like generateImage (and unlike generateScript) there is
 * NO repair loop — audio output is opaque bytes, not schema-validated JSON — so the only
 * workflow-specific terminal error is a bad request row. Everything else defers to the
 * provider-layer classifier (permanent 4xx / not-connected fail fast; 5xx / 429 / unknown are
 * transient). A DBOS cancellation is NOT one of these typed errors, so it propagates.
 */

/** The `AiGeneration` row is missing, the wrong kind, has no project (an audio asset has
 *  nowhere to live), or its `input` failed the kind's synthesis-input schema. */
export class GenerationRequestInvalidError extends Error {
  readonly code = "GENERATION_REQUEST_INVALID" as const;
  constructor(message: string) {
    super(message);
    this.name = "GenerationRequestInvalidError";
  }
}

/** True ⇒ mark the generation `failed` + re-throw; false ⇒ transient, let it propagate for
 *  DBOS retry/recovery (cancellation is NOT typed permanent, so it propagates too). */
export function isPermanentGenerationFailure(e: unknown): boolean {
  if (e instanceof GenerationRequestInvalidError) return true;
  return isPermanentProviderFailure(e);
}

/** DBOS `shouldRetry` for the audio-generation steps: retry everything EXCEPT permanent. */
export function retryUnlessPermanentGeneration(e: unknown): boolean {
  return !isPermanentGenerationFailure(e);
}
