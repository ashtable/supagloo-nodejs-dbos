import { describe, expect, it } from "vitest";
import {
  canonicalizeManifest,
  serializeManifest,
  type ManifestWithAiSettings,
} from "./manifest-json";

/**
 * U-AS4 — `aiSettings` survives canonicalization.
 *
 * This is the third of the four mirrors, and it is the one that fails SILENTLY. The
 * invariant `manifest-json.ts` records in prose is: *a field the rest of the system reads
 * but `canonicalizeManifest` does not write is erased on every commit*. That is not a
 * hypothetical — it already happened to `narratorVoice.assetKey`, and the consequence was
 * that every render of a committed version re-synthesized narration through a live TTS
 * provider, i.e. real money, silently, forever.
 *
 * The genesis-1 Inspector's whole point is that the user's provider/model/faith-alignment
 * choices persist. Without this branch they would appear to save, survive until the next
 * commit, and then quietly revert to the system defaults — which is worse than not saving
 * at all, because the user would have no reason to look.
 *
 * `canonicalizeManifest` rebuilds the object in a FIXED field order with `undefined`
 * optionals omitted, so both halves are asserted: the values survive, AND absence stays
 * absence (a materialized `undefined` key would break the byte-stable on-disk form and
 * the nextjs adapter's round-trip identity).
 */

const baseManifest: ManifestWithAiSettings = {
  manifestVersion: 1 as const,
  composition: { width: 1080, height: 1920, fps: 30, aspectRatio: "9:16" },
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
    },
  ],
  narratorVoice: { description: "warm, weathered baritone" },
};

describe("canonicalizeManifest — aiSettings (U-AS4)", () => {
  it("U-AS4a: a manifest WITHOUT aiSettings does not gain the key", () => {
    const out = canonicalizeManifest(baseManifest);
    expect("aiSettings" in out).toBe(false);
  });

  it("U-AS4b: a FULL aiSettings block survives canonicalization intact", () => {
    const manifest: ManifestWithAiSettings = {
      ...baseManifest,
      aiSettings: {
        faithAlignment: "catholic" as const,
        image: { provider: "gloo" as const, model: "vendor-image-model" },
        narration: { provider: "openrouter" as const, model: "vendor/speech-model" },
        music: { provider: "openrouter" as const, model: "vendor/music-model" },
        video: { provider: "openrouter" as const, model: "vendor/video-model" },
      },
    };
    const out = canonicalizeManifest(manifest);
    expect(out.aiSettings).toEqual(manifest.aiSettings);

    // …and the SERIALIZED file — the exact bytes the git commit carries — still round
    // trips. Deliberately asserted against `JSON.parse` rather than against db-lib's
    // `ProjectManifestSchema`: this module's job is canonicalization, and the schema's
    // acceptance of `aiSettings` is db-lib's own claim, pinned there by U-AS2. Coupling
    // this test to the schema would also make it a hostage to the submodule pin.
    expect(JSON.parse(serializeManifest(manifest))).toEqual(manifest);
  });

  it("U-AS4c: a PARTIAL aiSettings keeps only the keys that were set", () => {
    // The common shape: the user picked a provider for images and nothing else. An
    // over-eager canonicalizer that materialized every kind would write four objects the
    // user never chose, and the studio would then read them back as deliberate choices.
    const manifest: ManifestWithAiSettings = {
      ...baseManifest,
      aiSettings: { image: { provider: "gloo" as const } },
    };
    const out = canonicalizeManifest(manifest);
    expect(out.aiSettings).toEqual({ image: { provider: "gloo" } });
    expect(Object.keys(out.aiSettings as object)).toEqual(["image"]);
  });

  it("U-AS4d: faithAlignment alone survives (it is independent of any model choice)", () => {
    const manifest: ManifestWithAiSettings = {
      ...baseManifest,
      aiSettings: { faithAlignment: "mainline" as const },
    };
    expect(canonicalizeManifest(manifest).aiSettings).toEqual({
      faithAlignment: "mainline",
    });
  });

  it("U-AS4e: aiSettings is emitted in a FIXED key order regardless of input order", () => {
    // Byte stability is the whole contract of this module: a commit that reorders keys
    // produces a spurious diff in the user's repo on every save.
    const withSettings = (
      aiSettings: ManifestWithAiSettings["aiSettings"],
    ): ManifestWithAiSettings => ({ ...baseManifest, aiSettings });

    const forward = canonicalizeManifest(
      withSettings({
        faithAlignment: "catholic",
        image: { provider: "gloo" },
        video: { provider: "openrouter" },
      }),
    );
    const reversed = canonicalizeManifest(
      // Same content, deliberately different insertion order.
      withSettings({
        video: { provider: "openrouter" },
        image: { provider: "gloo" },
        faithAlignment: "catholic",
      }),
    );
    expect(JSON.stringify(forward)).toBe(JSON.stringify(reversed));
    expect(Object.keys(forward.aiSettings as object)).toEqual([
      "faithAlignment",
      "image",
      "video",
    ]);
  });

  it("U-AS4f: a model-less choice does not gain an empty `model` key", () => {
    const manifest: ManifestWithAiSettings = {
      ...baseManifest,
      aiSettings: { narration: { provider: "openrouter" } },
    };
    const out = canonicalizeManifest(manifest);
    expect(out.aiSettings).toEqual({ narration: { provider: "openrouter" } });
  });
});
