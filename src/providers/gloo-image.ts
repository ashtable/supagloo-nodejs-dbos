import { ProviderHttpError } from "./errors";
import type { GlooTradition } from "./faith-alignment";

/**
 * Gloo image generation — `POST {root}/ai/v2/responses` (genesis-1 Inspector, D1).
 *
 * ── Why this module exists ──────────────────────────────────────────────────────────
 *
 * `design-delta` §9-Q2 says "Gloo has no media modalities", and the compatibility matrix
 * encoded that as `image: ["openrouter"]`. For images it is **false**: Gloo's catalogue
 * carries 11 image-capable models (6 image-only, 5 text+image), and a real 1024x768
 * 8-bit RGB PNG was generated from one and decoded on 2026-07-28, reproduced twice.
 *
 * The reason nobody noticed is the ROUTING. Image models are unreachable through the
 * chat/completions surface every other Gloo call in this repo uses. That surface answers:
 *
 *     400  "… does not support text output and cannot be used with the Chat Completions
 *           API. Use the POST /v2/responses endpoint instead."
 *
 * `/ai/v2/responses` has a different request shape (a bare `input` string, not a
 * `messages` array) and a different response shape (an `output` array of typed items)
 * from anything in `media-client.ts`, which is OpenRouter's media surface top to bottom.
 * Hence its own module rather than a branch in there.
 *
 * (For the record, the other three media kinds really are absent: zero catalogue entries
 * match audio/speech/tts/voice/narration/music/video, and those routes answer 404 —
 * route absent — rather than 405. Gloo's backend is FastAPI, so that distinction is
 * trustworthy. Narration, music and video stay openrouter-only, and correctly so.)
 *
 * ── The bytes come back INLINE ──────────────────────────────────────────────────────
 *
 * `output[0] = {type: "image_generation_call", status: "completed", result: "<base64>"}`.
 * There is no URL to fetch afterwards, which is what lets the workflow generate and
 * upload inside a single DBOS step — the bytes-never-checkpointed fold that
 * `generateImage`/`generateAudio` already use.
 *
 * ── Auth ────────────────────────────────────────────────────────────────────────────
 *
 * Takes an already-minted bearer. Token minting stays in `gloo.ts` and happens INSIDE
 * the calling step, per attempt, never cached and never checkpointed — the same shape
 * `generate-script.ts` uses. This function holds no credential state.
 *
 * No model id appears anywhere in this file (`no-model-ids.test.ts` scans this directory,
 * comments included) — the id is always resolved upstream and passed in.
 */

const trimSlash = (u: string) => u.replace(/\/+$/, "");

export interface GlooImageConfig {
  /** The provider ROOT (e.g. the configured Gloo base URL); `/ai/v2/responses` is appended. */
  glooBaseUrl: string;
  /** A freshly-minted Gloo bearer token (see `mintGlooToken`). */
  accessToken: string;
  /** Injectable for unit tests; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
}

export interface RequestGlooImageArgs {
  modelId: string;
  prompt: string;
  /** Faith alignment, already narrowed by `coerceTradition`. Sent ONLY when present —
   *  Gloo treats an absent field and an unrecognised one identically (neutral), so
   *  omitting is the honest representation of "no alignment chosen". Verified to apply on
   *  this surface too: the same request with `tradition` set still returned a valid PNG,
   *  with input tokens rising from 1042 to 14917. */
  tradition?: GlooTradition;
}

export interface GlooImageResult {
  bytes: Buffer;
  contentType: string;
}

/** Strict base64 — `Buffer.from(s, "base64")` silently DISCARDS invalid characters, so a
 *  corrupt payload would otherwise decode to plausible-looking garbage and be uploaded. */
const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

/** Leading-byte signatures. The manifest never records a MIME type, so S3's is the only
 *  one there is — and the studio presigns the object straight into an `<img>`. */
export function sniffImageBytes(bytes: Buffer): string {
  if (bytes.length >= 8 && bytes.subarray(0, 8).toString("hex") === "89504e470d0a1a0a") {
    return "image/png";
  }
  if (bytes.length >= 3 && bytes.subarray(0, 3).toString("hex") === "ffd8ff") {
    return "image/jpeg";
  }
  if (
    bytes.length >= 12 &&
    bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
    bytes.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return "image/webp";
  }
  if (bytes.length >= 6 && bytes.subarray(0, 3).toString("ascii") === "GIF") {
    return "image/gif";
  }
  if (bytes.length >= 12 && bytes.subarray(4, 8).toString("ascii") === "ftyp") {
    // AVIF/HEIF share the ISO-BMFF box header; the brand at offset 8 distinguishes them,
    // but for our purposes anything in this family is a still image.
    return "image/avif";
  }
  // Deliberately not a throw: a format we do not recognise is still an image the browser
  // will sniff for itself, and refusing it would make us the reason a working model fails.
  return "application/octet-stream";
}

interface ResponsesBody {
  output?: Array<{ type?: unknown; status?: unknown; result?: unknown }>;
}

/**
 * Generate an image through Gloo's responses surface. Returns the decoded bytes and a
 * sniffed content type. Throws `ProviderHttpError` on a non-2xx (the status is carried so
 * the step's classifier can call 4xx permanent and 5xx transient) or, with a deliberately
 * TRANSIENT 502, on a 200 that carries no usable image.
 */
export async function requestGlooImage(
  cfg: GlooImageConfig,
  args: RequestGlooImageArgs,
): Promise<GlooImageResult> {
  const fetchImpl = cfg.fetchImpl ?? fetch;

  const body: Record<string, unknown> = {
    model: args.modelId,
    input: args.prompt,
  };
  if (args.tradition) body.tradition = args.tradition;

  const res = await fetchImpl(`${trimSlash(cfg.glooBaseUrl)}/ai/v2/responses`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${cfg.accessToken}`,
      "content-type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    throw new ProviderHttpError(
      `Gloo image generation failed: ${res.status}`,
      res.status,
      await res.text().catch(() => undefined),
    );
  }

  const parsed = (await res.json().catch(() => ({}))) as ResponsesBody;
  const call = (parsed.output ?? []).find(
    (o) =>
      o?.type === "image_generation_call" &&
      o?.status === "completed" &&
      typeof o?.result === "string" &&
      (o.result as string).length > 0,
  );
  const base64 = call?.result as string | undefined;
  if (!base64 || !BASE64_RE.test(base64)) {
    // A 200 with no usable image is a malformed provider response. Classed TRANSIENT
    // (502) so MEDIA_RETRY re-tries rather than burning the row — the same call
    // `requestImage` makes for OpenRouter's image-less 200.
    throw new ProviderHttpError(
      "Gloo image generation returned no completed image output",
      502,
      JSON.stringify(parsed).slice(0, 500),
    );
  }

  const bytes = Buffer.from(base64, "base64");
  if (bytes.length === 0) {
    throw new ProviderHttpError(
      "Gloo image generation returned an empty image payload",
      502,
    );
  }
  return { bytes, contentType: sniffImageBytes(bytes) };
}
