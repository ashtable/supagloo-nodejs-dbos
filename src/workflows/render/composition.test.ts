import { describe, expect, it } from "vitest";
import type { RenderOutputSpec } from "@supagloo/database-lib";
import { applyOutputSpec, type ResolvedComposition } from "./composition";

/**
 * Task #36 — OUTPUT-SPEC HANDLING (plan row 36's stated unit test).
 *
 * `selectComposition()` returns the composition as the project's manifest declares it
 * (width/height/fps/durationInFrames). The RenderJob carries its OWN output spec
 * (design §2.7: width/height/fps/aspectRatio/codec), which the user chose in the render
 * dialog. Overriding width/height is free; overriding FPS is NOT — `durationInFrames`
 * is expressed at the manifest's fps, so changing fps without rescaling silently
 * changes the video's WALL-CLOCK LENGTH.
 */

const base: ResolvedComposition = {
  id: "Main",
  width: 1080,
  height: 1920,
  fps: 30,
  durationInFrames: 360, // 12s @ 30fps
};

const spec = (over: Partial<RenderOutputSpec> = {}): RenderOutputSpec => ({
  width: 1080,
  height: 1920,
  fps: 30,
  aspectRatio: "9:16",
  codec: "h264",
  ...over,
});

describe("applyOutputSpec", () => {
  it("overrides width/height from the spec", () => {
    const out = applyOutputSpec(base, spec({ width: 720, height: 1280 }));
    expect(out.width).toBe(720);
    expect(out.height).toBe(1280);
  });

  it("keeps durationInFrames unchanged when the fps matches", () => {
    const out = applyOutputSpec(base, spec({ fps: 30 }));
    expect(out.fps).toBe(30);
    expect(out.durationInFrames).toBe(360);
  });

  it("RESCALES durationInFrames when the spec changes fps (wall-clock length preserved)", () => {
    const out = applyOutputSpec(base, spec({ fps: 60 }));
    expect(out.fps).toBe(60);
    expect(out.durationInFrames).toBe(720); // still 12 seconds
  });

  it("rescales downward and rounds to a whole frame", () => {
    const out = applyOutputSpec({ ...base, durationInFrames: 25 }, spec({ fps: 24 }));
    // 25 frames @30fps = 0.8333s -> 20 frames @24fps
    expect(out.durationInFrames).toBe(20);
  });

  it("never produces a zero-length composition (Remotion requires >= 1 frame)", () => {
    const out = applyOutputSpec({ ...base, durationInFrames: 1 }, spec({ fps: 1 }));
    expect(out.durationInFrames).toBeGreaterThanOrEqual(1);
  });

  it("preserves the composition id", () => {
    expect(applyOutputSpec(base, spec()).id).toBe("Main");
  });

  it("does not mutate the resolved composition it was given", () => {
    const snapshot = { ...base };
    applyOutputSpec(base, spec({ width: 100, height: 100, fps: 60 }));
    expect(base).toEqual(snapshot);
  });

  it("yields the framesTotal the RenderJob row should advertise", () => {
    const out = applyOutputSpec(base, spec({ fps: 15 }));
    expect(out.durationInFrames).toBe(180);
  });
});
