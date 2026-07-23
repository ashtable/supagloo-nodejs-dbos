import { isPermanentProviderFailure } from "../../providers/errors";

/**
 * Terminal (permanent) failures specific to the video-generation workflow (design-delta §7
 * workflow 8), plus the composed retry classifier the workflow's outer catch uses to decide
 * whether to mark the `AiGeneration` row `failed` (permanent) or let DBOS retry/recover
 * (transient). There are THREE workflow-specific permanent errors: a bad request row, a
 * provider-reported terminal FAILED job status, and an exhausted poll budget. Everything else
 * defers to the provider-layer classifier (permanent 4xx / not-connected fail fast; 5xx / 429 /
 * unknown are transient). A DBOS cancellation is NOT one of these typed errors, so it propagates.
 */

/** The `AiGeneration` row is missing, the wrong kind, not openrouter, has no project (a video
 *  asset has nowhere to live), or its `input` failed `GenerateVideoInputSchema`. */
export class GenerationRequestInvalidError extends Error {
  readonly code = "GENERATION_REQUEST_INVALID" as const;
  constructor(message: string) {
    super(message);
    this.name = "GenerationRequestInvalidError";
  }
}

/** The provider reported a TERMINAL failed status (`failed`/`error`/`cancelled`) for the video
 *  job. Retrying the workflow cannot heal a job the provider already failed — permanent. */
export class VideoJobFailedError extends Error {
  readonly code = "VIDEO_JOB_FAILED" as const;
  readonly status: string;
  constructor(jobId: string, status: string) {
    super(`video job ${jobId} reported terminal status "${status}"`);
    this.name = "VideoJobFailedError";
    this.status = status;
  }
}

/** The bounded poll budget (design D4) was exhausted before the job completed — we've decided
 *  to give up. Permanent (the row is marked failed; a human/caller can trigger a fresh run). */
export class VideoJobTimedOutError extends Error {
  readonly code = "VIDEO_JOB_TIMED_OUT" as const;
  readonly attempts: number;
  constructor(jobId: string, attempts: number) {
    super(`video job ${jobId} did not complete within ${attempts} poll attempts`);
    this.name = "VideoJobTimedOutError";
    this.attempts = attempts;
  }
}

/** True ⇒ mark the generation `failed` + re-throw; false ⇒ transient, let it propagate for
 *  DBOS retry/recovery (cancellation is NOT typed permanent, so it propagates too). */
export function isPermanentGenerationFailure(e: unknown): boolean {
  if (
    e instanceof GenerationRequestInvalidError ||
    e instanceof VideoJobFailedError ||
    e instanceof VideoJobTimedOutError
  ) {
    return true;
  }
  return isPermanentProviderFailure(e);
}

/** DBOS `shouldRetry` for the video-generation steps: retry everything EXCEPT permanent. */
export function retryUnlessPermanentGeneration(e: unknown): boolean {
  return !isPermanentGenerationFailure(e);
}
