import { ProviderHttpError } from "./errors";

/**
 * Direct-`fetch` media client (design-delta §7 / memory openrouter-media-and-ai-sdk-split).
 * Media generation is NOT done through the AI SDK. As CONFIRMED against the live OpenRouter API
 * (task 34-E4 expanded scope), the real contracts are:
 *
 *   - IMAGE  → NON-streaming chat-completions with `modalities:["image"]`; the image comes back
 *              as a base64 `data:` URI inline in `choices[0].message.images[0].image_url.url`
 *              (there is NO `/api/v1/images/generations` endpoint on real OpenRouter).
 *   - SPEECH → `POST /api/v1/audio/speech`, the DEDICATED batch-synthesis endpoint:
 *              `{model, input, voice, response_format:"mp3"|"pcm"}` → the audio bytes as the
 *              response body. It has its OWN model catalogue
 *              (`GET /api/v1/models?output_modalities=speech`, 15 models live) which is
 *              DISJOINT from `output_modalities=audio`. Narration uses this.
 *
 *              CORRECTION (this bullet previously asserted, as a confirmed fact, that no such
 *              endpoint existed and that mp3 was rejected). Both claims were wrong, and the
 *              cost of believing them was bug 1: narration was routed through the
 *              conversational chat path instead, where the model REPLIED to the verse rather
 *              than reading it. Re-verified live before this change.
 *   - MUSIC  → STREAMING chat-completions with `modalities:["text","audio"]` +
 *              `audio:{format:"pcm16"}` + `stream:true`; the SSE stream carries
 *              `choices[0].delta.audio.data` base64 chunks. The music models have no entry in
 *              the speech catalogue, so music stays here. NOTE: they IGNORE the requested `format`
 *              and
 *              always returns ID3-tagged MP3 (44.1 kHz stereo) — the payload is sniffed, never
 *              assumed (see `sniffAudioBytes`).
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

// --- container sniffing + duration measurement ----------------------------------

/**
 * Decide what the provider ACTUALLY sent, and only WAV-wrap when the bytes really are raw
 * PCM16.
 *
 * This exists because the shipped code did not ask. It called {@link wavFromPcm16}
 * unconditionally on whatever came back from the audio stream, hard-declaring 24 kHz mono
 * PCM16 in the RIFF header. Verified live against real OpenRouter:
 * the discovered music model returns **ID3-tagged MPEG1 Layer III, 44.1 kHz stereo** —
 * and returns it identically whether you ask for `format:"pcm16"`, `"wav"` or `"mp3"`; it
 * ignores the field entirely. Bolting a RIFF header onto MP3 frames produces a file whose
 * declared length is `bytes / (24000 * 2)`: a real 29.07 s bed announced itself as 14.66 s.
 * That is the music "ending early", manufactured on our side of the wire with no provider
 * variance involved at all.
 *
 * Sniffing rather than trusting the requested format is the point — the format we ask for
 * has been proven not to be the format we get.
 */
export function sniffAudioBytes(bytes: Buffer): {
  bytes: Buffer;
  contentType: string;
} {
  if (isMpeg(bytes)) return { bytes, contentType: "audio/mpeg" };
  if (bytes.subarray(0, 4).toString("ascii") === "RIFF") {
    return { bytes, contentType: "audio/wav" };
  }
  // Everything else is treated as the raw little-endian PCM16 that the chat-audio contract
  // documents (correct for the conversational-audio models' 24 kHz mono stream).
  return { bytes: wavFromPcm16(bytes), contentType: "audio/wav" };
}

/** `ID3` tag or a raw MPEG frame sync (`FF Ex/Fx`). */
function isMpeg(bytes: Buffer): boolean {
  if (bytes.subarray(0, 3).toString("ascii") === "ID3") return true;
  return bytes.length >= 2 && bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0;
}

/** MPEG version bits → the three sample rates that version indexes. */
const MPEG_SAMPLE_RATES: Record<number, [number, number, number]> = {
  3: [44100, 48000, 32000], // MPEG1
  2: [22050, 24000, 16000], // MPEG2
  0: [11025, 12000, 8000], // MPEG2.5
};
const MPEG1_LAYER3_BITRATES = [
  0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0,
];
const MPEG2_LAYER3_BITRATES = [
  0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0,
];

