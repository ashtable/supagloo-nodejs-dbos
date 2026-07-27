/**
 * Process-scoped render configuration, injected once at launch (`runtime.ts` →
 * `setRenderConfig`) from the validated env — the same singleton discipline as
 * `providers/config.ts`, `files/s3-config.ts`, and `generate-video/config.ts`. The
 * workflow's steps read `getRenderConfig()`, never `process.env`, so the values are
 * stable across a replay and the steps stay unit-testable.
 *
 * The three `*TimeoutMs` values are CHILD-PROCESS kill deadlines: DBOS has no per-step
 * timeout (only a workflow-level `timeoutMS`), so the design's "generous step timeout" for
 * `renderMedia` is expressed as the deadline after which the render child is killed — which
 * doubles as the bound on the untrusted user code we execute. `mediaFrameTimeoutMs` is a
 * different kind of thing entirely: Remotion's per-FRAME budget, which must sit strictly
 * below the kill deadline to be reachable at all (Step-11 item 9).
 */
export interface RenderConfig {
  /** Deadline for the `renderMedia` child (design's "generous step timeout"). */
  mediaTimeoutMs: number;
  /**
   * Plan row 45 / Step-11 item 9 — `RENDER_MEDIA_FRAME_TIMEOUT_MS`. Remotion's OWN per-frame
   * budget, a DIFFERENT quantity from `mediaTimeoutMs` above and necessarily strictly below
   * it: the child cannot outlive its kill deadline, so a per-frame budget equal to the
   * deadline (which is what row 45 first shipped) can never fire. See
   * `render/media-options.ts`, which enforces the inequality.
   */
  mediaFrameTimeoutMs: number;
  /** Deadline for the `bundleComposition` (and thumbnail) child. */
  bundleTimeoutMs: number;
  /** Deadline for the `npm ci --ignore-scripts` child. */
  installTimeoutMs: number;
  /** How often the long steps poll their own DBOS status for a cooperative cancel. */
  cancelPollMs: number;
  /**
   * Plan row 45 (§9-Q8) — `RENDER_MEDIA_CONCURRENCY`. Remotion's own frame concurrency (one
   * Chromium tab each), which it resolves when unset to `round(min(8, max(1, cpus / 2)))`
   * with `cpus = min(os.availableParallelism(), nproc)` — NOT to the core count, as this
   * comment claimed before Step-11 item 31 corrected it. UNDEFINED means "leave Remotion's
   * default alone", and that default is a good one: bounded by the min-8 cap and cpuset-aware.
   * api and dbos are not deployed to Railway, so any recommended number would be extrapolated
   * from Compose and must be an operator decision rather than a shipped guess. Distinct from
   * `QUEUE_CONFIG.render.workerConcurrency`, which is 1 and firm — that is how many RENDERS
   * share a worker, this is how many FRAMES share a render.
   */
  mediaConcurrency?: number;
  /** Fallback narration model; undefined ⇒ render-time narration synthesis is disabled. */
  narrationModel?: string;
  /** Fallback music model; undefined ⇒ render-time music synthesis is disabled. */
  musicModel?: string;
}

let config: RenderConfig | undefined;

export function setRenderConfig(next: RenderConfig): void {
  config = next;
}

export function getRenderConfig(): RenderConfig {
  if (!config) {
    throw new Error(
      "render config not initialized — launchDbos() must run setRenderConfig() before " +
        "renderWorkflow executes",
    );
  }
  return config;
}

export function clearRenderConfig(): void {
  config = undefined;
}
