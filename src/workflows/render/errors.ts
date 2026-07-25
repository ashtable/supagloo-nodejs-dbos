import {
  isPermanentProviderFailure,
} from "../../providers/errors";
import { GitCommandError } from "../scaffold-project/git";

/**
 * Typed render failures + the DBOS `shouldRetry` classification for `renderWorkflow`.
 *
 * Same rule as the rest of the codebase (`scaffold-project/retry.ts`,
 * `providers/errors.ts`): typed PERMANENT failures fail fast; anything we cannot
 * positively identify stays transient, so we never mark something permanent by accident.
 *
 * CANCELLATION IS ITS OWN AXIS. A cancelled render is neither a permanent failure nor a
 * retryable one: retrying it is pointless, and recording it as `failed` would be wrong —
 * the RenderJob status for it is `canceled`. So the workflow's catch checks
 * {@link isRenderCancellation} BEFORE {@link isPermanentRenderFailure}.
 */

/** The RenderJob row is missing or malformed — retrying cannot fix a bad row. */
export class RenderRequestInvalidError extends Error {
  readonly code = "RENDER_REQUEST_INVALID" as const;
  constructor(message: string) {
    super(`render request invalid: ${message}`);
    this.name = "RenderRequestInvalidError";
  }
}

/**
 * The render was cancelled — either cooperatively (our status poller saw the workflow
 * flip to CANCELLED and aborted the in-flight Chromium render) or because DBOS preempted
 * at a step boundary.
 */
export class RenderCanceledError extends Error {
  readonly code = "RENDER_CANCELED" as const;
  constructor(renderJobId: string) {
    super(`render ${renderJobId} was canceled`);
    this.name = "RenderCanceledError";
  }
}

/**
 * A scrubbed-env child process (npm install / bundle / render / still) exited non-zero or
 * blew its deadline. `permanent` is set only when the failure is attributable to the
 * user's own code/config (e.g. the composition throws, the entry point is missing) — an
 * OOM or a killed Chromium is transient and worth another attempt.
 */
export class RenderChildFailedError extends Error {
  readonly code = "RENDER_CHILD_FAILED" as const;
  readonly permanent: boolean;
  constructor(
    readonly command: string,
    readonly exitCode: number | null,
    detail: string,
    permanent = false,
  ) {
    super(`render child \`${command}\` failed (exit ${exitCode ?? "signal"}): ${detail}`);
    this.name = "RenderChildFailedError";
    this.permanent = permanent;
  }
}

/**
 * DBOS's numeric error codes for the two cancellation errors, verified against
 * `@dbos-inc/dbos-sdk@4.23.6`'s `error.js`: `DBOSWorkflowCancelledError` = 24
 * (`WorkFlowCancelled`) and `DBOSAwaitedWorkflowCancelledError` = 27
 * (`TargetWorkflowCancelled`).
 */
const CANCELLED_DBOS_ERROR_CODES = new Set([24, 27]);

/**
 * True when an error means "this render was cancelled".
 *
 * GOTCHA (cost an e2e failure): DBOS's `DBOSError` base class NEVER assigns `this.name`,
 * so a `DBOSWorkflowCancelledError` arrives with `name === "Error"` — matching on `name`
 * alone silently misses every real cancellation, and the RenderJob row is left stranded
 * mid-phase (`bundling`/`encoding`) instead of flipping to `canceled`. The reliable
 * identity is the numeric `dbosErrorCode`; the constructor name and `name` are kept as
 * secondary signals so a future SDK that does set `name` still matches.
 *
 * Matched structurally rather than with `instanceof` so this module stays free of an
 * `@dbos-inc/dbos-sdk` import (which the workflow's unit tests mock).
 */
export function isRenderCancellation(e: unknown): boolean {
  if (e instanceof RenderCanceledError) return true;
  if (!e || typeof e !== "object") return false;
  const err = e as {
    name?: unknown;
    dbosErrorCode?: unknown;
    constructor?: { name?: unknown };
  };
  if (
    typeof err.dbosErrorCode === "number" &&
    CANCELLED_DBOS_ERROR_CODES.has(err.dbosErrorCode)
  ) {
    return true;
  }
  const ctorName = err.constructor?.name;
  if (typeof ctorName === "string" && /cancell?ed/i.test(ctorName)) return true;
  return typeof err.name === "string" && /cancell?ed/i.test(err.name);
}

/** True when a render failure is PERMANENT (fail fast rather than burn the retry budget). */
export function isPermanentRenderFailure(e: unknown): boolean {
  // A cancellation is a different axis entirely — never "permanent failure".
  if (isRenderCancellation(e)) return false;
  if (e instanceof RenderRequestInvalidError) return true;
  if (e instanceof RenderChildFailedError) return e.permanent;
  if (e instanceof GitCommandError) return e.permanent;
  // Missing provider connection / permanent 4xx from the audio-synthesis fallback.
  return isPermanentProviderFailure(e);
}

/** DBOS `shouldRetry`: retry everything except typed permanent failures and cancellations. */
export function retryUnlessPermanentRender(e: unknown): boolean {
  if (isRenderCancellation(e)) return false;
  return !isPermanentRenderFailure(e);
}

/**
 * Retry policy for the render workflow's network/git/npm/S3 steps. Modest attempt count
 * with exponential backoff — these steps are minutes long, so an aggressive retry budget
 * would multiply an already-slow failure.
 *
 * Deliberately NOT used for `renderMedia`: an hour-long encode that failed (Chromium OOM,
 * ffmpeg error) should not silently burn three more hours. DBOS workflow RECOVERY is the
 * retry mechanism there, under an operator's control.
 */
export const RENDER_NETWORK_RETRY = {
  retriesAllowed: true,
  maxAttempts: 3,
  intervalSeconds: 2,
  backoffRate: 2,
  shouldRetry: retryUnlessPermanentRender,
} as const;
