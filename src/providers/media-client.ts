import { ProviderHttpError } from "./errors";

/**
 * Direct-`fetch` media client (design-delta §7 / memory
 * openrouter-media-and-ai-sdk-split). Media generation is NOT done through the AI
 * SDK — TTS returns a raw audio byte-stream, and video is an async job + poll +
 * unsigned-URL download; neither maps onto the AI SDK's synchronous primitives.
 *
 * These are stateless HTTP primitives. The durable polling ORCHESTRATION (the ~30s
 * `DBOS.sleep`s between poll attempts, the submit step that persists `providerJobId`
 * before returning) lives in the #33/#34 workflows that wrap these — not here.
 *
 * Injectable `fetch`, closures over the base URL + the DECRYPTED OpenRouter key.
 */

export interface MediaClientConfig {
  /** Provider ROOT (e.g. `https://openrouter.ai`); media paths are appended. */
  openrouterBaseUrl: string;
  /** The user's DECRYPTED OpenRouter API key. */
  apiKey: string;
  fetchImpl?: typeof fetch;
}

const trimSlash = (u: string) => u.replace(/\/+$/, "");

function authHeader(cfg: MediaClientConfig): Record<string, string> {
  return { authorization: `Bearer ${cfg.apiKey}` };
}

async function ensureOk(res: Response, what: string): Promise<Response> {
  if (!res.ok) {
    throw new ProviderHttpError(
      `${what} failed: ${res.status}`,
      res.status,
      await res.text().catch(() => undefined),
    );
  }
  return res;
}

// --- TTS / speech ---------------------------------------------------------------

export interface RequestSpeechArgs {
  modelId: string;
  input: string;
  voice?: string;
  /** Audio container, e.g. `mp3` (provider default when omitted). */
  format?: string;
}

export interface SpeechResult {
  bytes: Buffer;
  /** The `X-Generation-Id` response header (provider request id), if present. */
  generationId: string | null;
  contentType: string | null;
}

/**
 * `POST /api/v1/audio/speech` — the response is a RAW audio byte stream
 * (`audio/mpeg`) plus an `X-Generation-Id` header, NOT JSON. We buffer the bytes and
 * capture the header; the #33 workflow uploads them to S3.
 */
export async function requestSpeech(
  cfg: MediaClientConfig,
  args: RequestSpeechArgs,
): Promise<SpeechResult> {
  const fetchImpl = cfg.fetchImpl ?? fetch;
  const res = await fetchImpl(
    `${trimSlash(cfg.openrouterBaseUrl)}/api/v1/audio/speech`,
    {
      method: "POST",
      headers: { ...authHeader(cfg), "content-type": "application/json" },
      body: JSON.stringify({
        model: args.modelId,
        input: args.input,
        ...(args.voice ? { voice: args.voice } : {}),
        ...(args.format ? { response_format: args.format } : {}),
      }),
    },
  );
  await ensureOk(res, "speech");
  const bytes = Buffer.from(await res.arrayBuffer());
  return {
    bytes,
    generationId: res.headers.get("x-generation-id"),
    contentType: res.headers.get("content-type"),
  };
}

// --- Image generation -----------------------------------------------------------

export interface RequestImageArgs {
  modelId: string;
  prompt: string;
}

export interface ImageResult {
  /** A URL the generated image can be downloaded from (fetched by {@link fetchAssetBytes}). */
  imageUrl: string;
}

/**
 * `POST /api/v1/images/generations` — OpenAI-Images-compatible: `{ model, prompt }` →
 * `{ created, data: [{ url }] }`. We return the URL REFERENCE (not the bytes) so the
 * workflow's separate `fetchAssetBytes` step downloads it — mirroring the video
 * submit→download decomposition, and keeping the (multi-MB) bytes out of the DBOS
 * checkpoint (only the small URL is a step return).
 *
 * IMPLEMENTATION-TIME DECISION (design-delta does NOT pin OpenRouter's image-gen contract,
 * unlike TTS `/api/v1/audio/speech` and video `/api/v1/videos`). Chosen: the OpenAI Images
 * URL shape, because it cleanly separates the API call from the byte fetch (honoring the
 * two named steps `callImageModel` → `fetchAssetBytes`) and is a standard OpenAI-compatible
 * contract. ALTERNATIVE (verify against live OpenRouter): the chat-completions path with
 * `modalities: ["image"]` returning inline base64 in `message.images[].image_url.url` — that
 * would make `fetchAssetBytes` a base64 decode rather than a GET. Confirm before prod.
 */
