import { describe, expect, it } from "vitest";
import type { ProjectManifest } from "@supagloo/database-lib";
import {
  RENDER_AUDIO_DIR,
  applyAudioPlans,
  planAudioTrack,
  renderAudioAssetKey,
  renderSceneNarrationAssetKey,
} from "./audio";
import {
  emptyManifest,
  minimalManifest,
  shelterManifest,
} from "../../remotion/__fixtures__/manifests";

/**
 * Task #36 — the `ensureNarrationAudio` / `ensureMusicAudio` CONDITIONALS
 * (design-delta §7 workflow 9: "synthesize only if the manifest lacks cached asset
 * refs"), plus the manifest patch that makes a freshly-synthesized track actually
 * REACHABLE from the composition.
 *
 * The decision is pure and checkpointed as a small discriminant (design D5) precisely
 * because the workflow branches on it — re-deriving it from an ephemeral workspace on
 * replay could take a different branch and break determinism.
 */

const withNarrationRef = (m: ProjectManifest): ProjectManifest => ({
  ...m,
  narratorVoice: { ...m.narratorVoice, assetKey: "projects/p1/assets/narr-1" },
});

/**
 * The same fixture with NO cached narration ref.
 *
 * Explicit since Step-11 item 15: `shelterManifest` now carries `narratorVoice.assetKey`, so
 * the "no ref" cases below can no longer rely on the fixture happening not to have one. That
 * reliance was itself the shape of the defect item 15 fixed — `canonicalizeManifest` erased
 * the field, so a narration ref was something no fixture in the repo could realistically hold.
 */
const withoutNarrationRef = (m: ProjectManifest): ProjectManifest => ({
  ...m,
  narratorVoice: { description: m.narratorVoice.description, label: m.narratorVoice.label },
});

const CONNECTED = { hasOpenRouterConnection: true } as const;

/** Minimal shared fixtures for the render-bug cases at the bottom of this file. */
const SCENE = {
  id: "s1",
  name: "Scene",
  scriptText: "text",
  reference: "Genesis 1:1",
  translation: "KJV",
  visualPrompt: "prompt",
  durationSeconds: 2,
  captions: true,
} as const;
const BASE: ProjectManifest = {
  manifestVersion: 1,
  composition: { width: 320, height: 180, fps: 10, aspectRatio: "16:9" },
  scenes: [SCENE],
  narratorVoice: { description: "Warm narrator" },
};

describe("planAudioTrack — narration", () => {
  it("is `cached` when the manifest already carries narratorVoice.assetKey", () => {
    const plan = planAudioTrack({
      kind: "narration",
      manifest: withNarrationRef(shelterManifest),
      modelId: "some-model",
      ...CONNECTED,
    });
    expect(plan.action).toBe("cached");
    expect(plan.action === "cached" && plan.assetKey).toBe(
      "projects/p1/assets/narr-1",
    );
  });

  it("is `synthesize` when there is no ref but a model, script text, and a connection", () => {
    const plan = planAudioTrack({
      kind: "narration",
      manifest: withoutNarrationRef(shelterManifest),
      modelId: "some-model",
      ...CONNECTED,
    });
    expect(plan.action).toBe("synthesize");
    if (plan.action !== "synthesize" || plan.kind !== "narration") return;
    // One clip PER SCENE (was: one combined track). The combined form is what made
    // scene-synced narration unexpressible — a single file with no scene boundaries.
    expect(plan.scenes).toHaveLength(shelterManifest.scenes.length);
    expect(plan.scenes[0].speechArgs.modelId).toBe("some-model");
    expect(plan.scenes[0].speechArgs.input).toBe(shelterManifest.scenes[0].scriptText);
    expect(plan.scenes[1].speechArgs.input).toBe(shelterManifest.scenes[1].scriptText);
    expect(plan.scenes[0].speechArgs.voice).toBeTruthy();
  });

  it("is `skipped` when no render narration model is configured", () => {
    const plan = planAudioTrack({
      kind: "narration",
      manifest: withoutNarrationRef(shelterManifest),
      modelId: undefined,
      ...CONNECTED,
    });
    expect(plan.action).toBe("skipped");
  });

  it("is `skipped` when the user has no OpenRouter connection", () => {
    const plan = planAudioTrack({
      kind: "narration",
      manifest: withoutNarrationRef(shelterManifest),
      modelId: "some-model",
      hasOpenRouterConnection: false,
    });
    expect(plan.action).toBe("skipped");
  });

  it("is `skipped` when there is no script text to speak (zero-scene project)", () => {
    const plan = planAudioTrack({
      kind: "narration",
      manifest: emptyManifest,
      modelId: "some-model",
      ...CONNECTED,
    });
    expect(plan.action).toBe("skipped");
  });
});

