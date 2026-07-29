import { describe, expect, it } from "vitest";
import type { ProjectManifest } from "@supagloo/database-lib";
import { canonicalizeManifest, serializeManifest } from "./manifest-json";

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

const baseManifest: ProjectManifest = {
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
    const manifest: ProjectManifest = {
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
    const manifest: ProjectManifest = {
      ...baseManifest,
      aiSettings: { image: { provider: "gloo" as const } },
    };
    const out = canonicalizeManifest(manifest);
    expect(out.aiSettings).toEqual({ image: { provider: "gloo" } });
    expect(Object.keys(out.aiSettings as object)).toEqual(["image"]);
  });

  it("U-AS4d: faithAlignment alone survives (it is independent of any model choice)", () => {
    const manifest: ProjectManifest = {
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
      aiSettings: ProjectManifest["aiSettings"],
    ): ProjectManifest => ({ ...baseManifest, aiSettings });

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
    const manifest: ProjectManifest = {
      ...baseManifest,
      aiSettings: { narration: { provider: "openrouter" } },
    };
    const out = canonicalizeManifest(manifest);
    expect(out.aiSettings).toEqual({ narration: { provider: "openrouter" } });
  });
});

// ---------------------------------------------------------------------------
// Feature 1 + Feature 2 — the two new manifest fields cross this SAME mirror
// ---------------------------------------------------------------------------
//
// Identical argument to U-AS4 above, applied to `narratorVoice.voiceId` (the user's
// chosen narrator, feature 1) and `scripture` (the project's origin passage picked in
// the new-project wizard, feature 2). A field this function does not WRITE is erased on
// every commit — and for `voiceId` that would restore the exact bug being fixed one
// commit later, with the studio still displaying the choice it had already lost.
//
// Both are read through a locally-declared FORWARD type because this repo's
// `@supagloo/database-lib` is the nested submodule, pinned until the release step. The
// reads are structural over a plain JSON object, so the runtime behaviour is correct
// today. DELETE THE FORWARD TYPE AT THE db-lib BUMP.
interface ForwardManifest {
  narratorVoice: { voiceId?: string };
  scripture?: {
    reference: string;
    translation: string;
    language?: string;
    passageId?: string;
  };
}
const forwardAs = (m: ProjectManifest, extra: ForwardManifest): ProjectManifest =>
  ({
    ...m,
    ...extra,
    narratorVoice: { ...m.narratorVoice, ...extra.narratorVoice },
  }) as ProjectManifest;

describe("canonicalizeManifest — narratorVoice.voiceId (feature 1)", () => {
  it("U-V7: the chosen voice id survives canonicalization", () => {
    const manifest = forwardAs(baseManifest, { narratorVoice: { voiceId: "zac" } });
    const out = canonicalizeManifest(manifest);
    expect((out.narratorVoice as Record<string, unknown>).voiceId).toBe("zac");
  });

  it("U-V8: a manifest without one does not gain the key", () => {
    const out = canonicalizeManifest(baseManifest);
    expect("voiceId" in (out.narratorVoice as object)).toBe(false);
  });

  it("U-V9: voiceId is emitted AFTER description/label/assetKey — fixed key order", () => {
    const manifest = forwardAs(baseManifest, {
      narratorVoice: { voiceId: "zac" },
    });
    const withAll = {
      ...manifest,
      narratorVoice: {
        ...manifest.narratorVoice,
        label: "JEJ-STYLE",
        assetKey: "projects/p/narration.mp3",
      },
    };
    expect(Object.keys(canonicalizeManifest(withAll).narratorVoice as object)).toEqual([
      "description",
      "label",
      "assetKey",
      "voiceId",
    ]);
  });
});

describe("canonicalizeManifest — scripture (feature 2)", () => {
  const scripture = {
    reference: "Psalm 121",
    translation: "ASV",
    language: "en",
    passageId: "PSA.121",
  };

  it("U-W10: the origin passage survives canonicalization intact", () => {
    const out = canonicalizeManifest(
      forwardAs(baseManifest, { narratorVoice: {}, scripture }),
    );
    expect(out.scripture).toEqual(scripture);
  });

  it("U-W11: a manifest without one does not gain the key", () => {
    expect("scripture" in canonicalizeManifest(baseManifest)).toBe(false);
  });

  it("U-W12: the optional halves stay absent rather than materializing as undefined", () => {
    const out = canonicalizeManifest(
      forwardAs(baseManifest, {
        narratorVoice: {},
        scripture: { reference: "Psalm 121", translation: "ASV" },
      }),
    );
    expect(out.scripture).toEqual({ reference: "Psalm 121", translation: "ASV" });
    expect(Object.keys(out.scripture as object)).toEqual(["reference", "translation"]);
  });

  it("U-W13: scripture is emitted in a FIXED key order regardless of input order", () => {
    const reversed = {
      passageId: "PSA.121",
      language: "en",
      translation: "ASV",
      reference: "Psalm 121",
    };
    const out = canonicalizeManifest(
      forwardAs(baseManifest, { narratorVoice: {}, scripture: reversed }),
    );
    expect(Object.keys(out.scripture as object)).toEqual([
      "reference",
      "translation",
      "language",
      "passageId",
    ]);
  });

  it("U-W14: serializeManifest emits both new fields as stable JSON text", () => {
    const text = serializeManifest(
      forwardAs(baseManifest, { narratorVoice: { voiceId: "zac" }, scripture }),
    );
    expect(text).toContain('"voiceId": "zac"');
    expect(text).toContain('"passageId": "PSA.121"');
    expect(text.endsWith("\n")).toBe(true);
  });
});
