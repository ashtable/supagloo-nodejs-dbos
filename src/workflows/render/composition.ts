import type { RenderOutputSpec } from "@supagloo/database-lib";

/**
 * Reconciling the RESOLVED composition (what `selectComposition()` reports, i.e. what the
 * project's manifest declares) with the RenderJob's OUTPUT SPEC (what the user chose in
 * the render dialog — design §2.7's width/height/fps/aspectRatio/codec columns).
 *
 * Overriding width/height is free: Remotion re-lays-out the composition at the new pixel
 * size. Overriding FPS is NOT free — `durationInFrames` is expressed AT the manifest's
 * fps, so raising fps without rescaling would silently shorten the video's wall-clock
 * length (and lowering it would stretch it). We therefore rescale proportionally, which
 * preserves duration-in-seconds, and clamp to Remotion's minimum of one frame.
 *
 * Pure — no Remotion import, no I/O — so the arithmetic is unit-testable on its own.
 */

export interface ResolvedComposition {
  id: string;
  width: number;
  height: number;
  fps: number;
  durationInFrames: number;
}

export function applyOutputSpec(
  base: ResolvedComposition,
  spec: RenderOutputSpec,
): ResolvedComposition {
  const durationInFrames =
    spec.fps === base.fps
      ? base.durationInFrames
      : Math.max(1, Math.round((base.durationInFrames * spec.fps) / base.fps));

  return {
    id: base.id,
    width: spec.width,
    height: spec.height,
    fps: spec.fps,
    durationInFrames,
  };
}