describe("planAudioTrack — music", () => {
  it("is `cached` when the manifest carries music.assetKey", () => {
    const plan = planAudioTrack({
      kind: "music",
      manifest: shelterManifest,
      modelId: "music-model",
      ...CONNECTED,
    });
    expect(plan.action).toBe("cached");
    expect(plan.action === "cached" && plan.assetKey).toBe(
      "projects/demo/music/bed.mp3",
    );
  });

  it("is `synthesize` from the style label when there is a style but no ref", () => {
    const manifest: ProjectManifest = {
      ...shelterManifest,
      music: { style: "ambient cinematic pads" },
    };
    const plan = planAudioTrack({
      kind: "music",
      manifest,
      modelId: "music-model",
      ...CONNECTED,
    });
    expect(plan.action).toBe("synthesize");
    if (plan.action !== "synthesize" || plan.kind !== "music") return;
    expect(plan.assetKey).toBe(renderAudioAssetKey("music"));
    expect(plan.musicArgs.input).toBe("ambient cinematic pads");
    // The music args carry a model + a style prompt and NOTHING else — in particular no
    // duration, because no discovered music model accepts one.
    expect(Object.keys(plan.musicArgs).sort()).toEqual(["input", "modelId"]);
  });

  it("is `skipped` when the manifest has no music bed at all", () => {
    const plan = planAudioTrack({
      kind: "music",
      manifest: minimalManifest,
      modelId: "music-model",
      ...CONNECTED,
    });
    expect(plan.action).toBe("skipped");
  });
});

describe("applyAudioPlans — the patch that makes synthesized audio reachable", () => {
  it("writes a render-local key onto the manifest ONLY for synthesized tracks", () => {
    // Narration must have NO cached ref for this case to be about synthesis at all — since
    // Step-11 item 15 the shelter fixture carries one, so it is stripped explicitly.
    const subject = withoutNarrationRef(shelterManifest);
    const narration = planAudioTrack({
      kind: "narration",
      manifest: subject,
      modelId: "m",
      ...CONNECTED,
    });
    const music = planAudioTrack({
      kind: "music",
      manifest: subject,
      modelId: "m",
      ...CONNECTED,
    });
    expect(narration.action).toBe("synthesize");
    expect(music.action).toBe("cached");
    const patched = applyAudioPlans(subject, { narration, music });

    // Narration now lands PER SCENE. The whole-project `narratorVoice.assetKey` is
    // deliberately NOT written: the composition prefers per-scene clips and ignores the
    // whole-video track once any exist, so writing both would play the narration twice.
    expect(patched.narratorVoice.assetKey).toBeUndefined();
    for (const scene of patched.scenes) {
      expect(scene.narrationAssetKey).toBe(renderSceneNarrationAssetKey(scene.id));
    }
    // music was `cached` — its existing key is left exactly as-is.
    expect(patched.music?.assetKey).toBe("projects/demo/music/bed.mp3");
  });

  /**
   * Step-11 item 15 (RX-4 / R4850-7) — THE POINT of the canonicalizer fix, stated as a test.
   *
   * With the fixture's cached narration ref preserved through a commit, `planAudioTrack`
   * answers `cached` and the render performs NO TTS call. Before item 15,
   * `canonicalizeManifest` erased the ref on every commit, so this could never happen for a
   * committed version and every render of one re-synthesized narration through a live
   * provider — real spend, per render. §10 R8's premise for row 45's published numbers
   * ("cached audio refs so N costs time, not money") depended on exactly this.
   */
  it("performs NO synthesis for a manifest that round-tripped a cached narration ref", () => {
    const narration = planAudioTrack({
      kind: "narration",
      manifest: shelterManifest,
      modelId: "m",
      ...CONNECTED,
    });
    expect(narration.action).toBe("cached");
    expect(narration.action === "cached" && narration.assetKey).toBe(
      "projects/demo/narration/full.mp3",
    );
  });

  it("leaves the manifest untouched when both tracks are cached or skipped", () => {
    const manifest = withNarrationRef(shelterManifest);
    const patched = applyAudioPlans(manifest, {
      narration: { action: "cached", assetKey: "projects/p1/assets/narr-1" },
      music: { action: "skipped", reason: "no music bed" },
    });
    expect(patched).toEqual(manifest);
  });

  it("does not mutate the input manifest", () => {
    const before = JSON.stringify(shelterManifest);
    applyAudioPlans(shelterManifest, {
      narration: {
        action: "synthesize",
        kind: "narration",
        scenes: [
          {
            sceneId: shelterManifest.scenes[0].id,
            assetKey: renderSceneNarrationAssetKey(shelterManifest.scenes[0].id),
            speechArgs: { modelId: "m", input: "hi", voice: "alloy" },
            durationSeconds: 3.5,
          },
        ],
      },
      music: { action: "skipped", reason: "none" },
    });
    expect(JSON.stringify(shelterManifest)).toBe(before);
  });
});

