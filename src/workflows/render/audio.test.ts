import { describe, expect, it } from "vitest";
import type { ProjectManifest } from "@supagloo/database-lib";
import {
  RENDER_AUDIO_DIR,
  applyAudioPlans,
  planAudioTrack,
  renderAudioAssetKey,
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
    if (plan.action !== "synthesize") return;
    expect(plan.assetKey).toBe(renderAudioAssetKey("narration"));
    expect(plan.speechArgs.modelId).toBe("some-model");
    // Design D5 (mirrors generateAudio's decision D5): one combined track, per-scene
    // scripts concatenated in array order.
    expect(plan.speechArgs.input).toContain(shelterManifest.scenes[0].scriptText);
    expect(plan.speechArgs.input).toContain(shelterManifest.scenes[1].scriptText);
    expect(plan.speechArgs.voice).toBeTruthy();
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
    if (plan.action !== "synthesize") return;
    expect(plan.assetKey).toBe(renderAudioAssetKey("music"));
    expect(plan.speechArgs.input).toBe("ambient cinematic pads");
    // Music (Lyria) takes NO voice — the same rule generateAudio's buildSpeechArgs uses.
    expect(plan.speechArgs.voice).toBeUndefined();
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

    expect(patched.narratorVoice.assetKey).toBe(renderAudioAssetKey("narration"));
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
        assetKey: renderAudioAssetKey("narration"),
        speechArgs: { modelId: "m", input: "hi", voice: "alloy" },
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
