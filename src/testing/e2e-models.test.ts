import { describe, it, expect } from "vitest";
import {
  selectAudioModel,
  selectCheapestImageModel,
  selectCheapestStructuredTextModel,
  selectTextToVideoModel,
  toAudioModelInfo,
  toModelInfo,
  toVideoModelInfo,
  type AudioModelInfo,
  type OpenRouterModelInfo,
  type VideoModelInfo,
} from "./e2e-models";

// Unit proof of the discovery model resolution (design-delta §10.9). No hardcoded id.

describe("toModelInfo", () => {
  it("normalizes the raw /api/v1/models shape (prices/modalities/params)", () => {
    const info = toModelInfo({
      id: "vendor/x",
      pricing: { prompt: "0.0000005", image: "0.01" },
      architecture: { output_modalities: ["text"] },
      supported_parameters: ["response_format", "structured_outputs"],
    });
    expect(info).toEqual({
      id: "vendor/x",
      promptPrice: 0.0000005,
      imagePrice: 0.01,
      outputModalities: ["text"],
      supportedParameters: ["response_format", "structured_outputs"],
    });
  });

  it("is tolerant of missing fields", () => {
    expect(toModelInfo({})).toEqual({
      id: "",
      promptPrice: NaN,
      imagePrice: NaN,
      outputModalities: [],
      supportedParameters: [],
    });
  });
});

describe("selectCheapestStructuredTextModel (text — ADEQUATE = structured-output-capable)", () => {
  const m = (
    id: string,
    promptPrice: number,
    outputModalities: string[],
    supportedParameters: string[],
  ): OpenRouterModelInfo => ({
    id,
    promptPrice,
    imagePrice: NaN,
    outputModalities,
    supportedParameters,
  });

  it("picks the cheapest text model that supports structured_outputs", () => {
    const models = [
      m("vendor/expensive", 0.00001, ["text"], ["structured_outputs"]),
      m("vendor/cheap-free", 0, ["text"], ["structured_outputs", "response_format"]),
      m("vendor/mid", 0.000005, ["text"], ["structured_outputs"]),
    ];
    expect(selectCheapestStructuredTextModel(models)).toBe("vendor/cheap-free");
  });

  it("excludes text models WITHOUT structured_outputs (not adequate for generateObject)", () => {
    const models = [
      m("vendor/no-structured-free", 0, ["text"], ["response_format"]),
      m("vendor/structured-paid", 0.000001, ["text"], ["structured_outputs"]),
    ];
    expect(selectCheapestStructuredTextModel(models)).toBe("vendor/structured-paid");
  });

  it("excludes variable/auto-priced (negative) entries so the pick is cost-known", () => {
    const models = [
      m("openrouter/auto", -1, ["text"], ["structured_outputs"]),
      m("vendor/concrete", 0.000002, ["text"], ["structured_outputs"]),
    ];
    expect(selectCheapestStructuredTextModel(models)).toBe("vendor/concrete");
  });

  it("excludes non-text-output models", () => {
    const models = [
      m("vendor/image-only", 0, ["image"], ["structured_outputs"]),
      m("vendor/text", 0.000003, ["text"], ["structured_outputs"]),
    ];
    expect(selectCheapestStructuredTextModel(models)).toBe("vendor/text");
  });

  it("throws an actionable error when no structured-capable text model qualifies", () => {
    expect(() =>
      selectCheapestStructuredTextModel([m("vendor/x", 0, ["text"], ["response_format"])]),
    ).toThrow(/structured-output-capable/i);
  });
});