describe("renderAudioAssetKey — workspace-local, obviously not an S3 key", () => {
  it("lives under a render-audio directory so it can never collide with an S3 asset key", () => {
    expect(renderAudioAssetKey("narration")).toBe(`${RENDER_AUDIO_DIR}/narration.wav`);
    expect(renderAudioAssetKey("music")).toBe(`${RENDER_AUDIO_DIR}/music.wav`);
    // db-lib's S3 layout is `projects/…` / `renders/…`; ours is neither.
    expect(renderAudioAssetKey("narration").startsWith("projects/")).toBe(false);
    expect(renderAudioAssetKey("narration").startsWith("renders/")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Render-bug work. The render-time synthesis fallback must produce the SAME shape the
// studio path produces, or a project rendered through the fallback silently reverts to the
// old bugs (one drifting narration track; a bed that plays once and stops).
// ---------------------------------------------------------------------------

describe("planAudioTrack — narration is planned PER SCENE", () => {
  const manifest: ProjectManifest = {
    ...BASE,
    scenes: [
      { ...SCENE, id: "s1", scriptText: "In the beginning God created the heaven." },
      { ...SCENE, id: "s2", scriptText: "And God said, Let there be light." },
    ],
    narratorVoice: { description: "Warm narrator" },
  };

  it("U-RA1: emits one synthesis per scene, each with only that scene's verse", () => {
    const plan = planAudioTrack({
      kind: "narration",
      manifest,
      modelId: "resolved/speech-model",
      hasOpenRouterConnection: true,
    });
    expect(plan.action).toBe("synthesize");
    if (plan.action !== "synthesize" || plan.kind !== "narration") return;
    expect(plan.scenes).toHaveLength(2);
    expect(plan.scenes[0].sceneId).toBe("s1");
    expect(plan.scenes[0].speechArgs.input).toBe(
      "In the beginning God created the heaven.",
    );
    expect(plan.scenes[1].speechArgs.input).toBe("And God said, Let there be light.");
    // Never the concatenated blob that made per-scene sync impossible.
    for (const s of plan.scenes) expect(s.speechArgs.input).not.toContain("\n\n");
  });

  it("U-RA2: each scene gets its own distinct workspace-local key", () => {
    const plan = planAudioTrack({
      kind: "narration",
      manifest,
      modelId: "m",
      hasOpenRouterConnection: true,
    });
    if (plan.action !== "synthesize" || plan.kind !== "narration") {
      throw new Error("expected a per-scene narration synthesize plan");
    }
    const keys = plan.scenes.map((s) => s.assetKey);
    expect(new Set(keys).size).toBe(keys.length);
    for (const k of keys) expect(k.startsWith(`${RENDER_AUDIO_DIR}/`)).toBe(true);
  });

  it("U-RA3: applyAudioPlans writes per-scene keys AND measured lengths onto the manifest", () => {
    // The measured length is what makes the scene stretch instead of clipping the verse,
    // and the key is what puts the clip inside the scene's own <Sequence>. Both have to
    // reach the manifest that `materializeRenderSources` regenerates from.
    const plan = planAudioTrack({
      kind: "narration",
      manifest,
      modelId: "m",
      hasOpenRouterConnection: true,
    });
    if (plan.action !== "synthesize" || plan.kind !== "narration") {
      throw new Error("expected a per-scene narration synthesize plan");
    }
    const measured = {
      ...plan,
      scenes: plan.scenes.map((s, i) => ({ ...s, durationSeconds: 6.5 + i })),
    };
    const out = applyAudioPlans(manifest, {
      narration: measured,
      music: { action: "skipped", reason: "none" },
    });
    expect(out.scenes[0].narrationAssetKey).toBe(plan.scenes[0].assetKey);
    expect(out.scenes[0].narrationDurationSeconds).toBe(6.5);
    expect(out.scenes[1].narrationDurationSeconds).toBe(7.5);
    // The whole-project key is NOT set — the two would double up in the composition.
    expect(out.narratorVoice.assetKey).toBeUndefined();
  });
});

describe("planAudioTrack — music carries its MEASURED length to the manifest", () => {
  it("U-RA4: applyAudioPlans writes music.durationSeconds so the bed can be looped", () => {
    const manifest: ProjectManifest = {
      ...BASE,
      music: { style: "ambient pads" },
    };
    const plan = planAudioTrack({
      kind: "music",
      manifest,
      modelId: "m",
      hasOpenRouterConnection: true,
    });
    if (plan.action !== "synthesize" || plan.kind !== "music") {
      throw new Error("expected a music synthesize plan");
    }
    const out = applyAudioPlans(manifest, {
      narration: { action: "skipped", reason: "none" },
      music: { ...plan, durationSeconds: 29.07 },
    });
    expect(out.music?.assetKey).toBe(plan.assetKey);
    expect(out.music?.durationSeconds).toBe(29.07);
  });

  it("U-RA5: an UNMEASURED bed leaves durationSeconds absent rather than guessed", () => {
    const manifest: ProjectManifest = { ...BASE, music: { style: "ambient pads" } };
    const plan = planAudioTrack({
      kind: "music",
      manifest,
      modelId: "m",
      hasOpenRouterConnection: true,
    });
    if (plan.action !== "synthesize" || plan.kind !== "music") {
      throw new Error("expected a music synthesize plan");
    }
    const out = applyAudioPlans(manifest, {
      narration: { action: "skipped", reason: "none" },
      music: plan,
    });
    expect(out.music?.durationSeconds).toBeUndefined();
  });
});
