import { describe, it, expect } from "vitest";
import { buildSpeechArgs } from "./synthesize";
import type { AudioRequest } from "./request";

// Pure builder: parsed AudioRequest → requestSpeech args (design-delta §7 workflow 7,
// decisions D2/D5). narration concatenates the per-scene scripts into one input + a fixed valid
// voice enum; music sends the style label as the input with NO voice. Both stream chat-audio
// pcm16 (the media client sets modalities/stream/format — the builder no longer picks a format).

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
  });

  it("uses a fixed valid provider voice enum (the freeform descriptor is not a valid voice id)", () => {
    expect(buildSpeechArgs(narration).voice).toBe("alloy");
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

  it("sends the style label as the input, with NO voice (music uses no TTS voice)", () => {
    const args = buildSpeechArgs(music);
    expect(args.modelId).toBe("resolved/music-model");
    expect(args.input).toBe("Swelling strings");
    expect(args.voice).toBeUndefined();
  });
});
