import { VideoJobFailedError, VideoJobTimedOutError } from "./errors";

/**
 * The bounded, durable-sleep polling state machine for the async video job (design-delta §7
 * workflow 8). Extracted PURE (no DBOS, no HTTP) so "terminal states + bounded attempts" is
 * unit-testable in isolation — the workflow supplies `DBOS.runStep(getVideoJob…)` as `poll`,
 * `DBOS.sleep` as `sleep`, and its boundary hook as `onBeforePoll`. The tested logic IS the
 * production logic.
 *
 * DETERMINISM: the sequence of DBOS operations this drives is `[poll, sleep, poll, sleep, …,
 * poll]`, fully determined by the checkpointed poll-step results — so on replay the loop takes
 * identical branches (a completed durable sleep replays instantly; a completed poll step replays
 * its saved status). `DBOS.sleep` is durable and takes MILLISECONDS.
 */

/** Design D4 judgment call (the design pins no exact bound): a ~30s interval and a 40-attempt
 *  ceiling ⇒ ~20 minutes — generous headroom over the p99 generation time for short clips while
 *  bounding a stuck job. Both are env-overridable (`VIDEO_POLL_INTERVAL_SECONDS`,
 *  `VIDEO_MAX_POLL_ATTEMPTS`) — see config.ts / config/env.ts. */
export const DEFAULT_VIDEO_POLL_INTERVAL_SECONDS = 30;
export const DEFAULT_VIDEO_MAX_POLL_ATTEMPTS = 40;

export type VideoPollOutcome =
  | { kind: "completed" }
  | { kind: "failed"; status: string }
  | { kind: "pending" };

const FAILED_STATUSES = new Set(["failed", "error", "cancelled", "canceled"]);

/**
 * Map a provider job status string to a terminal/non-terminal outcome. `completed`/`succeeded`
 * ⇒ done; `failed`/`error`/`cancelled` ⇒ fail fast (no wasted polls); everything else —
 * `pending`/`in_progress`/`queued`/`processing` and any UNRECOGNIZED status — ⇒ keep polling
 * (bounded by maxAttempts). Never fail on an unknown-but-possibly-transitional status.
 */
export function classifyVideoStatus(status: string): VideoPollOutcome {
  const s = status.toLowerCase();
  if (s === "completed" || s === "succeeded") return { kind: "completed" };
  if (FAILED_STATUSES.has(s)) return { kind: "failed", status };
  return { kind: "pending" };
}

export interface PollLoopDeps {
  /** One poll: hit the provider (as a DBOS step in production) and return the raw status. */
  poll: () => Promise<string>;
  /** Durable sleep in MILLISECONDS (`DBOS.sleep` in production). */
  sleep: (ms: number) => Promise<void>;
  /** Awaited before every poll — the workflow's boundary hook (no-op in prod; the crash/replay
   *  test parks here). */
  onBeforePoll?: () => Promise<void> | void;
  intervalMs: number;
  maxAttempts: number;
  /** The provider job id, for the terminal error messages. */
  jobId?: string;
}

/**
 * Poll until the job reaches a terminal state, sleeping `intervalMs` BETWEEN polls (never after
 * the completing/failing poll). Resolves `{ attempts }` on completion; throws
 * {@link VideoJobFailedError} on a provider-reported failure and {@link VideoJobTimedOutError}
 * once `maxAttempts` non-terminal polls have elapsed.
 */
export async function pollUntilComplete(
  deps: PollLoopDeps,
): Promise<{ attempts: number }> {
  for (let attempt = 1; attempt <= deps.maxAttempts; attempt++) {
    if (deps.onBeforePoll) await deps.onBeforePoll();
    const status = await deps.poll();
    const outcome = classifyVideoStatus(status);
    if (outcome.kind === "completed") return { attempts: attempt };
    if (outcome.kind === "failed") {
      throw new VideoJobFailedError(deps.jobId ?? "unknown", outcome.status);
    }
    // Non-terminal: sleep before the NEXT poll (but not after the final allowed attempt).
    if (attempt < deps.maxAttempts) await deps.sleep(deps.intervalMs);
  }
  throw new VideoJobTimedOutError(deps.jobId ?? "unknown", deps.maxAttempts);
}
