import { describe, it, expect } from "vitest";
import { buildVideoSubmitInput } from "./submit";
import type { VideoRequest } from "./request";

// Pure builder: parsed (camelCase, domain) video input → the OpenRouter POST /api/v1/videos
// body fields (snake_case). Mirrors generateAudio's buildSpeechArgs. `model` is passed
// separately (submitVideoJob's modelId), so this covers only the spread `input` fields.

function request(input: VideoRequest["input"]): VideoRequest {
  return { kind: "video", userId: "u1", model: "resolved/video-model", projectId: "p1", input };
}

describe("buildVideoSubmitInput", () => {
  it("always emits the prompt and omits absent optionals (no undefined keys)", () => {
    const body = buildVideoSubmitInput(request({ prompt: "a dove descends" }));
    expect(body).toEqual({ prompt: "a dove descends" });
    expect(Object.keys(body)).toEqual(["prompt"]);
  });

  it("maps camelCase domain fields to OpenRouter snake_case", () => {
    const body = buildVideoSubmitInput(
      request({
        prompt: "a dove descends over still water",
        durationSeconds: 6,
        resolution: "1280x720",
        aspectRatio: "9:16",
        frameImages: ["projects/p/assets/a"],
        generateAudio: true,
        seed: 42,
      }),
    );
    expect(body).toEqual({
      prompt: "a dove descends over still water",
      duration: 6,
      resolution: "1280x720",
      aspect_ratio: "9:16",
      frame_images: ["projects/p/assets/a"],
      generate_audio: true,
      seed: 42,
    });
  });

  it("preserves generate_audio:false (a present boolean, not an absent optional)", () => {
    const body = buildVideoSubmitInput(request({ prompt: "x", generateAudio: false }));
    expect(body).toEqual({ prompt: "x", generate_audio: false });
  });

  it("preserves seed:0 (a present zero, not an absent optional)", () => {
    const body = buildVideoSubmitInput(request({ prompt: "x", seed: 0 }));
    expect(body).toEqual({ prompt: "x", seed: 0 });
  });
});
