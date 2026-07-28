import { describe, expect, it } from "vitest";
import type { ProjectManifest } from "@supagloo/database-lib";
import { generateManifestFiles, type GeneratedFile } from "../../remotion/generate";
import { shelterManifest } from "../../remotion/__fixtures__/manifests";
import { manifestAssetKeys } from "./assets";
import { applyAudioPlans, planAudioTrack, type AudioPlans } from "./audio";

/**
 * THE CLASS UNDER TEST is not `manifestAssetKeys` — it is the pairing between what the
 * GENERATOR emits and what the WORKFLOW materializes. R1 was a member of that class
 * (`scene.narrationAssetKey` was emitted and never downloaded); a test that hardcoded that
 * one field would leave the next one out, so this spec extracts the emitted set from the
 * generated source and cross-checks the whole thing.
 *
 * The invariant (see `assets.ts`) is a UNION, not an equality with `manifestAssetKeys`:
 *
 *   emitted(generateManifestFiles(applyAudioPlans(m, plans)))
 *     ⊆ manifestAssetKeys(m) ∪ renderAudioKeys(plans)
 *
 * `render.ts` feeds `ensureSceneAssets` the manifest AS COMMITTED and feeds the generator
 * `applyAudioPlans(manifest, plans)`, so the render-time-synthesis fallback emits
 * workspace-local `render-audio/…` keys that `manifestAssetKeys` must NOT contain.
 */

/**
 * Extract every asset key the generated composition actually resolves, WITHOUT consulting
 * the implementation: scan the emitted `.tsx` for `getAssetUrl(<ident>)` call sites, then
 * read each identifier's own `const <ident> = <json>;` declaration out of the same file.
 *
 * `src/lib/assets.ts` (which holds `getAssetUrl`'s definition) is excluded twice over —
 * it is not `.tsx`, and it is a STATIC file, not part of `generateManifestFiles`.
 */
function emittedAssetKeys(files: GeneratedFile[]): Set<string> {
  const out = new Set<string>();
  for (const file of files) {
    if (!file.path.endsWith(".tsx")) continue;
    for (const call of file.contents.matchAll(/getAssetUrl\(([A-Za-z_$][\w$]*)\)/g)) {
      const ident = call[1] as string;
      const decl = new RegExp(`^\\s*const ${ident} = (.+);$`, "m").exec(file.contents);
      expect(decl, `${file.path}: no const declaration for ${ident}`).not.toBeNull();
      const value: unknown = JSON.parse((decl as RegExpExecArray)[1] as string);
      // `null` is the "this scene has no visual" case — nothing to materialize.
      if (typeof value === "string") out.add(value);
    }
  }
  return out;
}

/**
 * The other materializer's half: the workspace-local keys `ensureAudioOnDisk` writes.
 * Read off the PLAN, which is exactly what `render.ts` hands to `writeWorkspaceAsset`.
 */
function renderAudioKeys(plans: AudioPlans): Set<string> {
  const out = new Set<string>();
  if (plans.narration.action === "synthesize" && plans.narration.kind === "narration") {
    for (const scene of plans.narration.scenes) out.add(scene.assetKey);
  }
  if (plans.music.action === "synthesize" && plans.music.kind === "music") {
    out.add(plans.music.assetKey);
  }
  return out;
}

/** Case (a): every asset-bearing field populated at once. */
const maximalManifest: ProjectManifest = {
  manifestVersion: 1,
  composition: { width: 320, height: 180, fps: 10, aspectRatio: "16:9" },
  scenes: [
    {
      id: "sc-1",
      name: "Alpha",
      scriptText: "In the beginning God created the heaven and the earth.",
      reference: "Genesis 1:1",
      translation: "KJV",
      visualPrompt: "a formless void",
      durationSeconds: 2,
      captions: true,
      visualAssetKey: "projects/p/assets/img-1",
      narrationAssetKey: "projects/p/assets/gen-1-scene-sc-1",
      narrationDurationSeconds: 1.5,
    },
    {
      id: "sc-2",
      name: "Beta",
      scriptText: "And the earth was without form, and void.",
      reference: "Genesis 1:2",
      translation: "KJV",
      visualPrompt: "dark waters",
      durationSeconds: 2,
      captions: true,
      visualAssetKey: "projects/p/assets/img-2",
      narrationAssetKey: "projects/p/assets/gen-1-scene-sc-2",
      narrationDurationSeconds: 3.4,
    },
    {
      id: "sc-3",
      name: "Gamma",
      scriptText: "And God said, Let there be light.",
      reference: "Genesis 1:3",
      translation: "KJV",
      visualPrompt: "first light",
      durationSeconds: 2,
      captions: false,
      visualAssetKey: "projects/p/assets/clip-3",
      visualAssetKind: "video",
    },
  ],
  // In production this coincides with scene 1's clip (`setNarrationAsset` writes scene 1's
  // key while `setSceneNarrationAssets` writes all of them). Given a DISTINCT value here
  // so that "scene 1 happened to work" cannot mask a per-scene omission.
  narratorVoice: { description: "Warm narrator", assetKey: "projects/p/assets/narr-full" },
  music: {
    style: "ambient pads",
    assetKey: "projects/p/assets/music-1",
    durationSeconds: 3,
  },
};

