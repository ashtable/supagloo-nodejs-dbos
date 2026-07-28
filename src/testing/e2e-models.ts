/**
 * Discovery-based model resolution for the real-provider e2e (design-delta §10.9). The hard
 * rule is that model ids are NEVER hardcoded — they are resolved at run time from OpenRouter's
 * live discovery endpoints and written onto `AiGeneration.model` at seed time (the workflows read
 * the column; they do not discover themselves).
 *
 * "Cheapest/fastest ADEQUATE" is the governing phrase, and ADEQUATE is modality-specific — so
 * each resolver reads the discovery endpoint's per-model metadata rather than picking an arbitrary
 * first/`:free` id (an early naive `:free` pick landed on an incapable coding model that hung, and
 * on an image-to-video-only / 500-ing image model). Confirmed live in task 34-E4:
 *   - text  → cheapest model that emits text AND supports `structured_outputs` (generateObject).
 *   - image → cheapest image model with a CONCRETE POSITIVE price (the free image tier 500s).
 *   - audio → cheapest TTS (narration) / Lyria (music) model, by kind.
 *   - video → cheapest TEXT-TO-VIDEO model at its smallest supported duration.
 */

export interface E2eModelEnv {
  OPENROUTER_BASE_URL: string;
}

const trimSlash = (u: string) => u.replace(/\/+$/, "");

/** The subset of OpenRouter's `/api/v1/models` per-model metadata the resolvers read. */
export interface OpenRouterModelInfo {
  id: string;
  /** Prompt price in $/token (`pricing.prompt`); NaN when unparseable. Negative = variable/auto. */
  promptPrice: number;
  /** Per-image price (`pricing.image`); NaN when the model has no concrete image price. */
  imagePrice: number;
  outputModalities: string[];
  supportedParameters: string[];
}

interface RawOpenRouterModel {
  id?: unknown;
  pricing?: { prompt?: unknown; image?: unknown };
  architecture?: { output_modalities?: unknown };
  supported_parameters?: unknown;
}

const asStringArray = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];

/** Normalize one raw `/api/v1/models` entry into an {@link OpenRouterModelInfo}. */
export function toModelInfo(raw: RawOpenRouterModel): OpenRouterModelInfo {
  return {
    id: typeof raw.id === "string" ? raw.id : "",
    promptPrice: Number(raw.pricing?.prompt ?? NaN),
    imagePrice: Number(raw.pricing?.image ?? NaN),
    outputModalities: asStringArray(raw.architecture?.output_modalities),
    supportedParameters: asStringArray(raw.supported_parameters),
  };
}

/**
 * Select the CHEAPEST image-output model with a CONCRETE POSITIVE per-image price. Requiring a
 * concrete price is deliberate: the zero-priced free image models (e.g. krea) return 500 on real
 * OpenRouter, so they are not adequate — a positive `pricing.image` is the reliability signal a
 * discovery-only pick can use. Throws (actionable) if none qualifies.
 */
export function selectCheapestImageModel(models: OpenRouterModelInfo[]): string {
  const capable = models
    .filter(
      (m) =>
        m.id.length > 0 &&
        m.outputModalities.includes("image") &&
        Number.isFinite(m.imagePrice) &&
        m.imagePrice > 0,
    )
    .sort((a, b) => a.imagePrice - b.imagePrice);
  const pick = capable[0];
  if (!pick) {
    throw new Error(
      "no priced image model found via discovery — cannot resolve an adequate (reliable) image " +
        "model without hardcoding one (design-delta §10.9).",
    );
  }
  return pick.id;
}

/** The subset of `/api/v1/models?output_modalities=audio` metadata the audio resolver reads. */
export interface AudioModelInfo {
  id: string;
  /** Per-audio-token price (`pricing.audio` ?? `pricing.completion`); NaN when unpriced. */
  audioPrice: number;
  /** True when the model is a music generator (Lyria etc.) rather than a TTS voice model. */
  isMusic: boolean;
}

interface RawAudioModel {
  id?: unknown;
  description?: unknown;
  pricing?: { audio?: unknown; completion?: unknown; prompt?: unknown };
}

/** Normalize one raw audio-model entry, classifying music vs TTS from its description/id. */
export function toAudioModelInfo(raw: RawAudioModel): AudioModelInfo {
  const id = typeof raw.id === "string" ? raw.id : "";
  const desc = (typeof raw.description === "string" ? raw.description : "").toLowerCase();
  const isMusic =
    id.toLowerCase().includes("lyria") ||
    desc.includes("music") ||
    desc.includes("song") ||
    desc.includes("instrumental");
  return {
    id,
    // Speech-catalogue models price on `prompt` (per input token) with `completion: "0"`,
    // while the chat-audio models price on `audio`/`completion` — so all three are consulted.
    audioPrice: Number(
      raw.pricing?.audio ??
        (Number(raw.pricing?.completion ?? 0) > 0
          ? raw.pricing?.completion
          : (raw.pricing?.prompt ?? raw.pricing?.completion)) ??
        NaN,
    ),
    isMusic,
  };
}

