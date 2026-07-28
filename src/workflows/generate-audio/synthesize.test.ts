import { describe, it, expect } from "vitest";
import { buildNarrationSceneArgs, buildMusicArgs } from "./synthesize";
import type { AudioRequest } from "./request";

/**
 * Pure builders: parsed `AudioRequest` → provider-call args.
 *
 * Narration now produces ONE args object PER SCENE rather than one concatenated blob. The
 * old builder joined every scene's script with `\n\n` into a single synthesis call, which
 * made per-scene sync impossible by construction: one asset, no scene boundaries, nothing
 * for the composition to align to a `<Sequence>`.
 *
 * Music stays a single call (one bed for the whole video) and deliberately carries no
 * duration — verified live, no music model on OpenRouter accepts one.
 */

const narration: AudioRequest = {
  kind: "narration",
  userId: "u1",
  model: "resolved/speech-model",
  projectId: "proj-1",
  input: {
    voice: { description: "warm, weathered baritone", label: "JEJ-STYLE" },
    scenes: [
      { sceneId: "s1", scriptText: "In the beginning God created the heaven and the earth." },
      { sceneId: "s2", scriptText: "And the earth was without form, and void." },
    ],
  },
};

describe("buildNarrationSceneArgs", () => {
  it("U-S1: emits one synthesis call per scene, each carrying ONLY that scene's verse", () => {
    const args = buildNarrationSceneArgs(narration);
    expect(args).toHaveLength(2);
    expect(args[0]).toEqual({
      sceneId: "s1",
      speech: {
        modelId: "resolved/speech-model",
        input: "In the beginning God created the heaven and the earth.",
        voice: "alloy",
      },
    });
    expect(args[1].sceneId).toBe("s2");
    expect(args[1].speech.input).toBe("And the earth was without form, and void.");
  });

  it("U-S2: never concatenates scenes — the old single-blob input is gone", () => {
    // The concatenated form is what made scene-synced narration unexpressible: one asset for
    // the whole project, with no way to know where scene 2's audio began.
    for (const a of buildNarrationSceneArgs(narration)) {
      expect(a.speech.input).not.toContain("\n\n");
    }
  });

  it("U-S3: preserves scene ORDER, which is what makes the DBOS step sequence replay-safe", () => {
    // The workflow runs one step per entry. DBOS requires the same steps in the same order on
    // replay, so this array must be a deterministic function of the checkpointed request.
    expect(buildNarrationSceneArgs(narration).map((a) => a.sceneId)).toEqual(["s1", "s2"]);
    expect(buildNarrationSceneArgs(narration)).toEqual(buildNarrationSceneArgs(narration));
  });

  it("U-S4: uses a valid provider voice id, not the freeform manifest descriptor", () => {
    // "JEJ-STYLE" is a human-readable label, not a provider voice enum; the live endpoint
    // rejects an unknown voice by name.
    for (const a of buildNarrationSceneArgs(narration)) {
      expect(a.speech.voice).toBe("alloy");
      expect(a.speech.voice).not.toContain("JEJ");
    }
  });
});

describe("buildMusicArgs", () => {
  const music: AudioRequest = {
    kind: "music",
    userId: "u1",
    model: "resolved/music-model",
    projectId: "proj-1",
    input: { style: "Swelling strings", durationSeconds: 30 },
  };

  it("U-S5: sends the style label as the input and nothing else", () => {
    // `durationSeconds` is accepted on the request (the studio computes it) but is NOT
    // forwarded: verified live, `supported_parameters` for both Lyria models is
    // ["max_tokens","response_format","seed","temperature","top_p"]. Covering the video is
    // the composition's job (it loops the measured bed), not the provider's.
    expect(buildMusicArgs(music)).toEqual({
      modelId: "resolved/music-model",
      input: "Swelling strings",
    });
  });
});