describe("manifestAssetKeys — the generator/materializer pairing", () => {
  it("U-RK1: (a) a maximal manifest emits exactly the keys we expect, and all are materialized", () => {
    const emitted = emittedAssetKeys(generateManifestFiles(maximalManifest));

    // NON-VACUITY. This set is written out LITERALLY, never derived from
    // `manifestAssetKeys`, so a generator that simply stopped emitting per-scene narration
    // could not go green by emitting nothing.
    //
    // `narratorVoice.assetKey` is deliberately ABSENT: once any scene carries its own clip
    // the whole-video track yields (`templates.ts` `legacyNarrationKey`), so the composition
    // never resolves it. `manifestAssetKeys` downloading it anyway is harmless (a superset
    // is safe; a subset is a hard render failure).
    expect(emitted).toEqual(
      new Set([
        "projects/p/assets/img-1",
        "projects/p/assets/img-2",
        "projects/p/assets/clip-3",
        "projects/p/assets/gen-1-scene-sc-1",
        "projects/p/assets/gen-1-scene-sc-2",
        "projects/p/assets/music-1",
      ]),
    );

    // MUTATION GATE: reverting the `if (scene.narrationAssetKey) keys.add(...)` line in
    // `assets.ts` MUST make this assertion RED (both `gen-1-scene-*` keys go unmaterialized).
    const materialized = new Set(manifestAssetKeys(maximalManifest));
    expect([...emitted].filter((k) => !materialized.has(k))).toEqual([]);
  });

  it("U-RK2: (b) a v1/legacy manifest's whole-video narration track is materialized", () => {
    // No per-scene narration anywhere, so `templates.ts` takes the `legacyNarrationKey`
    // branch and emits the whole-project `narratorVoice.assetKey` instead.
    const emitted = emittedAssetKeys(generateManifestFiles(shelterManifest));
    expect(emitted).toEqual(
      new Set([
        "projects/demo/scenes/scene-1.jpg",
        "projects/demo/scenes/scene-2.jpg",
        "projects/demo/narration/full.mp3",
        "projects/demo/music/bed.mp3",
      ]),
    );

    const materialized = new Set(manifestAssetKeys(shelterManifest));
    expect([...emitted].filter((k) => !materialized.has(k))).toEqual([]);
  });

  it("U-RK3: (c) on the render-time synthesis fallback the union covers every emitted key", () => {
    // A manifest with NO cached audio refs at all: `planAudioTrack` returns `synthesize`
    // for both tracks, `ensureAudioOnDisk` writes workspace-local files, and
    // `applyAudioPlans` patches those keys onto the manifest the GENERATOR sees.
    const uncached: ProjectManifest = {
      ...maximalManifest,
      scenes: maximalManifest.scenes.map((scene) => {
        const { narrationAssetKey: _k, narrationDurationSeconds: _d, ...rest } = scene;
        return rest;
      }),
      narratorVoice: { description: "Warm narrator" },
      music: { style: "ambient pads" },
    };
    const plans: AudioPlans = {
      narration: planAudioTrack({
        kind: "narration",
        manifest: uncached,
        modelId: "test/speech",
        hasOpenRouterConnection: true,
      }),
      music: planAudioTrack({
        kind: "music",
        manifest: uncached,
        modelId: "test/music",
        hasOpenRouterConnection: true,
      }),
    };
    expect(plans.narration.action).toBe("synthesize");
    expect(plans.music.action).toBe("synthesize");

    // This is the exact production pairing: `ensureSceneAssets` is fed `ctx.manifest`
    // (`render.ts`), the generator is fed `applyAudioPlans(ctx.manifest, ctx.audioPlans)`.
    const emitted = emittedAssetKeys(
      generateManifestFiles(applyAudioPlans(uncached, plans)),
    );
    const materialized = new Set([
      ...manifestAssetKeys(uncached),
      ...renderAudioKeys(plans),
    ]);
    expect([...emitted].filter((k) => !materialized.has(k))).toEqual([]);

    // ...and the halves really are disjoint — this is WHY the invariant is a union and not
    // "every emitted key appears in `manifestAssetKeys`". These keys name workspace-local
    // files; asking S3 for them would 404.
    const fromPlans = renderAudioKeys(plans);
    expect(fromPlans.size).toBe(4); // 3 scenes + 1 bed
    for (const key of manifestAssetKeys(uncached)) {
      expect(fromPlans.has(key), `${key} must not be an S3 download`).toBe(false);
    }
    expect([...fromPlans].filter((k) => emitted.has(k)).length).toBe(4);
  });
});