/**
 * Select an audio model for the given kind: `narration` → the cheapest TTS (non-music) model;
 * `music` → the cheapest music (Lyria) model. Ties broken by id (prefers e.g. the cheaper "clip"
 * over "pro"). Both kinds use the SAME streaming chat-audio contract (only the model + voice
 * differ). Throws (actionable) if none qualifies.
 */
export function selectAudioModel(
  models: AudioModelInfo[],
  kind: "narration" | "music",
): string {
  const wantMusic = kind === "music";
  const candidates = models
    .filter((m) => m.id.length > 0 && m.isMusic === wantMusic)
    .sort((a, b) => {
      const pa = Number.isFinite(a.audioPrice) ? a.audioPrice : Number.POSITIVE_INFINITY;
      const pb = Number.isFinite(b.audioPrice) ? b.audioPrice : Number.POSITIVE_INFINITY;
      return pa - pb || a.id.localeCompare(b.id);
    });
  const pick = candidates[0];
  if (!pick) {
    throw new Error(
      `no ${kind} audio model found via discovery (music=${wantMusic}) — cannot resolve one ` +
        `without hardcoding (design-delta §10.9).`,
    );
  }
  return pick.id;
}

/**
 * Select a dedicated TTS model from the `output_modalities=speech` catalogue: cheapest by
 * per-token price, ties broken by id. Every entry there is a batch synthesis model, so no
 * music/TTS classification is needed — the catalogue itself is the filter. Throws
 * (actionable) if it is empty, rather than silently falling back to a chat model.
 */
export function selectNarrationModel(models: AudioModelInfo[]): string {
  const candidates = models
    .filter((m) => m.id.length > 0)
    .sort((a, b) => {
      const pa = Number.isFinite(a.audioPrice) ? a.audioPrice : Number.POSITIVE_INFINITY;
      const pb = Number.isFinite(b.audioPrice) ? b.audioPrice : Number.POSITIVE_INFINITY;
      return pa - pb || a.id.localeCompare(b.id);
    });
  const pick = candidates[0];
  if (!pick) {
    throw new Error(
      "no speech model found via discovery (GET /api/v1/models?output_modalities=speech) — " +
        "cannot resolve a narration model without hardcoding one (design-delta §10.9).",
    );
  }
  return pick.id;
}

/**
 * Select the CHEAPEST model that emits text AND supports `structured_outputs`, excluding
 * variable/auto-priced entries (negative price) so the pick is a concrete, cost-known model.
 * Throws (actionable) if none qualifies.
 */
export function selectCheapestStructuredTextModel(
  models: OpenRouterModelInfo[],
): string {
  const capable = models
    .filter(
      (m) =>
        m.id.length > 0 &&
        m.outputModalities.includes("text") &&
        m.supportedParameters.includes("structured_outputs") &&
        Number.isFinite(m.promptPrice) &&
        m.promptPrice >= 0,
    )
    .sort((a, b) => a.promptPrice - b.promptPrice);
  const pick = capable[0];
  if (!pick) {
    throw new Error(
      "no structured-output-capable text model found via discovery — cannot resolve an " +
        "adequate model for generateObject without hardcoding one (design-delta §10.9).",
    );
  }
  return pick.id;
}

async function fetchOpenRouterModels(
  env: E2eModelEnv,
  fetchImpl: typeof fetch = fetch,
  outputModalities?: string[],
): Promise<OpenRouterModelInfo[]> {
  const query = outputModalities
    ? `?${new URLSearchParams({ output_modalities: outputModalities.join(",") }).toString()}`
    : "";
  const res = await fetchImpl(
    `${trimSlash(env.OPENROUTER_BASE_URL)}/api/v1/models${query}`,
    { method: "GET", headers: { accept: "application/json" } },
  );
  if (!res.ok) {
    throw new Error(`model discovery failed: GET /api/v1/models -> ${res.status}`);
  }
  const body = (await res.json()) as { data?: RawOpenRouterModel[] };
  return (body.data ?? []).map(toModelInfo);
}

