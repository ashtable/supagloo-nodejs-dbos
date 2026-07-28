import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { bundle } from "@remotion/bundler";
import { renderMedia, renderStill, selectComposition } from "@remotion/renderer";
import type { ProjectManifest } from "@supagloo/database-lib";
import { writeRemotionScaffold } from "../../src/remotion";
import {
  checkerboardPng,
  toneWav,
  windowLevel,
} from "../../src/testing/media-fixtures";

/**
 * THE PROOF SPEC for the three render bugs — narration sync, music coverage, Ken Burns.
 *
 * ## Why this spec had to exist before the fixes could be believed
 *
 * The render lane's existing fixture is ONE scene of ONE second at 320×180. design-delta
 * §11.9 says of it, verbatim, "do not overclaim it" — and it is right: a single-scene,
 * single-second composition cannot express narration drifting between scenes, cannot show a
 * music bed running out, and has nowhere for a pan to travel. Every claim about these three
 * bugs was, until now, unfalsifiable by any lane in the repo. (This is plan row 61's
 * representative multi-scene fixture, folded into this run rather than deferred.)
 *
 * ## Why it lives in the BUNDLE lane
 *
 * This lane has no globalSetup, no Postgres, no DBOS, no GitHub and no provider calls — it is
 * pure filesystem + `@remotion/bundler` + `@remotion/renderer`. That is everything the three
 * claims actually need, because all three are properties of the GENERATED COMPOSITION, not of
 * the workflow that fetches its inputs. Putting them here makes them run without credentials
 * or containers, and keeps them out of the credit-dependent provider lanes. Real bundler,
 * real headless Chromium, real encode — nothing is stubbed.
 *
 * ## Cost discipline (§10.9)
 *
 * 320×180, 10 fps, and audio-only WAV renders for the two audio proofs (no H.264 encode).
 * Scene durations are nonetheless REAL multi-second values, because that is exactly the thing
 * the old fixture collapsed away.
 *
 * ## Every proof carries its own CONTROL
 *
 * Each assertion is paired with a case that must come out the OTHER way. A test that only
 * ever sees the "good" arm cannot tell the difference between a working fix and an assertion
 * that is true by construction — which is the specific way this repo has been fooled before
 * (memory `a-test-that-claims-a-class-must-drive-the-class`).
 */

const REPO_NODE_MODULES = resolve(__dirname, "..", "..", "node_modules");
const FPS = 10;
const WIDTH = 320;
const HEIGHT = 180;
/** 4 s per scene = 40 frames, so there is room BEYOND the 15-frame caption fade to sample. */
const SCENE_SECONDS = 4;

const tempDirs: string[] = [];

afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

function scene(
  id: string,
  over: Partial<ProjectManifest["scenes"][number]> = {},
): ProjectManifest["scenes"][number] {
  return {
    id,
    name: id.toUpperCase(),
    scriptText: `Verse for ${id}`,
    reference: "Genesis 1:1",
    translation: "KJV",
    visualPrompt: "a formless void",
    durationSeconds: SCENE_SECONDS,
    captions: false,
    visualAssetKey: "assets/still.png",
    ...over,
  };
}

/**
 * Scaffold a manifest into a temp dir, write the referenced assets into `public/` (exactly
 * what `renderWorkflow` does before bundling — `bundle()` snapshots `public/`), and bundle.
 */
async function buildProject(
  manifest: ProjectManifest,
  assets: Record<string, Buffer>,
): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "supagloo-render-proof-"));
  tempDirs.push(dir);
  await writeRemotionScaffold(manifest, dir);
  for (const [key, bytes] of Object.entries(assets)) {
    const file = join(dir, "public", key);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, bytes);
  }
  return bundle({
    entryPoint: join(dir, "src", "index.ts"),
    webpackOverride: (config) => ({
      ...config,
      resolve: { ...config.resolve, modules: [REPO_NODE_MODULES, "node_modules"] },
    }),
  });
}

/** Render the composition's AUDIO ONLY to a WAV and return its bytes. */
async function renderAudio(serveUrl: string): Promise<Buffer> {
  const composition = await selectComposition({ serveUrl, id: "Main" });
  const out = join(mkdtempSync(join(tmpdir(), "supagloo-proof-out-")), "audio.wav");
  tempDirs.push(dirname(out));
  await renderMedia({ serveUrl, composition, codec: "wav", outputLocation: out });
  return readFileSync(out);
}

/**
 * Render a project to a real H.264 MP4 and return its path.
 *
 * Used to manufacture the one asset this spec cannot synthesize by hand: a genuine, decodable
 * VIDEO file for the `visualAssetKind: "video"` control. Feeding a PNG through
 * `<OffthreadVideo>` does not work — Remotion's compositor refuses to seek a still as a video
 * ("No frame found at position N") — so the control has to be a real clip, and the renderer
 * already installed here is the honest way to get one.
 */
