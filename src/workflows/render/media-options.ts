/**
 * Plan row 45 (§9-Q8) — the `renderMedia` tuning knobs, as a pure function so the wiring
 * is testable without spawning Chromium.
 *
 * THERE ARE TWO DIFFERENT TIMEOUTS HERE, and conflating them is what row 45 originally
 * shipped (Step-11 item 9 / R45-1):
 *
 *   1. **The child-process KILL DEADLINE** (`RENDER_MEDIA_TIMEOUT_SECONDS`, 3600 s →
 *      `mediaTimeoutMs`). DBOS has no per-step timeout — only a workflow-level `timeoutMS` —
 *      so the design's "generous `renderMedia` step timeout" has always been realized as the
 *      deadline after which the parent SIGTERMs the render child. It doubles as the bound on
 *      the untrusted user code we execute.
 *   2. **Remotion's own per-frame budget** (`timeoutInMilliseconds` → `frameTimeoutMs`), the
 *      thing that turns ONE wedged frame into a clean, attributable Remotion error naming
 *      the frame, instead of an unexplained SIGTERM an hour later.
 *
 * The original tuning passed (1) as (2). That makes (2) DEAD BY CONSTRUCTION: Remotion's
 * clock starts only after browser launch and composition resolution, and `waitForReady` adds
 * a further +3 000 ms, so the parent's kill always wins and no Remotion timeout can ever
 * fire. The comment even said "any value BELOW it turns a slow frame into a clean error" —
 * correct, and not what the code did, because the shipped value *was* the deadline.
 *
 * Hence `RENDER_MEDIA_FRAME_TIMEOUT_MS` (default
 * {@link RENDER_MEDIA_FRAME_TIMEOUT_MS_DEFAULT}), and hence the THROW below when
 * `frameTimeoutMs >= mediaTimeoutMs`. A throw, not a clamp: quietly rewriting an operator's
 * number into one that happens to work is exactly how the original equality passed review
 * for a plausible-looking reason.
 *
 * WHY `concurrency` IS OPTIONAL AND UNSET BY DEFAULT. Remotion resolves an unset concurrency
 * to `round(min(8, max(1, cpus / 2)))` — verified in the pinned `@remotion/renderer@4.0.490`
 * at `dist/get-concurrency.js#resolveConcurrency(null)`, where `cpus` is
 * `min(os.availableParallelism(), nproc)`. Each unit is a Chromium tab holding decoded
 * frames, so it is the single biggest unbounded memory lever in the pipeline and the reason a
 * container with a modest memory limit OOMs on a render that succeeds on a developer laptop.
 * Two reasons it is nonetheless left UNSET (Step-11 item 31 / R45-5 corrects the first
 * statement and adds the second):
 *
 *   • api and dbos are not deployed to Railway (current-design §6), so any recommended
 *     number is extrapolated from Compose, and shipping a guess as the default would change
 *     every render's behaviour on the strength of a measurement we have not made; and
 *   • Remotion's own default is already **bounded** (the min-8 cap) and **cpuset-aware**
 *     (`os.availableParallelism()`, further floored by `nproc`), so it is a better default
 *     than a hardcoded number would be. Only a CFS *quota* (`--cpus=1.5`) escapes it.
 *
 * `resolveConcurrency` also **THROWS** `Maximum for --concurrency is <n> (number of cores on
 * this system)` for any value above that count. That throw lands at the LAST step of the
 * workflow, after the clone, the `npm ci` and the bundle — so an over-large
 * `RENDER_MEDIA_CONCURRENCY` wastes an entire render before failing. `src/config/env.ts`
 * therefore range-checks the knob at BOOT instead; see the schema comment there.
 *
 * NOT CHANGED: `renderMedia`'s step remains `{ retriesAllowed: false }` (deliberate — a
 * half-written encode must not be retried blindly), and `QUEUE_CONFIG.render.workerConcurrency`
 * remains 1 (firm since task 36; row 45 CONFIRMS it rather than tuning it).
 */