/** The subset of `/api/v1/videos/models` metadata the video resolver reads. */
export interface VideoModelInfo {
  id: string;
  /** Provider-declared supported clip durations in seconds (ascending as returned). */
  supportedDurations: number[];
  /** True only when the model's description explicitly advertises text-to-video. */
  isTextToVideo: boolean;
}

interface RawVideoModel {
  id?: unknown;
  description?: unknown;
  supported_durations?: unknown;
}

const asNumberArray = (v: unknown): number[] =>
  Array.isArray(v)
    ? v.filter((x): x is number => typeof x === "number" && Number.isFinite(x))
    : [];

/** Normalize one raw `/api/v1/videos/models` entry into a {@link VideoModelInfo}. */
export function toVideoModelInfo(raw: RawVideoModel): VideoModelInfo {
  const desc = (typeof raw.description === "string" ? raw.description : "").toLowerCase();
  return {
    id: typeof raw.id === "string" ? raw.id : "",
    supportedDurations: asNumberArray(raw.supported_durations),
    isTextToVideo: desc.includes("text-to-video") || desc.includes("text to video"),
  };
}

export interface ResolvedVideoModel {
  id: string;
  /** The model's smallest supported duration (seconds) — used to minimize live cost (§10.9). */
  minDurationSeconds: number;
}

/**
 * Select a TEXT-TO-VIDEO-capable model (the generate-video workflow submits a text prompt, no
 * frame image) with the SMALLEST supported clip duration, to minimize live video cost. An
 * image-to-video-only model (e.g. one advertising only "image-to-video") 400s the text submit
 * ("Text-to-video is not supported for this model"), so it must be excluded — the modality
 * filter alone is not enough. Throws (actionable) if none qualifies.
 */
export function selectTextToVideoModel(models: VideoModelInfo[]): ResolvedVideoModel {
  const candidates = models
    .filter((m) => m.id.length > 0 && m.isTextToVideo && m.supportedDurations.length > 0)
    .map((m) => ({ id: m.id, minDurationSeconds: Math.min(...m.supportedDurations) }))
    .sort((a, b) => a.minDurationSeconds - b.minDurationSeconds);
  const pick = candidates[0];
  if (!pick) {
    throw new Error(
      "no text-to-video-capable model found via discovery — the generate-video workflow " +
        "submits a text prompt, and every discovered video model is image-to-video only " +
        "(cannot resolve one without hardcoding, forbidden by design-delta §10.9).",
    );
  }
  return pick;
}

/** Resolve a live, cheapest structured-output-capable text model id (storyboard/script). */
export async function resolveTextModel(env: E2eModelEnv): Promise<string> {
  return selectCheapestStructuredTextModel(await fetchOpenRouterModels(env));
}

/** Resolve a live, cheapest reliably-priced image model id. */
export async function resolveImageModel(env: E2eModelEnv): Promise<string> {
  return selectCheapestImageModel(await fetchOpenRouterModels(env, undefined, ["image"]));
}

async function fetchAudioModels(
  env: E2eModelEnv,
  modality: "audio" | "speech",
  fetchImpl: typeof fetch = fetch,
): Promise<AudioModelInfo[]> {
  const res = await fetchImpl(
    `${trimSlash(env.OPENROUTER_BASE_URL)}/api/v1/models?output_modalities=${modality}`,
    { method: "GET", headers: { accept: "application/json" } },
  );
  if (!res.ok) {
    throw new Error(`${modality} model discovery failed: -> ${res.status}`);
  }
  const body = (await res.json()) as { data?: RawAudioModel[] };
  return (body.data ?? []).map(toAudioModelInfo);
}

/**
 * Resolve a live audio model id for the kind.
 *
 * The two kinds read DIFFERENT catalogues, and this is not a stylistic choice — verified
 * live, `output_modalities=speech` and `output_modalities=audio` return disjoint sets:
 *
 *   - narration → `speech` (15 dedicated batch-TTS models, `architecture.output_modalities`
 *     is exactly `["speech"]`). These are the models `POST /api/v1/audio/speech` accepts.
 *   - music     → `audio` (4 models: the two Lyria music models plus the two conversational
 *     gpt-audio models), reached through streaming chat-completions.
 *
 * Asking the `audio` catalogue for narration is what shipped, and it is why narration ran on
 * `openai/gpt-audio-mini` — a CONVERSATIONAL model that replied to the verse instead of
 * reading it. That id is also rejected outright by the speech endpoint
 * (`400 Model openai/gpt-audio-mini does not exist`), so the split is load-bearing in both
 * directions.
 */