describe("selectCheapestImageModel (image — must have a CONCRETE POSITIVE price; free tier 500s)", () => {
  const im = (
    id: string,
    imagePrice: number,
    outputModalities: string[] = ["image"],
  ): OpenRouterModelInfo => ({
    id,
    promptPrice: NaN,
    imagePrice,
    outputModalities,
    supportedParameters: [],
  });

  it("picks the cheapest image model with a concrete positive image price", () => {
    const models = [
      im("vendor/free", 0), // free tier — excluded (500s live)
      im("vendor/nan", NaN), // unpriced — excluded
      im("vendor/pricey", 0.01),
      im("vendor/cheap", 0.0000003),
    ];
    expect(selectCheapestImageModel(models)).toBe("vendor/cheap");
  });

  it("excludes non-image-output models", () => {
    const models = [
      im("vendor/textonly", 0.0000001, ["text"]),
      im("vendor/img", 0.0000005, ["image"]),
    ];
    expect(selectCheapestImageModel(models)).toBe("vendor/img");
  });

  it("throws when no priced image model qualifies", () => {
    expect(() => selectCheapestImageModel([im("vendor/free", 0)])).toThrow(/image model/i);
  });
});

describe("toAudioModelInfo / selectAudioModel (narration=TTS, music=Lyria)", () => {
  it("classifies music from the id/description, TTS otherwise", () => {
    expect(toAudioModelInfo({ id: "google/lyria-3-clip", pricing: { audio: "0" } }).isMusic).toBe(
      true,
    );
    expect(
      toAudioModelInfo({
        id: "openai/gpt-audio-mini",
        description: "OpenAI audio model",
        pricing: { audio: "0.0000006" },
      }).isMusic,
    ).toBe(false);
  });

  const a = (id: string, audioPrice: number, isMusic: boolean): AudioModelInfo => ({
    id,
    audioPrice,
    isMusic,
  });

  it("narration → cheapest non-music (TTS) model", () => {
    const models = [
      a("google/lyria-3-clip", 0, true),
      a("openai/gpt-audio", 0.000032, false),
      a("openai/gpt-audio-mini", 0.0000006, false),
    ];
    expect(selectAudioModel(models, "narration")).toBe("openai/gpt-audio-mini");
  });

  it("music → cheapest music model; ties broken by id (prefers 'clip' over 'pro')", () => {
    const models = [
      a("openai/gpt-audio-mini", 0.0000006, false),
      a("google/lyria-3-pro-preview", 0, true),
      a("google/lyria-3-clip-preview", 0, true),
    ];
    expect(selectAudioModel(models, "music")).toBe("google/lyria-3-clip-preview");
  });

  it("throws when no model matches the kind", () => {
    expect(() => selectAudioModel([a("openai/gpt-audio", 0, false)], "music")).toThrow(
      /music/i,
    );
  });
});

describe("toVideoModelInfo", () => {
  it("marks a model text-to-video only when its description advertises it", () => {
    expect(
      toVideoModelInfo({
        id: "vendor/t2v",
        description: "A text-to-video model.",
        supported_durations: [2, 4, 6],
      }),
    ).toEqual({ id: "vendor/t2v", supportedDurations: [2, 4, 6], isTextToVideo: true });
    expect(
      toVideoModelInfo({
        id: "vendor/i2v",
        description: "An image-to-video generation model.",
        supported_durations: [1],
      }).isTextToVideo,
    ).toBe(false);
  });
});

describe("selectTextToVideoModel (video — must be text-to-video capable, min duration)", () => {
  const v = (
    id: string,
    supportedDurations: number[],
    isTextToVideo: boolean,
  ): VideoModelInfo => ({ id, supportedDurations, isTextToVideo });

  it("picks the text-to-video model with the smallest supported duration (cost)", () => {
    const models = [
      v("vendor/i2v", [1], false), // image-to-video only — excluded (would 400 the text submit)
      v("vendor/t2v-long", [8, 12], true),
      v("vendor/t2v-short", [2, 4], true),
    ];
    expect(selectTextToVideoModel(models)).toEqual({
      id: "vendor/t2v-short",
      minDurationSeconds: 2,
    });
  });

  it("throws when every discovered video model is image-to-video only", () => {
    expect(() =>
      selectTextToVideoModel([v("vendor/i2v", [1], false)]),
    ).toThrow(/text-to-video/i);
  });
});
