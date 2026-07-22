import { isPermanentProviderFailure } from "../../providers/errors";

/**
 * Terminal (permanent) failures specific to the generation workflow (design-delta §6d /
 * §7 workflow 5), plus the composed retry classifier the workflow's outer catch uses to
 * decide whether to mark the `AiGeneration` row `failed` (permanent) or let DBOS
 * retry/recover (transient). Mirrors `import-project/retry.ts` + the provider-layer
 * `isPermanentProviderFailure`: transient by default so nothing is marked permanent by
 * accident; only typed permanent failures fail fast.
 */

/** The requested translation is not in the app's licensed collection for the language. */
export class TranslationNotLicensedError extends Error {
  readonly code = "TRANSLATION_NOT_LICENSED" as const;
  constructor(readonly requested: string) {
    super(
      `translation "${requested}" is not licensed to this app for the requested language`,
    );
    this.name = "TranslationNotLicensedError";
  }
}

/** The bounded re-prompt loop exhausted its attempts without valid structured output. */
export class RepairExhaustedError extends Error {
  readonly code = "REPAIR_EXHAUSTED" as const;
  constructor(
    readonly attempts: number,
    readonly lastValidationErrors: string,
  ) {
    super(
      `structured generation failed schema validation after ${attempts} attempt(s); ` +
        `last errors: ${lastValidationErrors}`,
    );
    this.name = "RepairExhaustedError";
  }
}

/** The workflow was handed a kind it does not generate (media kinds → #32–34). */
export class UnsupportedGenerationKindError extends Error {
  readonly code = "UNSUPPORTED_GENERATION_KIND" as const;
  constructor(readonly kind: string) {
    super(`generateScript does not handle the "${kind}" kind`);
    this.name = "UnsupportedGenerationKindError";
  }
}

/** The `AiGeneration` row is missing or its `input` failed schema validation. */
export class GenerationRequestInvalidError extends Error {
  readonly code = "GENERATION_REQUEST_INVALID" as const;
  constructor(message: string) {
    super(message);
    this.name = "GenerationRequestInvalidError";
  }
}

/**
 * DBOS-recovery-safe permanence check for the workflow's outer catch: true ⇒ mark the
 * generation `failed` + re-throw; false ⇒ transient, let it propagate for retry/recovery
 * (crucially, a DBOS cancellation is NOT one of these typed errors, so it is left to
 * propagate — the crash/replay test relies on this).
 */
export function isPermanentGenerationFailure(e: unknown): boolean {
  if (
    e instanceof TranslationNotLicensedError ||
    e instanceof RepairExhaustedError ||
    e instanceof UnsupportedGenerationKindError ||
    e instanceof GenerationRequestInvalidError
  ) {
    return true;
  }
  return isPermanentProviderFailure(e);
}

/** DBOS `shouldRetry` for the generation steps: retry everything EXCEPT permanent failures. */
export function retryUnlessPermanentGeneration(e: unknown): boolean {
  return !isPermanentGenerationFailure(e);
}