export async function requestImage(
  cfg: MediaClientConfig,
  args: RequestImageArgs,
): Promise<ImageResult> {
  const fetchImpl = cfg.fetchImpl ?? fetch;
  const res = await fetchImpl(
    `${trimSlash(cfg.openrouterBaseUrl)}/api/v1/images/generations`,
    {
      method: "POST",
      headers: { ...authHeader(cfg), "content-type": "application/json" },
      body: JSON.stringify({ model: args.modelId, prompt: args.prompt }),
    },
  );
  await ensureOk(res, "image generation");
  const body = (await res.json()) as { data?: Array<{ url?: string }> };
  const url = body.data?.[0]?.url;
  if (typeof url !== "string" || url.length === 0) {
    // A 200 with no usable URL is a malformed provider response — treat as a transient
    // upstream hiccup (502) so the step's MEDIA_RETRY re-tries rather than failing hard.
    throw new ProviderHttpError(
      "image generation returned no image url",
      502,
      JSON.stringify(body).slice(0, 500),
    );
  }
  return { imageUrl: url };
}

export interface FetchedAsset {
  bytes: Buffer;
  contentType: string | null;
}

/**
 * Download a generated asset from a pre-authorized URL (the image/video content URL the
 * provider returned). NO auth header — the URL is already authorized (same contract as
 * {@link downloadBytes}); attaching the provider bearer to a third-party CDN URL is wrong.
 * Returns the bytes + the response `content-type` (stored as the S3 object's ContentType).
 */
export async function fetchAssetBytes(
  cfg: MediaClientConfig,
  url: string,
): Promise<FetchedAsset> {
  const fetchImpl = cfg.fetchImpl ?? fetch;
  const res = await fetchImpl(url, { method: "GET" });
  await ensureOk(res, "asset download");
  return {
    bytes: Buffer.from(await res.arrayBuffer()),
    contentType: res.headers.get("content-type"),
  };
}

// --- Video (async job) ----------------------------------------------------------

export interface SubmitVideoJobArgs {
  modelId: string;
  /** Provider-specific generation input (prompt, duration, aspect, frame_images…). */
  input: Record<string, unknown>;
  /** Idempotency key (the workflow id) so a replayed submit does not create a 2nd job. */
  idempotencyKey: string;
}

export interface VideoJob {
  id: string;
  pollingUrl: string;
  status: string;
}

/**
 * `POST /api/v1/videos` → 202 `{ id, polling_url, status }`. The `Idempotency-Key`
 * header makes a replayed submit return the SAME job (the #34 crash/replay case).
 */
export async function submitVideoJob(
  cfg: MediaClientConfig,
  args: SubmitVideoJobArgs,
): Promise<VideoJob> {
  const fetchImpl = cfg.fetchImpl ?? fetch;
  const res = await fetchImpl(
    `${trimSlash(cfg.openrouterBaseUrl)}/api/v1/videos`,
    {
      method: "POST",
      headers: {
        ...authHeader(cfg),
        "content-type": "application/json",
        "idempotency-key": args.idempotencyKey,
      },
      body: JSON.stringify({ model: args.modelId, ...args.input }),
    },
  );
  await ensureOk(res, "video submit");
  const body = (await res.json()) as {
    id: string;
    polling_url: string;
    status: string;
  };
  return { id: body.id, pollingUrl: body.polling_url, status: body.status };
}

export interface VideoJobStatus {
  id: string;
  status: string;
}

/** Poll a video job by its polling URL (`GET {polling_url}`). */
export async function getVideoJob(
  cfg: MediaClientConfig,
  pollingUrl: string,
): Promise<VideoJobStatus> {
  const fetchImpl = cfg.fetchImpl ?? fetch;
  const res = await fetchImpl(pollingUrl, {
    method: "GET",
    headers: { ...authHeader(cfg), accept: "application/json" },
  });
  await ensureOk(res, "video poll");
  const body = (await res.json()) as { id: string; status: string };
  return { id: body.id, status: body.status };
}

/**
 * `GET /api/v1/videos/{id}/content?index=0` → `{ unsigned_urls: [...] }` once the job
 * is completed. Call only after a poll reports `completed`.
 */
export async function getVideoContentUrls(
  cfg: MediaClientConfig,
  jobId: string,
): Promise<{ unsignedUrls: string[] }> {
  const fetchImpl = cfg.fetchImpl ?? fetch;
  const res = await fetchImpl(
    `${trimSlash(cfg.openrouterBaseUrl)}/api/v1/videos/${jobId}/content?index=0`,
    { method: "GET", headers: { ...authHeader(cfg), accept: "application/json" } },
  );
  await ensureOk(res, "video content");
  const body = (await res.json()) as { unsigned_urls?: string[] };
  return { unsignedUrls: body.unsigned_urls ?? [] };
}

/** Download raw bytes from an unsigned content URL (no auth — the URL is pre-authorized). */
export async function downloadBytes(
  cfg: MediaClientConfig,
  url: string,
): Promise<Buffer> {
  const fetchImpl = cfg.fetchImpl ?? fetch;
  const res = await fetchImpl(url, { method: "GET" });
  await ensureOk(res, "download");
  return Buffer.from(await res.arrayBuffer());
}