/**
 * MEASURE how long an audio buffer actually is, in seconds — or return `null` when the bytes
 * cannot be measured honestly.
 *
 * Every sync decision downstream is built on this number: a scene stretches to fit its own
 * narration, and the music bed is looped `ceil(total / measured)` times to cover the video.
 * Both are wrong if the length is guessed, so a fabricated answer is worse than no answer —
 * `null` makes the composition fall back to the un-looped `<Audio>` it emitted before,
 * which is merely the old behaviour rather than a new, subtly mis-timed one.
 *
 * MP3 is walked frame by frame (`samplesPerFrame / sampleRate` summed) rather than estimated
 * from a bitrate, because VBR output would make an estimate wrong. Hand-rolled at ~60 lines
 * instead of pulling in a parser: the bytes go provider → S3 without ever touching disk, and
 * `@remotion/media-parser` is async and source-based, so using it would mean writing a temp
 * file inside a DBOS step purely to measure it.
 */
export function audioDurationSeconds(bytes: Buffer): number | null {
  if (isMpeg(bytes)) return mp3DurationSeconds(bytes);
  if (bytes.subarray(0, 4).toString("ascii") === "RIFF") return wavDurationSeconds(bytes);
  return null;
}

function mp3DurationSeconds(bytes: Buffer): number | null {
  let offset = 0;
  // Skip an ID3v2 tag — its 4 size bytes are "synchsafe" (7 significant bits each).
  if (bytes.subarray(0, 3).toString("ascii") === "ID3" && bytes.length >= 10) {
    offset =
      10 +
      (((bytes[6] & 0x7f) << 21) |
        ((bytes[7] & 0x7f) << 14) |
        ((bytes[8] & 0x7f) << 7) |
        (bytes[9] & 0x7f));
  }

  let seconds = 0;
  let frames = 0;
  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff || (bytes[offset + 1] & 0xe0) !== 0xe0) {
      offset += 1;
      continue;
    }
    const version = (bytes[offset + 1] >> 3) & 0x03;
    const layer = (bytes[offset + 1] >> 1) & 0x03; // 1 === Layer III
    const bitrateIndex = (bytes[offset + 2] >> 4) & 0x0f;
    const rateIndex = (bytes[offset + 2] >> 2) & 0x03;
    const padding = (bytes[offset + 2] >> 1) & 0x01;
    const rates = MPEG_SAMPLE_RATES[version];
    if (layer !== 1 || rateIndex === 3 || bitrateIndex === 0 || bitrateIndex === 15 || !rates) {
      offset += 1;
      continue;
    }
    const sampleRate = rates[rateIndex];
    const bitrate =
      (version === 3
        ? MPEG1_LAYER3_BITRATES[bitrateIndex]
        : MPEG2_LAYER3_BITRATES[bitrateIndex]) * 1000;
    const samplesPerFrame = version === 3 ? 1152 : 576;
    const frameLength =
      Math.floor((samplesPerFrame / 8) * (bitrate / sampleRate)) + padding;
    if (frameLength < 4) {
      offset += 1;
      continue;
    }
    frames += 1;
    seconds += samplesPerFrame / sampleRate;
    offset += frameLength;
  }
  return frames > 0 ? seconds : null;
}

/** Walk RIFF chunks for `fmt ` (byte rate) and `data` (payload size). */
function wavDurationSeconds(bytes: Buffer): number | null {
  let offset = 12; // past "RIFF" + size + "WAVE"
  let byteRate: number | null = null;
  while (offset + 8 <= bytes.length) {
    const id = bytes.subarray(offset, offset + 4).toString("ascii");
    const size = bytes.readUInt32LE(offset + 4);
    if (id === "fmt " && offset + 8 + 16 <= bytes.length) {
      byteRate = bytes.readUInt32LE(offset + 16);
    } else if (id === "data") {
      if (!byteRate) return null;
      // Trust the smaller of the declared size and what is really present, so a truncated
      // download is never reported as its declared length.
      return Math.min(size, bytes.length - (offset + 8)) / byteRate;
    }
    offset += 8 + size + (size % 2); // chunks are word-aligned
  }
  return null;
}

// --- TTS / speech (narration) ---------------------------------------------------

/**
 * The provider voice used when a caller does not name one. The endpoint REQUIRES a voice
 * (verified live: omitting it returns a Zod `invalid_type` on `["voice"]`), and the
 * manifest's freeform voice DESCRIPTOR ("JAMES EARL JONES-STYLE") is not a provider voice id.
 */
export const DEFAULT_NARRATION_VOICE = "alloy";

export interface RequestSpeechArgs {
  modelId: string;
  /** The text to speak, VERBATIM. */
  input: string;
  /** A provider voice id (model-specific vocabulary); defaults to `"alloy"`. */
  voice?: string;
}