async function renderMp4(serveUrl: string): Promise<string> {
  const composition = await selectComposition({ serveUrl, id: "Main" });
  const out = join(mkdtempSync(join(tmpdir(), "supagloo-proof-clip-")), "clip.mp4");
  tempDirs.push(dirname(out));
  await renderMedia({ serveUrl, composition, codec: "h264", outputLocation: out });
  return out;
}

/** Render one frame to PNG and return its bytes. */
async function frame(serveUrl: string, frameNumber: number): Promise<Buffer> {
  const composition = await selectComposition({ serveUrl, id: "Main" });
  const out = join(
    mkdtempSync(join(tmpdir(), "supagloo-proof-still-")),
    `f${frameNumber}.png`,
  );
  tempDirs.push(dirname(out));
  await renderStill({ serveUrl, composition, frame: frameNumber, output: out });
  return readFileSync(out);
}

const STILL = checkerboardPng(WIDTH, HEIGHT);
/** Audible for the whole scene, so its window is unambiguously loud. */
const NARRATION = toneWav(SCENE_SECONDS, 440);
/** 2 s — HALF of one scene and an eighth of the 16 s composition, so a bed that does not
 *  loop leaves most of the video silent. */
const MUSIC = toneWav(2, 220);

const BASE_COMPOSITION = {
  width: WIDTH,
  height: HEIGHT,
  fps: FPS,
  aspectRatio: "16:9",
} as const;

// ===========================================================================
// BUG 2 — the music bed covers the entire video
// ===========================================================================

describe("bug 2: the music bed spans the whole composition", () => {
  const scenes = [scene("s1"), scene("s2"), scene("s3"), scene("s4")];
  // 4 scenes × 4 s = 16 s. The bed is 2 s: it must repeat 8 times to cover the video.
  const TOTAL_SECONDS = 16;

  it("E-M1: a 2 s bed is LOOPED so the final second of a 16 s video still has music", async () => {
    const serveUrl = await buildProject(
      {
        manifestVersion: 1,
        composition: BASE_COMPOSITION,
        scenes,
        narratorVoice: { description: "Narrator" },
        music: {
          style: "ambient pads",
          assetKey: "assets/music.wav",
          // The MEASURED bed length — the only thing that makes looping possible, since no
          // music model accepts a requested duration.
          durationSeconds: 2,
        },
      },
      { "assets/still.png": STILL, "assets/music.wav": MUSIC },
    );
    const wav = await renderAudio(serveUrl);

    // The last second of the video — where the shipped bed had long since stopped.
    const tail = windowLevel(wav, TOTAL_SECONDS - 1, TOTAL_SECONDS - 0.1);
    expect(tail).toBeGreaterThan(0.01);
    // ...and the middle, so this is coverage rather than one lucky repeat.
    expect(windowLevel(wav, 7, 8)).toBeGreaterThan(0.01);
  }, 600_000);

  it("E-M2 (CONTROL): with NO measured length the bed is NOT looped and the tail IS silent", async () => {
    // This is what every manifest committed before this change looks like, and it is the
    // arm that makes E-M1 meaningful: it proves the tail window can be silent, so E-M1's
    // non-silence is a property of the loop and not of the measurement being blunt.
    const serveUrl = await buildProject(
      {
        manifestVersion: 1,
        composition: BASE_COMPOSITION,
        scenes,
        narratorVoice: { description: "Narrator" },
        music: { style: "ambient pads", assetKey: "assets/music.wav" },
      },
      { "assets/still.png": STILL, "assets/music.wav": MUSIC },
    );
    const wav = await renderAudio(serveUrl);

    expect(windowLevel(wav, 0.2, 1.5)).toBeGreaterThan(0.01); // it does start
    expect(windowLevel(wav, TOTAL_SECONDS - 1, TOTAL_SECONDS - 0.1)).toBeLessThan(0.005);
  }, 600_000);
});

// ===========================================================================
// BUG 1 — narration is synced to its own scene
// ===========================================================================

