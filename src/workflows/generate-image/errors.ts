import { isPermanentProviderFailure } from "../../providers/errors";

/**
 * Terminal (permanent) failures specific to the image-generation workflow (design-delta §7
 * workflow 6), plus the composed retry classifier the workflow's outer catch uses to decide
 * whether to mark the `AiGeneration` row `failed` (permanent) or let DBOS retry/recover
 * (transient). Unlike generateScript there is NO repair loop (image output is opaque bytes,
 * not schema-validated JSON) — the only workflow-specific terminal error is a bad request
 * row. Everything else defers to the provider-layer classifier (permanent 4xx / not-connected
 * fail fast; 5xx / 429 / unknown are transient). A DBOS cancellation is NOT one of these typed
 * errors, so it propagates.
 */

/** The `AiGeneration` row is missing, the wrong kind, has no project (an image asset has
 *  nowhere to live), or its `input` failed `GenerateImageInputSchema`. */
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

/** DBOS `shouldRetry` for the image-generation steps: retry everything EXCEPT permanent. */
export function retryUnlessPermanentGeneration(e: unknown): boolean {
  return !isPermanentGenerationFailure(e);
}
