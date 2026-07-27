import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  buildRenderMediaOptions,
  RENDER_MEDIA_FRAME_TIMEOUT_MS_DEFAULT,
} from "./media-options";

/**
 * Plan row 45 (§9-Q8) — the two `renderMedia` knobs the design asked to be TUNED and that
 * were, until now, left at Remotion's defaults.
 *
 * WHAT §9-Q8 ACTUALLY ASKS FOR, and what was already true (brief §4.2):
 *   • "concurrency 1 per worker" is ACCEPTED, not open: `QUEUE_CONFIG.render.workerConcurrency`
 *     has been 1 since task 36 and is flagged "firm". Row 45 CONFIRMS it (asserted in
 *     `registry.test.ts`) — that is a queue-level property and is not what this file is about.
 *   • "the `renderMedia` step must be configured with a generous timeout" was realized only
 *     as the child-process KILL DEADLINE (`RENDER_MEDIA_TIMEOUT_SECONDS`, 3600 s), because
 *     DBOS has no per-step timeout at all — only a workflow-level `timeoutMS`. Remotion's
 *     OWN `timeoutInMilliseconds` was never passed, so a single hung frame would sit until
 *     the outer kill deadline fired an hour later with no diagnostic.
 *   • Remotion's `concurrency` defaults to `round(min(8, max(1, cpus / 2)))` — see U-RMO7.
 *     Each unit is a Chromium tab holding decoded frames, so it is the single biggest
 *     unbounded memory lever in the pipeline, and the reason a container with a modest
 *     limit OOMs while the same render succeeds on a laptop.
 *
 * ── Step-11 item 9 (R45-1): the per-frame timeout was DEAD BY CONSTRUCTION ───────────────
 *
 * The original tuning passed `timeoutInMilliseconds = mediaTimeoutMs` — the SAME 3 600 000 ms
 * as the child's kill deadline — and this file's U-RMO1 asserted the equality, i.e. it
 * PINNED the defect. Remotion's clock starts only AFTER browser launch and composition
 * resolution and adds a further +3 000 ms on `waitForReady`, so the parent's SIGTERM always
 * wins the race and the Remotion timeout can never fire. The shipped comment claimed "any
 * value BELOW it turns a slow frame into a clean error" — which was true, and which the
 * shipped value was not: it *was* the deadline, not below it.
 *
 * So the per-frame budget is now its own knob (`RENDER_MEDIA_FRAME_TIMEOUT_MS`, default
 * {@link RENDER_MEDIA_FRAME_TIMEOUT_MS_DEFAULT} = 120 000 ms — `docs/render-sizing.md`
 * §3.4's own recommendation), and `buildRenderMediaOptions` THROWS when it is not strictly
 * below the kill deadline. A throw rather than a clamp: silently rewriting an operator's
 * number into one that works is how the equality survived review in the first place.
 * (Remotion's own default, verified in the pinned `@remotion/renderer@4.0.490` at
 * `dist/browser/TimeoutSettings.js`, is `DEFAULT_TIMEOUT = 30_000`; 120 000 is generous
 * against that and still 30× below the deadline.)
 */

/** `RENDER_MEDIA_TIMEOUT_SECONDS`'s default, in ms — the child-process kill deadline. */
const KILL_DEADLINE_MS = 3_600_000;

