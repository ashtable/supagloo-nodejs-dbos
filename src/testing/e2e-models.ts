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
  pricing?: { audio?: unknown; completion?: unknown };
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
    audioPrice: Number(raw.pricing?.audio ?? raw.pricing?.completion ?? NaN),
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
  fetchImpl: typeof fetch = fetch,
): Promise<AudioModelInfo[]> {
  const res = await fetchImpl(
    `${trimSlash(env.OPENROUTER_BASE_URL)}/api/v1/models?output_modalities=audio`,
    { method: "GET", headers: { accept: "application/json" } },
  );
  if (!res.ok) {
    throw new Error(`audio model discovery failed: -> ${res.status}`);
  }
  const body = (await res.json()) as { data?: RawAudioModel[] };
  return (body.data ?? []).map(toAudioModelInfo);
}

/** Resolve a live audio model id for the kind (narration → TTS, music → Lyria). */
export async function resolveAudioModel(
  env: E2eModelEnv,
  kind: "narration" | "music",
): Promise<string> {
  return selectAudioModel(await fetchAudioModels(env), kind);
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

// --- Gloo (task 34-E8) --------------------------------------------------------------------
// Gloo is NOT on OpenRouter's discovery endpoints — it exposes its OWN authenticated model
// catalogue at `GET {GLOO_BASE_URL}/platform/v2/models` (nextjs CLAUDE.md "LLM Provider: Gloo
// AI Studio"), ids namespaced like `gloo-openai-gpt-5-mini`. The reworked providers.e2e.ts uses
// this to resolve a Gloo model id at RUN TIME for a real `.chat()` round-trip — never hardcoded
// (§10.9). Gloo's catalogue carries no reliable per-model pricing, so "cheapest ADEQUATE"
// degrades to a cheap-tier id heuristic (mini/nano/…), with a safe fallback to the first entry.

/** The subset of a Gloo `/platform/v2/models` entry the resolver reads. */
export interface GlooModelInfo {
  id: string;
}

interface RawGlooModel {
  id?: unknown;
}

/** Normalize one raw Gloo catalogue entry into a {@link GlooModelInfo}. */
export function toGlooModelInfo(raw: RawGlooModel): GlooModelInfo {
  return { id: typeof raw.id === "string" ? raw.id : "" };
}

// Substrings that signal a cheaper/smaller tier when no real pricing metadata is available.
const GLOO_CHEAP_TIER = ["mini", "nano", "small", "lite", "flash", "haiku"];

/**
 * Pick a Gloo chat model at run time: prefer a cheap-tier id (to minimize live cost, §10.9),
 * else fall back to the first non-empty catalogue id. Throws (actionable) if the catalogue is
 * empty — a Gloo round-trip with no discoverable model would force a hardcode, which §10.9
 * forbids.
 */
export function selectGlooChatModel(models: GlooModelInfo[]): string {
  const ids = models.map((m) => m.id).filter((id) => id.length > 0);
  const cheap = ids.find((id) => {
    const lower = id.toLowerCase();
    return GLOO_CHEAP_TIER.some((tier) => lower.includes(tier));
  });
  const pick = cheap ?? ids[0];
  if (!pick) {
    throw new Error(
      "no Gloo model found via the /platform/v2/models catalogue — cannot resolve an adequate " +
        "Gloo chat model at run time without hardcoding one (design-delta §10.9).",
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
