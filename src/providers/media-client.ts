import { ProviderHttpError } from "./errors";

/**
 * Direct-`fetch` media client (design-delta §7 / memory openrouter-media-and-ai-sdk-split).
 * Media generation is NOT done through the AI SDK. As CONFIRMED against the live OpenRouter API
 * (task 34-E4 expanded scope), the real contracts are:
 *
 *   - IMAGE  → NON-streaming chat-completions with `modalities:["image"]`; the image comes back
 *              as a base64 `data:` URI inline in `choices[0].message.images[0].image_url.url`
 *              (there is NO `/api/v1/images/generations` endpoint on real OpenRouter).
 *   - AUDIO  → STREAMING chat-completions with `modalities:["text","audio"]` +
 *              `audio:{voice?, format:"pcm16"}` + `stream:true`; the SSE stream carries
 *              `choices[0].delta.audio.data` base64 PCM16 chunks (there is NO
 *              `/api/v1/audio/speech` endpoint; non-stream / mp3 are rejected). narration (TTS)
 *              and music (Lyria) use the SAME shape (different model + voice).
 *   - VIDEO  → async job: `POST /api/v1/videos` (202) → poll `GET {polling_url}` (the poll body
 *              carries `unsigned_urls` once completed) → download `unsigned_urls[0]` WITH the
 *              bearer (the content URL requires auth).
 *
 * These are stateless HTTP primitives. The durable polling ORCHESTRATION lives in the workflows.
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

// --- shared helpers --------------------------------------------------------------

/** Decode a `data:<contentType>;base64,<payload>` URI into bytes + its content type. */
export function decodeDataUri(uri: string): { bytes: Buffer; contentType: string } {
  const match = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(uri);
  if (!match || !match[2]) {
    // Not a base64 data URI — we only support inline base64 image payloads.
    throw new ProviderHttpError(
      "unsupported image data uri (expected base64)",
      502,
      uri.slice(0, 64),
    );
  }
  return {
    contentType: match[1] || "application/octet-stream",
    bytes: Buffer.from(match[3] ?? "", "base64"),
  };
}

/** Wrap raw little-endian PCM16 samples in a minimal WAV (RIFF) container. */
export function wavFromPcm16(
  pcm: Buffer,
  opts: { sampleRate?: number; channels?: number } = {},
): Buffer {
  const sampleRate = opts.sampleRate ?? 24_000;
  const channels = opts.channels ?? 1;
  const bitsPerSample = 16;
  const byteRate = (sampleRate * channels * bitsPerSample) / 8;
  const blockAlign = (channels * bitsPerSample) / 8;
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16); // PCM fmt chunk size
  header.writeUInt16LE(1, 20); // audio format 1 = PCM
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

/**
 * Parse an OpenRouter chat-completions SSE stream, concatenating the base64 `delta.audio.data`
 * PCM16 chunks into raw bytes (each chunk decoded independently, then joined — safe regardless of
 * per-chunk base64 padding) and capturing the first `delta.audio.id`.
 */
export function parseAudioStream(sse: string): {
  pcm: Buffer;
  generationId: string | null;
} {
  const parts: Buffer[] = [];
  let generationId: string | null = null;
  for (const rawLine of sse.split("\n")) {
    const line = rawLine.trim();
    if (!line.startsWith("data:")) continue;
    const payload = line.slice(5).trim();
    if (payload === "" || payload === "[DONE]") continue;
    let obj: unknown;
    try {
      obj = JSON.parse(payload);
    } catch {
      continue;
    }
    const choices = (
      obj as {
        choices?: Array<{ delta?: { audio?: { data?: unknown; id?: unknown } } }>;
      }
    ).choices;
    for (const ch of choices ?? []) {
      const audio = ch.delta?.audio;
      if (!audio) continue;
      if (typeof audio.data === "string" && audio.data.length > 0) {
        parts.push(Buffer.from(audio.data, "base64"));
      }
      if (generationId === null && typeof audio.id === "string") {
        generationId = audio.id;
      }
    }
  }
  return { pcm: Buffer.concat(parts), generationId };
}

// --- TTS / speech (narration + music) -------------------------------------------

export interface RequestSpeechArgs {
  modelId: string;
  /** The text to speak (narration) or the music-style prompt (music). */
  input: string;
  /** A valid provider voice enum for TTS (e.g. `"alloy"`); OMITTED for music. */
  voice?: string;
}

export interface SpeechResult {
  /** WAV-wrapped audio bytes (PCM16 → RIFF/WAVE). */
  bytes: Buffer;
  /** The provider audio-delta `id` (request id), if present. */
  generationId: string | null;
  contentType: string;
}

/**
 * Generate audio via STREAMING chat-completions (`modalities:["text","audio"]`,
 * `audio.format:"pcm16"`, `stream:true`) — the real OpenRouter audio contract for BOTH narration
 * (TTS model + `voice`) and music (Lyria, no voice). Buffers the SSE stream, concatenates the
 * base64 PCM16 audio deltas, and WAV-wraps them (24 kHz mono — correct for gpt-audio TTS; see the
 * task-34-E4 note re: music sample-rate). Throws `ProviderHttpError` on a non-2xx or an
 * audio-less response.
 */
