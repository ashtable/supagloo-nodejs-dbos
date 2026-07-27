/**
 * Plan row 45 (§9-Q8) — the `renderMedia` tuning knobs, as a pure function so the wiring
 * is testable without spawning Chromium.
 *
 * WHICH TIMEOUT WAS TUNED, stated plainly because §9-Q8 is easy to over-claim. DBOS has
 * NO per-step timeout (only workflow-level `timeoutMS`), so the design's "generous
 * `renderMedia` step timeout" has always been realized as the child-process KILL DEADLINE
 * `RENDER_MEDIA_TIMEOUT_SECONDS` (3600 s). What was missing is Remotion's OWN
 * `timeoutInMilliseconds` — the per-frame budget — which was never passed at all. Without
 * it a single wedged frame is invisible until the outer deadline kills the whole child an
 * hour later with no attribution. Passing the same number is deliberate: the child may not
 * outlive its kill deadline, so there is no useful value ABOVE it, and any value below it
 * turns a slow frame into a clean, attributable Remotion error instead of a SIGTERM.
 *
 * WHY `concurrency` IS OPTIONAL AND UNSET BY DEFAULT. Remotion defaults it to the machine's
 * CPU count; each unit is a Chromium tab holding decoded frames, so it is the single
 * biggest unbounded memory lever in the pipeline and the reason a container with a modest
 * memory limit OOMs on a render that succeeds on a developer laptop. It is nonetheless
 * left UNSET by default: api and dbos are not deployed to Railway (current-design §6), so
 * any recommended number is extrapolated from Compose, and shipping a guess as the default
 * would change every render's behaviour on the strength of a measurement we have not made.
 * `RENDER_MEDIA_CONCURRENCY` makes it an operator decision, and the load harness's numbers
 * are what should eventually justify a default.
 *
 * NOT CHANGED: `renderMedia`'s step remains `{ retriesAllowed: false }` (deliberate — a
 * half-written encode must not be retried blindly), and `QUEUE_CONFIG.render.workerConcurrency`
 * remains 1 (firm since task 36; row 45 CONFIRMS it rather than tuning it).
 */

export interface RenderMediaTuning {
  /** The child-process kill deadline, in ms — see `render/config.ts`. */
  mediaTimeoutMs: number;
  /** `RENDER_MEDIA_CONCURRENCY`; omitted ⇒ Remotion's CPU-count default stands. */
  concurrency?: number;
}

export interface RenderMediaOptions {
  timeoutInMilliseconds: number;
  concurrency?: number;
}

export function buildRenderMediaOptions(tuning: RenderMediaTuning): RenderMediaOptions {
  if (!Number.isFinite(tuning.mediaTimeoutMs) || tuning.mediaTimeoutMs <= 0) {
    throw new Error(
      `renderMedia tuning: mediaTimeoutMs must be a positive number of milliseconds, got ${String(
        tuning.mediaTimeoutMs,
      )}`,
    );
  }
  const options: RenderMediaOptions = {
    timeoutInMilliseconds: tuning.mediaTimeoutMs,
  };
  // The key is ADDED rather than assigned-undefined, so "we changed nothing" is literal
  // and Remotion's own default resolution is untouched.
  if (tuning.concurrency !== undefined) options.concurrency = tuning.concurrency;
  return options;
}