describe("buildRenderMediaOptions", () => {
  it("U-RMO1: the per-frame timeout is STRICTLY BELOW the child kill deadline, so it can fire", () => {
    const opts = buildRenderMediaOptions({
      mediaTimeoutMs: KILL_DEADLINE_MS,
      frameTimeoutMs: RENDER_MEDIA_FRAME_TIMEOUT_MS_DEFAULT,
    });
    // THE assertion of this row's actual value. Equality (what shipped) means the SIGTERM
    // always wins and the option is decorative.
    expect(opts.timeoutInMilliseconds).toBeLessThan(KILL_DEADLINE_MS);
    expect(opts.timeoutInMilliseconds).toBe(RENDER_MEDIA_FRAME_TIMEOUT_MS_DEFAULT);
  });

  it("U-RMO1b: the shipped default is 120 000 ms", () => {
    expect(RENDER_MEDIA_FRAME_TIMEOUT_MS_DEFAULT).toBe(120_000);
  });

  it("U-RMO2: omits `concurrency` entirely when unset — Remotion's default stands", () => {
    const opts = buildRenderMediaOptions({
      mediaTimeoutMs: KILL_DEADLINE_MS,
      frameTimeoutMs: RENDER_MEDIA_FRAME_TIMEOUT_MS_DEFAULT,
    });
    // `undefined` is not good enough: Remotion distinguishes an absent key from an
    // explicit undefined in some option paths, and "we changed nothing" must be literal.
    expect("concurrency" in opts).toBe(false);
  });

  it("U-RMO3: passes `concurrency` when the operator sets it", () => {
    const opts = buildRenderMediaOptions({
      mediaTimeoutMs: KILL_DEADLINE_MS,
      frameTimeoutMs: RENDER_MEDIA_FRAME_TIMEOUT_MS_DEFAULT,
      concurrency: 2,
    });
    expect(opts.concurrency).toBe(2);
  });

  it("U-RMO4: never emits a non-positive timeout", () => {
    // A zero/negative `timeoutInMilliseconds` would make Remotion fail every frame
    // instantly; the env schema rejects it, and this is the second line of defence.
    expect(() =>
      buildRenderMediaOptions({ mediaTimeoutMs: 0, frameTimeoutMs: 1 }),
    ).toThrow(/mediaTimeoutMs/);
    expect(() =>
      buildRenderMediaOptions({ mediaTimeoutMs: KILL_DEADLINE_MS, frameTimeoutMs: 0 }),
    ).toThrow(/frameTimeoutMs/);
  });

  it("U-RMO5: THROWS when the frame timeout EQUALS the kill deadline — the shipped defect", () => {
    // This is the exact configuration that shipped. It is now unrepresentable rather than
    // merely discouraged by a comment that the value itself contradicted.
    expect(() =>
      buildRenderMediaOptions({
        mediaTimeoutMs: KILL_DEADLINE_MS,
        frameTimeoutMs: KILL_DEADLINE_MS,
      }),
    ).toThrow(/frameTimeoutMs[\s\S]*strictly below/i);
  });

  it("U-RMO6: THROWS when the frame timeout exceeds the kill deadline", () => {
    expect(() =>
      buildRenderMediaOptions({
        mediaTimeoutMs: KILL_DEADLINE_MS,
        frameTimeoutMs: KILL_DEADLINE_MS + 1,
      }),
    ).toThrow(/frameTimeoutMs/);
  });

  /**
   * Step-11 item 31 (R45-5) — the three code comments about Remotion's default
   * `concurrency` all said "the machine's CPU count". Verified wrong against the pinned
   * `@remotion/renderer@4.0.490`: `dist/get-concurrency.js#resolveConcurrency(null)` returns
   * `Math.round(Math.min(8, Math.max(1, maxCpus / 2)))`. The number matters — on a 32-core
   * box the claim is off by 24 Chromium tabs, in the very comment that exists to explain the
   * memory lever. Asserted as SOURCE TEXT because a wrong comment cannot fail any other way.
   */
  it("U-RMO7: no source file still claims Remotion defaults concurrency to the CPU count", () => {
    const files = [
      "src/workflows/render/media-options.ts",
      "src/workflows/render/config.ts",
      "src/config/env.ts",
      "src/workflows/render/child-main.ts",
    ];
    for (const rel of files) {
      const text = readFileSync(resolve(process.cwd(), rel), "utf8");
      expect(text, rel).not.toMatch(/machine's CPU count/i);
      expect(text, rel).not.toMatch(/CPU COUNT/);
      expect(text, rel).not.toMatch(/defaults it to the CPU count/i);
    }
    // And the real formula is stated where the knob is documented.
    const opts = readFileSync(
      resolve(process.cwd(), "src/workflows/render/media-options.ts"),
      "utf8",
    );
    expect(opts).toContain("round(min(8, max(1, cpus / 2)))");
  });
});
