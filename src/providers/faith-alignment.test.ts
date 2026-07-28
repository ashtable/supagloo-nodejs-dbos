import { describe, expect, it } from "vitest";
import { GLOO_TRADITIONS, coerceTradition } from "./faith-alignment";

/**
 * U-FA2 — the wire vocabulary for Gloo's `tradition` request field.
 *
 * This is the single most important guard in the faith-alignment feature, and the reason
 * is counter-intuitive: **Gloo does not validate this field.** Measured against the live
 * host on 2026-07-28, `orthodox`, `protestant`, `reformed`, `pentecostal`, `buddhist`,
 * `null` and a garbage sentinel ALL returned **200** and silently collapsed to the same
 * 757-prompt-token neutral baseline that omitting the field entirely produces. There is
 * no 422, no warning, and no observable difference in the response envelope.
 *
 * So the failure mode of a wrong value is not an error. It is a user who chose
 * "Protestant" in the Inspector, saw the generation succeed, and got a video that is not
 * faith-aligned at all. Nothing downstream can detect it. This function is where it has
 * to be caught, and `coerceTradition` DROPS rather than throws so that a bad value
 * degrades to "no tradition sent" (identical to the neutral baseline) instead of failing
 * a generation the user already paid for.
 *
 * `evangelical` / `mainline` are the two Protestant-family values Gloo actually offers —
 * there is no `protestant` and no `orthodox`.
 */

describe("Gloo `tradition` vocabulary (U-FA2)", () => {
  it("U-FA2a: GLOO_TRADITIONS is exactly the four values the live host honours", () => {
    expect([...GLOO_TRADITIONS].sort()).toEqual([
      "catholic",
      "evangelical",
      "mainline",
      "not_faith_specific",
    ]);
  });

  it("U-FA2b: every real value passes through unchanged", () => {
    for (const value of GLOO_TRADITIONS) {
      expect(coerceTradition(value), value).toBe(value);
    }
  });

  it("U-FA2c: `protestant` and `orthodox` are DROPPED — they do not exist", () => {
    // The two most plausible wrong guesses, and the exact pair the task's own phrasing
    // ("catholic, protestant, etc.") would have produced.
    expect(coerceTradition("protestant")).toBeUndefined();
    expect(coerceTradition("orthodox")).toBeUndefined();
  });

  it("U-FA2d: every other silently-200'd value is dropped, including a wrong CASE", () => {
    for (const bad of [
      "reformed",
      "pentecostal",
      "buddhist",
      "Catholic",
      "CATHOLIC",
      " catholic ",
      "",
      null,
      undefined,
      42,
      {},
      ["catholic"],
    ]) {
      expect(coerceTradition(bad), JSON.stringify(bad) ?? "undefined").toBeUndefined();
    }
  });

  it("U-FA2e: the set is frozen, so a caller cannot widen the wire vocabulary at runtime", () => {
    expect(Object.isFrozen(GLOO_TRADITIONS)).toBe(true);
  });
});