export async function resolveAudioModel(
  env: E2eModelEnv,
  kind: "narration" | "music",
): Promise<string> {
  if (kind === "narration") {
    return selectNarrationModel(await fetchAudioModels(env, "speech"));
  }
  return selectAudioModel(await fetchAudioModels(env, "audio"), "music");
}

async function fetchVideoModels(
  env: E2eModelEnv,
  fetchImpl: typeof fetch = fetch,
): Promise<VideoModelInfo[]> {
  const res = await fetchImpl(
    `${trimSlash(env.OPENROUTER_BASE_URL)}/api/v1/videos/models`,
    { method: "GET", headers: { accept: "application/json" } },
  );
  if (!res.ok) {
    throw new Error(`video model discovery failed: GET /api/v1/videos/models -> ${res.status}`);
  }
  const body = (await res.json()) as { data?: RawVideoModel[] };
  return (body.data ?? []).map(toVideoModelInfo);
}

/**
 * Resolve a live text-to-video model (`GET /api/v1/videos/models`) plus its smallest supported
 * duration. `discoverVideoModels` (id-only) is unused here because the text-to-video capability
 * + duration live in the per-model metadata the id-only helper strips.
 */
export async function resolveVideoModel(env: E2eModelEnv): Promise<ResolvedVideoModel> {
  return selectTextToVideoModel(await fetchVideoModels(env));
}

// --- Gloo (task 34-E8; corrected 2026-07-28) ----------------------------------------------
// Gloo is NOT on OpenRouter's discovery endpoints — it exposes its OWN authenticated model
// catalogue at `GET {GLOO_BASE_URL}/platform/v2/models`. The reworked providers.e2e.ts uses this
// to resolve a Gloo model id at RUN TIME for a real `.chat()` round-trip — never hardcoded
// (§10.9).
//
// CORRECTED 2026-07-28. Two claims in the previous version of this comment were measured false
// against the live host, and both mattered:
//
//   1. "Gloo's catalogue carries no reliable per-model pricing" — FALSE. Pricing is present on
//      106/106 entries, as decimal STRINGS under `pricing.input|output.rate_per_1k_tokens`. So
//      "cheapest adequate" no longer has to degrade to a name heuristic; it can be computed.
//   2. The cheap-tier substring heuristic (`mini|nano|small|lite|flash|haiku`) is no longer safe.
//      Gloo's catalogue now carries 11 image-capable models and FOUR of them match that filter.
//      An image model handed to `.chat()` answers 400 ("does not support text output and cannot
//      be used with the Chat Completions API"), which would fail the e2e for a reason that looks
//      like a broken provider. It has been working only by ACCIDENT of catalogue ORDERING — the
//      image entries sit at indices 93–103 while index 0 happens to be a cheap text model — and
//      Gloo controls that order.
//
// The selector below therefore filters on `output_modalities` and sorts by real price, which is
// correct rather than merely lucky.

/** The subset of a Gloo `/platform/v2/models` entry the resolver reads. */
export interface GlooModelInfo {
  id: string;
  /** e.g. `["text"]`, `["image"]`, `["image","text"]`. Empty when the catalogue omits it. */
  outputModalities: string[];
  /** Per-TOKEN (converted from the published per-1k rate) so it is directly comparable
   *  with OpenRouter's `pricing.prompt`. Undefined when unpublished. */
  inputTokenPrice?: number;
  outputTokenPrice?: number;
}

interface RawGlooModel {
  id?: unknown;
  output_modalities?: unknown;
  pricing?: {
    input?: { rate_per_1k_tokens?: unknown };
    output?: { rate_per_1k_tokens?: unknown };
  };
}

/** Parse a published per-1k decimal string into a per-token number. */
function per1kToPerToken(raw: unknown): number | undefined {
  if (typeof raw !== "string" && typeof raw !== "number") return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n / 1000 : undefined;
}

/** Normalize one raw Gloo catalogue entry into a {@link GlooModelInfo}. */
export function toGlooModelInfo(raw: RawGlooModel): GlooModelInfo {
  const modalities = Array.isArray(raw.output_modalities)
    ? raw.output_modalities.filter((m): m is string => typeof m === "string")
    : [];
  const info: GlooModelInfo = {
    id: typeof raw.id === "string" ? raw.id : "",
    outputModalities: modalities,
  };
  const input = per1kToPerToken(raw.pricing?.input?.rate_per_1k_tokens);
  const output = per1kToPerToken(raw.pricing?.output?.rate_per_1k_tokens);
  if (input !== undefined) info.inputTokenPrice = input;
  if (output !== undefined) info.outputTokenPrice = output;
  return info;
}