/**
 * `RENDER_MEDIA_FRAME_TIMEOUT_MS`'s default: 120 000 ms — `docs/render-sizing.md` §3.4's own
 * recommendation.
 *
 * Two constraints bracket it. Remotion's built-in default is `DEFAULT_TIMEOUT = 30_000`
 * (pinned `@remotion/renderer@4.0.490`, `dist/browser/TimeoutSettings.js`), so 120 000 is
 * generous by 4× against the library's own idea of a stuck frame and will not turn a
 * slow-but-healthy frame into a failure. At the other end it is 30× below the 3 600 000 ms
 * kill deadline, so a genuinely wedged frame is reported BY REMOTION, with the frame number,
 * long before the SIGTERM that would otherwise be the only symptom.
 */
export const RENDER_MEDIA_FRAME_TIMEOUT_MS_DEFAULT = 120_000;

/**
 * The largest `concurrency` Remotion will accept on THIS machine — the same bound
 * `resolveConcurrency` throws against (`RenderInternals.getMaxConcurrency()`, which is
 * `getCpuCount() = min(os.availableParallelism(), nproc)`).
 *
 * Exists so `src/config/env.ts` can turn an over-large `RENDER_MEDIA_CONCURRENCY` into a
 * BOOT refusal (Step-11 item 31). Without it Remotion's throw lands at the last step of the
 * render workflow, after the clone, the `npm ci` and the bundle — minutes of work discarded,
 * every render, for a typo in one env var.
 *
 * `require`d LAZILY and only when the knob is actually set: `@remotion/renderer` pulls in the
 * compositor bindings, and `env.ts` is on the worker's critical boot path (and is loaded by
 * every e2e lane). The bound is asked for at most once per boot.
 */
export function maxRenderConcurrency(): number {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { RenderInternals } = require("@remotion/renderer") as typeof import("@remotion/renderer");
  return RenderInternals.getMaxConcurrency();
}

export interface RenderMediaTuning {
  /** The child-process kill deadline, in ms — see `render/config.ts`. */
  mediaTimeoutMs: number;
  /**
   * Remotion's per-frame budget, in ms (`RENDER_MEDIA_FRAME_TIMEOUT_MS`). MUST be strictly
   * below {@link RenderMediaTuning.mediaTimeoutMs}, or it can never fire.
   */
  frameTimeoutMs: number;
  /** `RENDER_MEDIA_CONCURRENCY`; omitted ⇒ Remotion's own bounded default stands. */
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
  if (!Number.isFinite(tuning.frameTimeoutMs) || tuning.frameTimeoutMs <= 0) {
    throw new Error(
      `renderMedia tuning: frameTimeoutMs must be a positive number of milliseconds, got ${String(
        tuning.frameTimeoutMs,
      )}`,
    );
  }
  if (tuning.frameTimeoutMs >= tuning.mediaTimeoutMs) {
    // The shipped defect, now unrepresentable rather than discouraged by a comment the code
    // contradicted.
    throw new Error(
      `renderMedia tuning: frameTimeoutMs (${tuning.frameTimeoutMs} ms) must be strictly below ` +
        `the child kill deadline mediaTimeoutMs (${tuning.mediaTimeoutMs} ms), or Remotion's ` +
        `per-frame timeout can never fire — the child is SIGTERMed first. Lower ` +
        `RENDER_MEDIA_FRAME_TIMEOUT_MS or raise RENDER_MEDIA_TIMEOUT_SECONDS.`,
    );
  }
  const options: RenderMediaOptions = {
    timeoutInMilliseconds: tuning.frameTimeoutMs,
  };
  // The key is ADDED rather than assigned-undefined, so "we changed nothing" is literal
  // and Remotion's own default resolution is untouched.
  if (tuning.concurrency !== undefined) options.concurrency = tuning.concurrency;
  return options;
}
