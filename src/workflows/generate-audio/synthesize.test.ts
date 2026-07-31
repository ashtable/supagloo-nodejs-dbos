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

/** The same request with the studio's CHOSEN voice attached (feature 1). */
const narrationWithVoice: AudioRequest = {
  ...narration,
  input: {
    ...(narration.input as Extract<AudioRequest, { kind: "narration" }>["input"]),
    voiceId: "zac",
  } as Extract<AudioRequest, { kind: "narration" }>["input"],
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
        // MOVED: this read `"alloy"`, the shipped `DEFAULT_NARRATION_VOICE`. This fixture
        // chose no voice, and resolving that now belongs to `requestSpeech` — the one
        // place that reads the model's own published vocabulary. See U-S4b.
        voice: undefined,
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

  // ── Feature 1 ──────────────────────────────────────────────────────────────
  //
  // U-S4 USED TO ASSERT `expect(a.speech.voice).toBe("alloy")` unconditionally. That
  // assertion pinned the BUG: the user's chosen narrator voice reached this builder and
  // was thrown away, so every project narrated in the same default voice however the
  // studio was configured. The rule the test meant to protect — "never send the freeform
  // PROSE descriptor as a provider voice id" — is real and is kept below; what changes is
  // that a real provider voice ID, when the studio chose one, is now honoured.

  it("U-S4: sends the CHOSEN provider voice id when the studio picked one", () => {
    for (const a of buildNarrationSceneArgs(narrationWithVoice)) {
      expect(a.speech.voice).toBe("zac");
    }
  });

  it("U-S4b: leaves the voice UNSET when no id was chosen — it does not pick one here", () => {
    // MOVED. This used to assert `"alloy"`, the shipped `DEFAULT_NARRATION_VOICE`, which
    // is not one of `hexgrad/kokoro-82m`'s 54 voices at all. It only ever worked through
    // an undocumented OpenAI→Kokoro alias layer, and on a model that does not alias it is
    // a hard 400 that fails the entire generation.
    //
    // Absent stays a real state (every manifest committed before the picker existed), but
    // resolving it belongs at the ONE place that knows the model's own vocabulary —
    // `requestSpeech`, which reads `supported_voices` from the provider. A builder that
    // substituted an id here would be asserting a voice for a model it never asked about,
    // which is the whole bug.
    for (const a of buildNarrationSceneArgs(narration)) {
      expect(a.speech.voice).toBeUndefined();
    }
  });

  it("U-S4c: NEVER sends the freeform descriptor or label as a voice id", () => {
    // "JEJ-STYLE" / "warm, weathered baritone" are human-readable prose, not a provider
    // voice enum; the live endpoint rejects an unknown voice by name. This holds whether
    // or not a real id was chosen — the prose has no channel in the request body at all
    // (`requestSpeech` sends exactly {model, input, voice, response_format}).
    for (const req of [narration, narrationWithVoice]) {
      for (const a of buildNarrationSceneArgs(req)) {
        // The guard is what does the work: `undefined` satisfying a `not.toContain` would
        // pass for the wrong reason on the fixture that chose nothing, so the prose check
        // only runs on the arm that has a value. (An `is string || is undefined`
        // disjunction used to sit here as well; `RequestSpeechArgs.voice` is typed
        // `string | undefined`, so it could not fail for any value the type admits.)
        if (typeof a.speech.voice === "string") {
          expect(a.speech.voice).not.toContain("JEJ");
          expect(a.speech.voice).not.toContain("baritone");
        }
      }
    }
    // …and the fixture that DID choose one really does reach the guard's live arm, so the
    // check above is not vacuous.
    expect(buildNarrationSceneArgs(narrationWithVoice)[0].speech.voice).toBe("zac");
  });

  it("U-S4d: an id chosen for one scene is used for EVERY scene — one narrator per video", () => {
    const voices = buildNarrationSceneArgs(narrationWithVoice).map((a) => a.speech.voice);
    expect(voices).toEqual(["zac", "zac"]);
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