/** Can this entry serve a chat/completions round-trip? An entry with NO modality metadata
 *  is treated as text: the catalogue publishing less than it does today must degrade to the
 *  old behaviour rather than resolving nothing and reddening the whole e2e lane. */
function servesText(m: GlooModelInfo): boolean {
  return m.outputModalities.length === 0 || m.outputModalities.includes("text");
}

/** Sort key: cheapest first, unpriced last (an unpriced model is still better than none). */
function priceOf(m: GlooModelInfo): number {
  const input = m.inputTokenPrice;
  const output = m.outputTokenPrice;
  if (input === undefined && output === undefined) return Number.POSITIVE_INFINITY;
  return (input ?? 0) + (output ?? 0);
}

/**
 * Pick a Gloo chat model at run time: the cheapest TEXT-capable entry by real published
 * price (§10.9's "resolve cheapest at run time" mitigation). Throws (actionably) when the
 * catalogue yields no text-capable model — resolving one by hardcoding is what §10.9 forbids.
 */
export function selectGlooChatModel(models: GlooModelInfo[]): string {
  const candidates = models
    .filter((m) => m.id.length > 0 && servesText(m))
    .sort((a, b) => priceOf(a) - priceOf(b));
  const pick = candidates[0]?.id;
  if (!pick) {
    throw new Error(
      "no text-capable Gloo model found via the /platform/v2/models catalogue — cannot resolve " +
        "an adequate Gloo chat model at run time without hardcoding one (design-delta §10.9). " +
        "NOTE: image-only entries are excluded on purpose; they answer 400 on chat/completions.",
    );
  }
  return pick;
}

/**
 * Pick a Gloo IMAGE model at run time — the `/ai/v2/responses` surface, not chat.
 *
 * Prefers an image-ONLY entry over a text+image one. Both can produce a picture, but a
 * text+image model may answer a bare prompt with prose instead, which would surface as a
 * confusing 502 ("no completed image output") rather than as a clear failure. Cheapest
 * first, by real published price.
 */
export function selectGlooImageModel(models: GlooModelInfo[]): string {
  const candidates = models
    .filter((m) => m.id.length > 0 && m.outputModalities.includes("image"))
    .sort((a, b) => {
      const imageOnly = (m: GlooModelInfo) =>
        m.outputModalities.includes("text") ? 1 : 0;
      const byShape = imageOnly(a) - imageOnly(b);
      return byShape !== 0 ? byShape : priceOf(a) - priceOf(b);
    });
  const pick = candidates[0]?.id;
  if (!pick) {
    throw new Error(
      "no image-capable Gloo model found via the /platform/v2/models catalogue — cannot " +
        "resolve one at run time without hardcoding it (design-delta §10.9).",
    );
  }
  return pick;
}

export interface GlooModelEnv {
  GLOO_BASE_URL: string;
}

/**
 * Resolve a live Gloo chat model id from the authenticated catalogue
 * (`GET {GLOO_BASE_URL}/platform/v2/models`, `Authorization: Bearer <token>`). The catalogue path
 * prefix is `/platform/v2` (NOT the `/ai/v2` chat surface). Tolerant of the response shape
 * (`data`/`models` array). Requires a freshly-minted Gloo bearer token.
 */
export async function resolveGlooModel(
  env: GlooModelEnv,
  bearerToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const res = await fetchImpl(`${trimSlash(env.GLOO_BASE_URL)}/platform/v2/models`, {
    method: "GET",
    headers: { accept: "application/json", authorization: `Bearer ${bearerToken}` },
  });
  if (!res.ok) {
    throw new Error(
      `Gloo model discovery failed: GET /platform/v2/models -> ${res.status}`,
    );
  }
  const body = (await res.json()) as { data?: RawGlooModel[]; models?: RawGlooModel[] };
  const raw = body.data ?? body.models ?? [];
  return selectGlooChatModel(raw.map(toGlooModelInfo));
}

/** The image twin of {@link resolveGlooModel} — same catalogue, different filter. */
export async function resolveGlooImageModel(
  env: GlooModelEnv,
  bearerToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const res = await fetchImpl(`${trimSlash(env.GLOO_BASE_URL)}/platform/v2/models`, {
    method: "GET",
    headers: { accept: "application/json", authorization: `Bearer ${bearerToken}` },
  });
  if (!res.ok) {
    throw new Error(
      `Gloo model discovery failed: GET /platform/v2/models -> ${res.status}`,
    );
  }
  const body = (await res.json()) as { data?: RawGlooModel[]; models?: RawGlooModel[] };
  const raw = body.data ?? body.models ?? [];
  return selectGlooImageModel(raw.map(toGlooModelInfo));
}
