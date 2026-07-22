import { describe, it, expect } from "vitest";
import { parseAudioRequest, type AudioRequestRow } from "./request";
import { GenerationRequestInvalidError } from "./errors";

// Pure validator/dispatcher for the audio-generation request row (design-delta §7 workflow 7).
// ONE workflow, BOTH audio kinds — narration validates against the voice+scenes spec, music
// against the style+duration spec. Bad kind / non-openrouter provider / missing project /
// malformed input are all PERMANENT GenerationRequestInvalidError (the workflow marks the row
// failed, no retry). No DB, no DBOS — just the row → typed request mapping.

const NARRATION_INPUT = {
  voice: { description: "warm, weathered baritone", label: "JEJ-STYLE" },
  scenes: [
    { sceneId: "s1", scriptText: "I am the voice of one" },
    { sceneId: "s2", scriptText: "crying in the wilderness" },
  ],
};
const MUSIC_INPUT = { style: "Swelling strings", durationSeconds: 30 };

function row(overrides: Partial<AudioRequestRow>): AudioRequestRow {
  return {
    userId: "u1",
    kind: "narration",
    provider: "openrouter",
    model: "resolved/speech-model",
    projectId: "proj-1",
    input: NARRATION_INPUT,
    ...overrides,
  };
}

describe("parseAudioRequest", () => {
  it("parses a valid narration row into a typed narration request", () => {
    const req = parseAudioRequest(row({}));
    expect(req.kind).toBe("narration");
    expect(req).toMatchObject({
      userId: "u1",
      model: "resolved/speech-model",
      projectId: "proj-1",
    });
    if (req.kind === "narration") {
      expect(req.input.scenes).toHaveLength(2);
      expect(req.input.voice.label).toBe("JEJ-STYLE");
    }
  });

  it("parses a valid music row into a typed music request", () => {
    const req = parseAudioRequest(
      row({ kind: "music", model: "resolved/music-model", input: MUSIC_INPUT }),
    );
    expect(req.kind).toBe("music");
    if (req.kind === "music") {
      expect(req.input.style).toBe("Swelling strings");
      expect(req.input.durationSeconds).toBe(30);
    }
  });

  it("rejects a kind this workflow does not handle (e.g. image)", () => {
    expect(() => parseAudioRequest(row({ kind: "image" }))).toThrow(
      GenerationRequestInvalidError,
    );
  });

  it("rejects a non-openrouter provider (defense-in-depth on the 422 matrix)", () => {
    expect(() => parseAudioRequest(row({ provider: "gloo" }))).toThrow(
      GenerationRequestInvalidError,
    );
  });

  it("rejects a project-less audio generation (an audio asset has nowhere to live)", () => {
    expect(() => parseAudioRequest(row({ projectId: null }))).toThrow(
      GenerationRequestInvalidError,
    );
  });

  it("rejects a narration row whose input has no scenes", () => {
    expect(() =>
      parseAudioRequest(
        row({ input: { voice: { description: "x" }, scenes: [] } }),
      ),
    ).toThrow(GenerationRequestInvalidError);
  });

  it("rejects a narration row missing the voice descriptor", () => {
    expect(() =>
      parseAudioRequest(row({ input: { scenes: NARRATION_INPUT.scenes } })),
    ).toThrow(GenerationRequestInvalidError);
  });

  it("rejects a music row with a non-positive duration", () => {
    expect(() =>
      parseAudioRequest(
        row({ kind: "music", input: { style: "ambient", durationSeconds: 0 } }),
      ),
    ).toThrow(GenerationRequestInvalidError);
  });

  it("rejects a music row missing the style", () => {
    expect(() =>
      parseAudioRequest(row({ kind: "music", input: { durationSeconds: 12 } })),
    ).toThrow(GenerationRequestInvalidError);
  });
});
