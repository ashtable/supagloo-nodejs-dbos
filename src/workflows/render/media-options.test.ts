import { describe, expect, it } from "vitest";
import { buildRenderMediaOptions } from "./media-options";

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
 *   • Remotion's `concurrency` defaults to the machine's CPU COUNT. Each unit is a Chromium
 *     tab holding decoded frames, so on a 16-core box one render opens 16 of them — the
 *     single biggest unbounded memory lever in the pipeline, and the reason a container
 *     with a modest limit OOMs while the same render succeeds on a laptop.
 *
 * The tuning is therefore: pass Remotion's per-frame timeout, derived from the deadline we
 * already have; and make `concurrency` explicitly configurable, defaulting to "leave
 * Remotion's default alone" so this row changes no observed behaviour until an operator
 * opts in. That distinction matters — the sizing recommendation is extrapolated from
 * Compose (api and dbos are not deployed to Railway), so shipping a guessed concurrency as
 * the default would be exactly the overclaim the delta warns against.
 */

describe("buildRenderMediaOptions", () => {
  it("U-RMO1: passes Remotion's own per-frame timeout, derived from the child kill deadline", () => {
    const opts = buildRenderMediaOptions({ mediaTimeoutMs: 3_600_000 });
    expect(opts.timeoutInMilliseconds).toBe(3_600_000);
  });

  it("U-RMO2: omits `concurrency` entirely when unset — Remotion's default stands", () => {
    const opts = buildRenderMediaOptions({ mediaTimeoutMs: 3_600_000 });
    // `undefined` is not good enough: Remotion distinguishes an absent key from an
    // explicit undefined in some option paths, and "we changed nothing" must be literal.
    expect("concurrency" in opts).toBe(false);
  });

  it("U-RMO3: passes `concurrency` when the operator sets it", () => {
    const opts = buildRenderMediaOptions({ mediaTimeoutMs: 3_600_000, concurrency: 2 });
    expect(opts.concurrency).toBe(2);
  });

  it("U-RMO4: never emits a non-positive timeout", () => {
    // A zero/negative `timeoutInMilliseconds` would make Remotion fail every frame
    // instantly; the env schema rejects it, and this is the second line of defence.
    expect(() => buildRenderMediaOptions({ mediaTimeoutMs: 0 })).toThrow(
      /mediaTimeoutMs/,
    );
  });
});
