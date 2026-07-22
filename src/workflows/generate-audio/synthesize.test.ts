import { describe, it, expect } from "vitest";
import { buildSpeechArgs } from "./synthesize";
import type { AudioRequest } from "./request";

// Pure builder: parsed AudioRequest → requestSpeech args (design-delta §7 workflow 7,
// decisions D2/D5). narration concatenates the per-scene scripts into one input + maps the
// voice descriptor; music sends the style label as the input. Both request mp3.

describe("buildSpeechArgs — narration", () => {
  const narration: AudioRequest = {
    kind: "narration",
    userId: "u1",
    model: "resolved/speech-model",
    projectId: "proj-1",
    input: {
      voice: { description: "warm, weathered baritone", label: "JEJ-STYLE" },
      scenes: [
        { sceneId: "s1", scriptText: "In the beginning" },
        { sceneId: "s2", scriptText: "was the Word." },
      ],
    },
  };

  it("concatenates the per-scene scripts in array order into one input", () => {
    const args = buildSpeechArgs(narration);
    expect(args.modelId).toBe("resolved/speech-model");
    expect(args.input).toBe("In the beginning\n\nwas the Word.");
    expect(args.format).toBe("mp3");
  });

  it("uses the voice label as the provider voice hint when present", () => {
    expect(buildSpeechArgs(narration).voice).toBe("JEJ-STYLE");
  });

  it("falls back to the freeform voice description when there is no label", () => {
    const noLabel: AudioRequest = {
      ...narration,
      input: {
        voice: { description: "warm, weathered baritone" },
        scenes: narration.kind === "narration" ? narration.input.scenes : [],
      },
    };
    expect(buildSpeechArgs(noLabel).voice).toBe("warm, weathered baritone");
  });
});

describe("buildSpeechArgs — music", () => {
  const music: AudioRequest = {
    kind: "music",
    userId: "u1",
    model: "resolved/music-model",
    projectId: "proj-1",
    input: { style: "Swelling strings", durationSeconds: 30 },
  };

  it("sends the style label as the input, mp3, no voice", () => {
    const args = buildSpeechArgs(music);
    expect(args.modelId).toBe("resolved/music-model");
    expect(args.input).toBe("Swelling strings");
    expect(args.format).toBe("mp3");
    expect(args.voice).toBeUndefined();
  });
});