export async function requestSpeech(
  cfg: MediaClientConfig,
  args: RequestSpeechArgs,
): Promise<SpeechResult> {
  const fetchImpl = cfg.fetchImpl ?? fetch;
  const res = await fetchImpl(
    `${trimSlash(cfg.openrouterBaseUrl)}/api/v1/chat/completions`,
    {
      method: "POST",
      headers: {
        ...authHeader(cfg),
        "content-type": "application/json",
        accept: "text/event-stream",
      },
      body: JSON.stringify({
        model: args.modelId,
        messages: [{ role: "user", content: args.input }],
        modalities: ["text", "audio"],
        audio: { ...(args.voice ? { voice: args.voice } : {}), format: "pcm16" },
        stream: true,
      }),
    },
  );
  await ensureOk(res, "speech");
  const { pcm, generationId } = parseAudioStream(await res.text());
  if (pcm.length === 0) {
    // A 200 with no audio deltas is a malformed provider response — treat as transient (502) so
    // the step's MEDIA_RETRY re-tries rather than failing the generation hard.
    throw new ProviderHttpError("speech returned no audio data", 502);
  }
  return { bytes: wavFromPcm16(pcm), generationId, contentType: "audio/wav" };
}

// --- Image generation -----------------------------------------------------------

export interface RequestImageArgs {
  modelId: string;
  prompt: string;
}

export interface ImageResult {
  /** The decoded image bytes (inline base64 from the chat-completions response). */
  bytes: Buffer;
  contentType: string;
}

/**
 * Generate an image via NON-streaming chat-completions with `modalities:["image"]` — the real
 * OpenRouter image contract. The image is returned INLINE as a base64 `data:` URI in
 * `choices[0].message.images[0].image_url.url`; we decode it to bytes here (there is no separate
 * URL to download, so the workflow uploads these bytes directly in the same step). Throws
 * `ProviderHttpError` on a non-2xx or an image-less response.
 */
export async function requestImage(
  cfg: MediaClientConfig,
  args: RequestImageArgs,
): Promise<ImageResult> {
  const fetchImpl = cfg.fetchImpl ?? fetch;
  const res = await fetchImpl(
    `${trimSlash(cfg.openrouterBaseUrl)}/api/v1/chat/completions`,
    {
      method: "POST",
      headers: { ...authHeader(cfg), "content-type": "application/json" },
      body: JSON.stringify({
        model: args.modelId,
        messages: [{ role: "user", content: args.prompt }],
        modalities: ["image"],
      }),
    },
  );
  await ensureOk(res, "image generation");
  const body = (await res.json()) as {
    choices?: Array<{
      message?: { images?: Array<{ image_url?: { url?: string } }> };
    }>;
  };
  const dataUri = body.choices?.[0]?.message?.images?.[0]?.image_url?.url;
  if (typeof dataUri !== "string" || dataUri.length === 0) {
    // A 200 with no image is a malformed provider response — treat as transient (502) so the
    // step's MEDIA_RETRY re-tries rather than failing hard.
    throw new ProviderHttpError(
      "image generation returned no image data",
      502,
      JSON.stringify(body).slice(0, 500),
    );
  }
  return decodeDataUri(dataUri);
}

export interface FetchedAsset {
  bytes: Buffer;
  contentType: string | null;
}

/**
 * Download a generated asset from a pre-authorized (unauthenticated) URL. NO auth header — the URL
 * is already authorized. Returns the bytes + the response `content-type`. (Generic utility; the
 * image path no longer uses it since real image bytes arrive inline.)
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
 * `POST /api/v1/videos` → 202 `{ id, polling_url, status }`. The `Idempotency-Key` header makes a
 * replayed submit return the SAME job (the #34 crash/replay case).
 */
export async function submitVideoJob(
  cfg: MediaClientConfig,
  args: SubmitVideoJobArgs,
): Promise<VideoJob> {
  const fetchImpl = cfg.fetchImpl ?? fetch;
  const res = await fetchImpl(`${trimSlash(cfg.openrouterBaseUrl)}/api/v1/videos`, {
    method: "POST",
    headers: {
      ...authHeader(cfg),
      "content-type": "application/json",
      "idempotency-key": args.idempotencyKey,
    },
    body: JSON.stringify({ model: args.modelId, ...args.input }),
  });
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
  /**
   * The content download URLs, carried in the poll body once `status === "completed"` (empty
   * while pending/in-progress). Each requires the bearer to download.
   */
  unsignedUrls: string[];
}

/**
 * Poll a video job by its polling URL (`GET {polling_url}`). The real OpenRouter poll body carries
 * `unsigned_urls` once the job completes — there is NO separate JSON content-listing endpoint.
 */
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
  const body = (await res.json()) as {
    id: string;
    status: string;
    unsigned_urls?: string[];
  };
  return {
    id: body.id,
    status: body.status,
    unsignedUrls: body.unsigned_urls ?? [],
  };
}

/**
 * Download raw bytes from a video content URL. The real OpenRouter `unsigned_urls` point back at
 * the OpenRouter API (`…/content?index=0`) and REQUIRE the bearer (401 without) — so this sends
 * auth, unlike {@link fetchAssetBytes}.
 */
export async function downloadBytes(
  cfg: MediaClientConfig,
  url: string,
): Promise<Buffer> {
  const fetchImpl = cfg.fetchImpl ?? fetch;
  const res = await fetchImpl(url, { method: "GET", headers: authHeader(cfg) });
  await ensureOk(res, "download");
  return Buffer.from(await res.arrayBuffer());
}