describe("bug 1: each scene's narration plays during THAT scene", () => {
  it("E-N1: narration attached to scene 2 is silent in scene 1 and audible in scene 2", async () => {
    // Scene 1 = 0–4 s, scene 2 = 4–8 s, scene 3 = 8–12 s. Only scene 2 carries audio.
    //
    // Under the shipped composition this could not have passed: narration was ONE asset
    // mounted at frame 0 outside every <Sequence>, so the audio always began at 0 s. The
    // silence in the first window is the assertion that the sync mechanism exists at all.
    const serveUrl = await buildProject(
      {
        manifestVersion: 1,
        composition: BASE_COMPOSITION,
        scenes: [
          scene("s1"),
          scene("s2", { narrationAssetKey: "assets/n2.wav", narrationDurationSeconds: 4 }),
          scene("s3"),
        ],
        narratorVoice: { description: "Narrator" },
      },
      { "assets/still.png": STILL, "assets/n2.wav": NARRATION },
    );
    const wav = await renderAudio(serveUrl);

    expect(windowLevel(wav, 0.2, 3.5)).toBeLessThan(0.005); // scene 1: silent
    expect(windowLevel(wav, 4.5, 7.5)).toBeGreaterThan(0.01); // scene 2: audible
    expect(windowLevel(wav, 8.5, 11.5)).toBeLessThan(0.005); // scene 3: silent again
  }, 600_000);

  it("E-N2: a scene STRETCHES so a long verse is never cut off mid-sentence", async () => {
    // Scene 1 is authored at 1 s but its narration measures 4 s. If the scene did not grow,
    // the audio would be truncated at 1 s and everything after would be silence — so a loud
    // window at 3–3.8 s is precisely the proof that the scene stretched to fit.
    const serveUrl = await buildProject(
      {
        manifestVersion: 1,
        composition: BASE_COMPOSITION,
        scenes: [
          scene("s1", {
            durationSeconds: 1,
            narrationAssetKey: "assets/n1.wav",
            narrationDurationSeconds: 4,
          }),
          scene("s2"),
        ],
        narratorVoice: { description: "Narrator" },
      },
      { "assets/still.png": STILL, "assets/n1.wav": NARRATION },
    );
    const wav = await renderAudio(serveUrl);

    expect(windowLevel(wav, 0.2, 0.9)).toBeGreaterThan(0.01);
    expect(windowLevel(wav, 3.0, 3.8)).toBeGreaterThan(0.01);
    // And the composition really is 4 s + 4 s, not 1 s + 4 s: scene 2 follows the STRETCHED
    // scene 1, so the tail after 8 s does not exist.
    const composition = await selectComposition({ serveUrl, id: "Main" });
    expect(composition.durationInFrames).toBe(80);
  }, 600_000);
});

// ===========================================================================
// BUG 3 — Ken Burns on stills
// ===========================================================================

describe("bug 3: a still-image scene pans and zooms", () => {
  const manifestFor = (kind: "image" | "video" | undefined): ProjectManifest => ({
    manifestVersion: 1,
    composition: BASE_COMPOSITION,
    scenes: [scene("s1", kind ? { visualAssetKind: kind } : {})],
    narratorVoice: { description: "Narrator" },
  });

  it("E-K1: two frames of the same still scene differ, and re-rendering one is identical", async () => {
    const serveUrl = await buildProject(manifestFor("image"), {
      "assets/still.png": STILL,
    });

    // Frames 20 and 39 are both PAST the 15-frame caption/reference fade, which clamps — so
    // the overlay is pixel-identical at both and ANY difference is the image moving. Frame 20
    // rendered twice is the determinism control: it proves the comparison is not just
    // detecting renderer noise.
    const [a, aAgain, b] = [
      await frame(serveUrl, 20),
      await frame(serveUrl, 20),
      await frame(serveUrl, 39),
    ];
    expect(a.equals(aAgain)).toBe(true);
    expect(a.equals(b)).toBe(false);
  }, 600_000);

  it("E-K2 (CONTROL): a VIDEO-kind scene gets no pan — its two frames are identical", async () => {
    // A clip already moves; adding a pan on top of it is wrong, and rendering it through
    // <Img> — which is what happened before the manifest could tell a still from a clip —
    // is worse still.
    //
    // The control needs a REAL video file, so one is manufactured here: a project with no
    // visual at all is rendered to MP4, giving a genuinely decodable clip whose own content
    // is motionless (the caption/reference fade has clamped long before frame 20). Any
    // difference between two of its frames would therefore have to come from a pan — and
    // there must not be one.
    const blankUrl = await buildProject(
      {
        manifestVersion: 1,
        composition: BASE_COMPOSITION,
        scenes: [scene("clip", { visualAssetKey: undefined })],
        narratorVoice: { description: "Narrator" },
      },
      {},
    );
    const clipPath = await renderMp4(blankUrl);

    const serveUrl = await buildProject(
      {
        manifestVersion: 1,
        composition: BASE_COMPOSITION,
        scenes: [scene("s1", { visualAssetKey: "assets/clip.mp4", visualAssetKind: "video" })],
        narratorVoice: { description: "Narrator" },
      },
      { "assets/clip.mp4": readFileSync(clipPath) },
    );
    const [a, b] = [await frame(serveUrl, 20), await frame(serveUrl, 39)];
    expect(a.equals(b)).toBe(true);
  }, 600_000);

  it("E-K3: a v1 scene with NO visualAssetKind still pans (absent means image)", async () => {
    const serveUrl = await buildProject(manifestFor(undefined), {
      "assets/still.png": STILL,
    });
    const [a, b] = [await frame(serveUrl, 20), await frame(serveUrl, 39)];
    expect(a.equals(b)).toBe(false);
  }, 600_000);
});
