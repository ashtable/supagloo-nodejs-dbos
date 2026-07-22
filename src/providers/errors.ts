import { APICallError, NoObjectGeneratedError } from "ai";

/**
 * Typed errors + the retry classification shared by every provider-call step. The
 * generation workflows (#30/#32/#33/#34) hand `retryUnlessPermanent` to
 * `DBOS.runStep`'s `shouldRetry` and spread one of the `*_RETRY` option constants —
 * mirroring `scaffold-project/retry.ts`. The rule: transient failures (5xx, 429,
 * network, and anything we can't positively identify) are retried with backoff;
 * typed permanent failures fail fast. Defaulting the unknown case to transient
 * guarantees we never mark something permanent by accident.
 */

/**
 * A non-success HTTP response from a direct-`fetch` provider call (Gloo token mint,
 * discovery, media client). Carries the status so callers can classify permanent vs
 * transient via {@link isPermanentHttpStatus}. (AI-SDK calls throw their own
 * `APICallError`, which {@link httpStatusOf} also understands.)
 */
export class ProviderHttpError extends Error {
  readonly status: number;
  readonly bodyText?: string;
  constructor(message: string, status: number, bodyText?: string) {
    super(message);
    this.name = "ProviderHttpError";
    this.status = status;
    this.bodyText = bodyText;
  }
}

/** The user has no OpenRouter connection — a missing connection won't heal on retry. */
export class OpenRouterNotConnectedError extends Error {
  readonly code = "OPENROUTER_NOT_CONNECTED" as const;
  constructor(userId: string) {
    super(`no OpenRouter connection for user ${userId}`);
    this.name = "OpenRouterNotConnectedError";
  }
}

/** The user has no Gloo connection — a missing connection won't heal on retry. */
export class GlooNotConnectedError extends Error {
  readonly code = "GLOO_NOT_CONNECTED" as const;
  constructor(userId: string) {
    super(`no Gloo connection for user ${userId}`);
    this.name = "GlooNotConnectedError";
  }
}

/**
 * A permanent HTTP failure: a 4xx that is NOT 429. 4xx (bad credential, forbidden,
 * unprocessable) will not change on retry, so we fail fast; 429 (rate-limit) and 5xx
 * (server error) are transient and get retried with backoff.
 */
export function isPermanentHttpStatus(status: number): boolean {
  return status >= 400 && status < 500 && status !== 429;
}

/** Extract an HTTP status from our own error or an AI-SDK `APICallError`. */
export function httpStatusOf(e: unknown): number | undefined {
  if (e instanceof ProviderHttpError) return e.status;
  if (APICallError.isInstance(e) && typeof e.statusCode === "number") {
    return e.statusCode;
  }
  const anyE = e as { statusCode?: unknown; status?: unknown } | null;
  if (typeof anyE?.statusCode === "number") return anyE.statusCode;
  if (typeof anyE?.status === "number") return anyE.status;
  return undefined;
}

/**
 * True if a provider-step error is PERMANENT (retrying can't fix it), so the step's
 * `shouldRetry` returns false and it fails fast:
 *   - a missing provider connection;
 *   - a schema-validation failure (`NoObjectGeneratedError`) — NON-retryable at the
 *     STEP level because the workflow's bounded repair loop (design §6d) owns
 *     re-prompting; the step must hand it back rather than burn the backoff budget;
 *   - a permanent 4xx (from our `ProviderHttpError` or the AI SDK's `APICallError`).
 * Everything else — 5xx, 429, network blips, unknown — stays transient.
 */
export function isPermanentProviderFailure(e: unknown): boolean {
  if (
    e instanceof OpenRouterNotConnectedError ||
    e instanceof GlooNotConnectedError
  ) {
    return true;
  }
  if (NoObjectGeneratedError.isInstance(e)) return true;
  const status = httpStatusOf(e);
  if (status !== undefined) return isPermanentHttpStatus(status);
  return false;
}

/** DBOS `shouldRetry`: retry everything EXCEPT typed permanent failures. */
export function retryUnlessPermanent(e: unknown): boolean {
  return !isPermanentProviderFailure(e);
}

/**
 * DBOS `runStep` retry options for the structured-text step (`callLlmStructured`).
 * `maxAttempts: 5` + exponential backoff is the design-mandated policy (design §6d /
 * task #30); `shouldRetry` fails fast on permanent 4xx and hands schema failures back
 * to the repair loop.
 */
export const LLM_STRUCTURED_RETRY = {
  retriesAllowed: true,
  maxAttempts: 5,
  intervalSeconds: 1,
  backoffRate: 2,
  shouldRetry: retryUnlessPermanent,
} as const;

/** DBOS `runStep` retry options for media calls (TTS/music/video submit + download). */
export const MEDIA_RETRY = {
  retriesAllowed: true,
  maxAttempts: 4,
  intervalSeconds: 1,
  backoffRate: 2,
  shouldRetry: retryUnlessPermanent,
} as const;

/** DBOS `runStep` retry options for discovery listing calls. */
export const DISCOVERY_RETRY = {
  retriesAllowed: true,
  maxAttempts: 3,
  intervalSeconds: 1,
  backoffRate: 2,
  shouldRetry: retryUnlessPermanent,
} as const;
