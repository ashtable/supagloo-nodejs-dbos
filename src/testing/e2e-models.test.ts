import { describe, it, expect } from "vitest";
import {
  selectAudioModel,
  selectCheapestImageModel,
  selectCheapestStructuredTextModel,
  selectGlooChatModel,
  selectGlooImageModel,
  selectTextToVideoModel,
  toAudioModelInfo,
  toGlooModelInfo,
  toModelInfo,
  toVideoModelInfo,
  type AudioModelInfo,
  type GlooModelInfo,
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

// Task 34-E8: the reworked providers.e2e.ts exercises a REAL Gloo `.chat()` round-trip and
// must resolve the Gloo model id at run time (§10.9 — never hardcode). Gloo exposes an
// authenticated model catalogue at `GET {GLOO_BASE_URL}/platform/v2/models` (nextjs CLAUDE.md),
// ids namespaced like `gloo-openai-gpt-5-mini`. Gloo's catalogue carries no reliable pricing
// metadata, so "cheapest ADEQUATE" degrades to a cheap-tier id heuristic (mini/nano/…), with a
// safe fallback to the first catalogue entry — a runtime pick, not a hardcode.
describe("toGlooModelInfo", () => {
  it("reads the id, modalities and REAL per-1k pricing off a raw catalogue entry", () => {
    // Every one of Gloo's 106 catalogue entries carries `output_modalities` and a
    // `pricing` block with decimal-STRING rates (measured live 2026-07-28). The rates are
    // per 1k tokens; the normalizer converts to per-token so it is comparable with
    // OpenRouter's, which is already per-token.
    const info = toGlooModelInfo({
      id: "gloo-vendor-chat-mini",
      output_modalities: ["text"],
      pricing: {
        input: { rate_per_1k_tokens: "0.000100" },
        output: { rate_per_1k_tokens: "0.000400" },
      },
    });
    expect(info.id).toBe("gloo-vendor-chat-mini");
    expect(info.outputModalities).toEqual(["text"]);
    // Compared with a tolerance: the per-1k -> per-token division is binary floating
    // point, so an exact-equality assertion here would be pinning IEEE-754 rounding, not
    // the conversion rule.
    expect(info.inputTokenPrice).toBeCloseTo(0.0000001, 12);
    expect(info.outputTokenPrice).toBeCloseTo(0.0000004, 12);
  });

  it("is tolerant of a missing/non-string id and of absent metadata", () => {
    expect(toGlooModelInfo({})).toEqual({ id: "", outputModalities: [] });
    expect(toGlooModelInfo({ id: 42 })).toEqual({ id: "", outputModalities: [] });
  });

  it("keeps an image-only entry distinguishable from a text one", () => {
    const info = toGlooModelInfo({
      id: "gloo-vendor-flux",
      output_modalities: ["image"],
      pricing: { output: { rate_per_1k_tokens: "0.004560" } },
    });
    expect(info.outputModalities).toEqual(["image"]);
    expect(info.outputTokenPrice).toBeCloseTo(0.00000456, 12);
  });
});

describe("selectGlooChatModel (U-EM1 — text-capable, cheapest by REAL price)", () => {
  /**
   * REWRITTEN 2026-07-28. The previous implementation picked the first id matching
   * `mini|nano|small|lite|flash|haiku` and, failing that, the first catalogue entry. Two
   * facts measured against the live host on 2026-07-28 made that unsafe:
   *
   *  1. **Four IMAGE models now match that substring filter.** Gloo's catalogue carries
   *     11 image-capable models, several of them "flash"/"mini"-tiered. An image model
   *     handed to `.chat()` answers 400 — "does not support text output and cannot be
   *     used with the Chat Completions API" — so the e2e would fail for a reason that
   *     looks like a broken provider. It has been safe only by ACCIDENT: those entries
   *     sit at catalogue indices 93-103 while index 0 happens to be a cheap text model.
   *     A catalogue reorder breaks it, and Gloo controls that order.
   *  2. **Pricing is present on 106/106 models**, refuting this module's own comment
   *     ("Gloo's catalogue carries no reliable per-model pricing"). So "cheapest
   *     adequate" no longer has to degrade to a name heuristic — it can be computed.
   *
   * The selector therefore filters on `output_modalities` including "text" and sorts by
   * real price, which is both correct and independent of catalogue ordering.
   */
  const text = (id: string, price: number): GlooModelInfo => ({
    id,
    outputModalities: ["text"],
    inputTokenPrice: price,
    outputTokenPrice: price * 4,
  });
  const image = (id: string): GlooModelInfo => ({
    id,
    outputModalities: ["image"],
    inputTokenPrice: 0,
    outputTokenPrice: 0.00456,
  });

  it("U-EM1a: refuses an image-only model even when it is FIRST and cheap-tier-named", () => {
    // The exact failure the old heuristic was one catalogue reorder away from.
    const models = [
      image("gloo-vendor-flux-flash"),
      text("gloo-vendor-chat-large", 0.00002),
    ];
    expect(selectGlooChatModel(models)).toBe("gloo-vendor-chat-large");
  });

  it("U-EM1b: picks the CHEAPEST text model, not the first or the best-named", () => {
    const models = [
      text("gloo-vendor-chat-large", 0.00002),
      text("gloo-vendor-chat-mini", 0.0000001),
      text("gloo-vendor-chat-medium", 0.000005),
    ];
    expect(selectGlooChatModel(models)).toBe("gloo-vendor-chat-mini");
  });

  it("U-EM1c: keeps a text+image model — it CAN serve chat", () => {
    const both: GlooModelInfo = {
      id: "gloo-vendor-omni",
      outputModalities: ["image", "text"],
      inputTokenPrice: 0.0000001,
      outputTokenPrice: 0.0000004,
    };
    expect(selectGlooChatModel([image("gloo-vendor-flux"), both])).toBe(
      "gloo-vendor-omni",
    );
  });

  it("U-EM1d: an entry with no modality metadata is treated as text (tolerant fallback)", () => {
    // A catalogue that stops publishing `output_modalities` must degrade to the old
    // behaviour rather than resolving nothing and failing the whole e2e lane.
    const bare: GlooModelInfo = { id: "gloo-vendor-chat", outputModalities: [] };
    expect(selectGlooChatModel([bare])).toBe("gloo-vendor-chat");
  });

  it("U-EM1e: an unpriced text model still wins over no candidate at all", () => {
    const unpriced: GlooModelInfo = {
      id: "gloo-vendor-chat",
      outputModalities: ["text"],
    };
    expect(selectGlooChatModel([image("gloo-vendor-flux"), unpriced])).toBe(
      "gloo-vendor-chat",
    );
  });

  it("ignores empty ids", () => {
    expect(selectGlooChatModel([text("", 0.1), text("gloo-vendor-chat", 0.2)])).toBe(
      "gloo-vendor-chat",
    );
  });

  it("throws an actionable error when there is no usable text model", () => {
    expect(() => selectGlooChatModel([])).toThrow(/gloo/i);
    expect(() => selectGlooChatModel([image("gloo-vendor-flux")])).toThrow(/gloo/i);
  });
});

describe("selectGlooImageModel (the /ai/v2/responses surface)", () => {
  const model = (
    id: string,
    outputModalities: string[],
    price = 0.001,
  ): GlooModelInfo => ({ id, outputModalities, outputTokenPrice: price });

  it("prefers an image-ONLY model over a text+image one", () => {
    // Both can produce a picture, but a text+image model may answer a bare prompt with
    // prose — which surfaces as a confusing "no completed image output" 502 rather than
    // as a clear failure.
    expect(
      selectGlooImageModel([
        model("gloo-vendor-omni", ["image", "text"], 0.0001),
        model("gloo-vendor-flux", ["image"], 0.01),
      ]),
    ).toBe("gloo-vendor-flux");
  });

  it("among image-only models, picks the cheapest", () => {
    expect(
      selectGlooImageModel([
        model("gloo-vendor-flux-max", ["image"], 0.02),
        model("gloo-vendor-flux-klein", ["image"], 0.004),
      ]),
    ).toBe("gloo-vendor-flux-klein");
  });

  it("falls back to a text+image model when that is all there is", () => {
    expect(selectGlooImageModel([model("gloo-vendor-omni", ["image", "text"])])).toBe(
      "gloo-vendor-omni",
    );
  });

  it("throws actionably when the catalogue has no image-capable model", () => {
    expect(() => selectGlooImageModel([])).toThrow(/gloo/i);
    expect(() => selectGlooImageModel([model("gloo-vendor-chat", ["text"])])).toThrow(
      /gloo/i,
    );
  });
});