export interface SpeechResult {
  /** The audio bytes exactly as the provider encoded them. */
  bytes: Buffer;
  /** The provider audio-delta `id`, where the transport carries one. */
  generationId: string | null;
  contentType: string;
  /** MEASURED playback length; `null` when the container cannot be parsed. */
  durationSeconds: number | null;
}

/**
 * Synthesize narration via `POST /api/v1/audio/speech` — OpenRouter's DEDICATED batch
 * speech endpoint.
 *
 * ## Why this replaced the chat-completions path
 *
 * The previous implementation posted the verse as a `user` turn to a conversational audio
 * model with no system message. Given "In the beginning God created the heaven and the
 * earth." a chat model does what chat models do — it answers. Reproduced live, verbatim:
 *
 *   > "It sounds like you're quoting from the Book of Genesis in the Bible. That first
 *   >  verse is often recognized as the opening line: … If you're interested in exploring
 *   >  more about it or discussing its meaning, let me know."
 *
 * 16.4 s of spoken commentary in place of a 3.5 s verse. This endpoint takes an `input`
 * STRING and has no `messages` array at all, so there is no turn for a model to reply to.
 * The guarantee is structural, not a matter of prompting well.
 *
 * ## The live contract (verified against real openrouter.ai, not inferred)
 *
 * The comment this replaces asserted "there is NO `/api/v1/audio/speech` endpoint" as a
 * confirmed fact. It is there, and it has its own Zod-validated schema:
 *   - `voice` is REQUIRED;
 *   - `response_format` ∈ {`"mp3"`, `"pcm"`} — `"wav"` is rejected by name;
 *   - it has its OWN model catalogue (`GET /api/v1/models?output_modalities=speech`, 15
 *     models), disjoint from `output_modalities=audio`. The conversational audio model the
 *     old path used is rejected here outright with `400 Model … does not exist`.
 *
 * A discovered speech model + `voice:"alloy"` + `response_format:"mp3"` returned 200
 * `audio/mpeg`, 24072 bytes, 147 MPEG2 frames = 3.528 s for Genesis 1:1.
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
        voice: args.voice ?? DEFAULT_NARRATION_VOICE,
        response_format: "mp3",
      }),
    },
  );
  await ensureOk(res, "speech");
  const raw = Buffer.from(await res.arrayBuffer());
  if (raw.length === 0) {
    // A 200 with no audio is a malformed provider response — transient (502) so the step's
    // MEDIA_RETRY re-tries rather than failing the generation permanently.
    throw new ProviderHttpError("speech returned no audio data", 502);
  }
  const sniffed = sniffAudioBytes(raw);
  return {
    ...sniffed,
    generationId: null,
    durationSeconds: audioDurationSeconds(sniffed.bytes),
  };
}

// --- Music ----------------------------------------------------------------------

export interface RequestMusicArgs {
  modelId: string;
  /** The music-style prompt. */
  input: string;
}

/**
 * Generate a music bed via STREAMING chat-completions (`modalities:["text","audio"]`,
 * `stream:true`, no `voice`) — the contract Lyria really speaks. Music deliberately does NOT
 * move to `/api/v1/audio/speech`: verified live, that endpoint's catalogue
 * (`output_modalities=speech`) contains no music model and rejects the Lyria ids outright.
 *
 * The difference from before is what happens to the bytes. They are now sniffed and passed
 * through as the provider encoded them (see {@link sniffAudioBytes}) and MEASURED, instead of
 * being force-wrapped in a RIFF header that lied about their sample rate and halved their
 * apparent length.
 *
 * NO duration parameter is sent. Verified live, `supported_parameters` for both
 * both discovered music models is
 * `["max_tokens","response_format","seed","temperature","top_p"]` — length is a property of
 * the model chosen (clip ≈ 30 s, pro = a full-length song), not something a request can ask
 * for. Covering the whole video is therefore the composition's job: it loops the measured
 * track. Inventing a parameter the provider does not document would be exactly the kind of
 * unverified contract this file has already been burned by once.
 */
export async function requestMusic(
  cfg: MediaClientConfig,
  args: RequestMusicArgs,
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
        audio: { format: "pcm16" },
        stream: true,
      }),
    },
  );
  await ensureOk(res, "music");
  const { pcm, generationId } = parseAudioStream(await res.text());
  if (pcm.length === 0) {
    throw new ProviderHttpError("music returned no audio data", 502);
  }
  const sniffed = sniffAudioBytes(pcm);
  return {
    ...sniffed,
    generationId,
    durationSeconds: audioDurationSeconds(sniffed.bytes),
  };
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
