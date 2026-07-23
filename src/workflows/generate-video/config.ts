/**
 * Process-scoped polling configuration for the generateVideo workflow, injected at launch
 * (`runtime.ts` → `setVideoPollConfig`) from the validated env — the same singleton discipline as
 * `providers/config.ts`, `files/s3-config.ts`, and `scaffold-project/config.ts`. The workflow
 * reads it via {@link getVideoPollConfig} so the durable-sleep loop never touches `process.env`.
 *
 * `pollIntervalMs` is the durable ~30s sleep between polls (dropped to a tiny value in the e2e for
 * speed); `maxPollAttempts` is the bounded-loop ceiling (design D4). Both are constant for the
 * lifetime of the worker, so reading them in the workflow body is deterministic across replay.
 */
export interface VideoPollConfig {
  /** Durable sleep between poll attempts, in MILLISECONDS (`DBOS.sleep` takes ms). */
  pollIntervalMs: number;
  /** Bounded-loop ceiling: give up (VideoJobTimedOutError) after this many non-terminal polls. */
  maxPollAttempts: number;
}

let config: VideoPollConfig | undefined;

export function setVideoPollConfig(next: VideoPollConfig): void {
  config = next;
}

export function getVideoPollConfig(): VideoPollConfig {
  if (!config) {
    throw new Error(
      "video poll config not initialized — launchDbos() must run setVideoPollConfig() before " +
        "the generateVideo workflow executes",
    );
  }
  return config;
}

export function clearVideoPollConfig(): void {
  config = undefined;
}
