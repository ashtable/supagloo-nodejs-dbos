import { describe, it, expect } from "vitest";
import { ProviderHttpError, retryUnlessPermanent } from "./errors";
import {
  audioDurationSeconds,
  decodeDataUri,
  downloadBytes,
  fetchAssetBytes,
  getVideoJob,
  parseAudioStream,
  requestImage,
  requestMusic,
  requestSpeech,
  sniffAudioBytes,
  submitVideoJob,
  wavFromPcm16,
} from "./media-client";

// Media generation is direct `fetch` (NOT the AI SDK). The contracts below are the REAL
// OpenRouter shapes confirmed live in task 34-E4 (expanded scope): image via non-streaming
// chat-completions `modalities:["image"]` (inline base64 data URI), audio via STREAMING
// chat-completions `modalities:["text","audio"]` (SSE `delta.audio.data` PCM16 → WAV), and video
// content via the poll body's `unsigned_urls` (downloaded WITH the bearer). Injected fetch.

const CFG = {
  openrouterBaseUrl: "https://openrouter.ai",
  apiKey: "sk-or-test",
};

interface Req {
  url: string;
  method?: string;
  headers: Headers;
  body: string;
}

function recorder(handler: (req: Req) => Response): {
  reqs: Req[];
  fetch: typeof fetch;
} {
  const reqs: Req[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const req: Req = {
      url: String(url),
      method: init?.method,
      headers: new Headers(init?.headers),
      body: typeof init?.body === "string" ? init.body : "",
    };
    reqs.push(req);
    return handler(req);
  }) as unknown as typeof fetch;
  return { reqs, fetch: fetchImpl };
}

/** Build an OpenRouter chat-completions audio SSE stream from base64 PCM16 chunks. */
function audioSse(
  chunks: string[],
  opts: { id?: string } = {},
): string {
  const lines: string[] = [": OPENROUTER PROCESSING", ""];
  chunks.forEach((data, i) => {
    const audio: Record<string, unknown> = { data };
    if (i === 0 && opts.id) audio.id = opts.id;
    lines.push(
      `data: ${JSON.stringify({ choices: [{ delta: { audio } }] })}`,
      "",
    );
  });
  lines.push("data: [DONE]", "");
  return lines.join("\n");
}

describe("decodeDataUri", () => {
  it("decodes a base64 data URI to bytes + content type", () => {
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    const uri = `data:image/png;base64,${bytes.toString("base64")}`;
    const out = decodeDataUri(uri);
    expect(out.contentType).toBe("image/png");
    expect(out.bytes.equals(bytes)).toBe(true);
  });

  it("throws a 502 on a non-base64 data URI", () => {
    const err = (() => {
      try {
        decodeDataUri("data:image/png,rawtext");
        return null;
      } catch (e) {
        return e;
      }
    })();
    expect(err).toBeInstanceOf(ProviderHttpError);
  });
});

describe("wavFromPcm16", () => {
  it("prepends a valid 44-byte RIFF/WAVE header around the PCM data", () => {
    const pcm = Buffer.from([0x01, 0x02, 0x03, 0x04, 0x05, 0x06]);
    const wav = wavFromPcm16(pcm, { sampleRate: 24000, channels: 1 });
    expect(wav.subarray(0, 4).toString("ascii")).toBe("RIFF");
    expect(wav.subarray(8, 12).toString("ascii")).toBe("WAVE");
    expect(wav.subarray(36, 40).toString("ascii")).toBe("data");
    expect(wav.readUInt32LE(40)).toBe(pcm.length);
    expect(wav.readUInt32LE(24)).toBe(24000); // sample rate
    expect(wav.subarray(44).equals(pcm)).toBe(true);
  });
});

describe("parseAudioStream", () => {
  it("concatenates base64 PCM16 deltas (decoded independently) and captures the id", () => {
    const a = Buffer.from([0x01, 0x02]);
    const b = Buffer.from([0x03, 0x04, 0x05]);
    const sse = audioSse([a.toString("base64"), b.toString("base64")], { id: "gen_7" });
    const { pcm, generationId } = parseAudioStream(sse);
    expect(pcm.equals(Buffer.concat([a, b]))).toBe(true);
    expect(generationId).toBe("gen_7");
  });

  it("ignores comment lines, blank data, and [DONE]", () => {
    const { pcm } = parseAudioStream(": keep-alive\n\ndata: [DONE]\n");
    expect(pcm.length).toBe(0);
  });
});

/**
 * Fixture MP3 frames, hand-built from the MPEG audio frame-header spec. These are the
 * exact two shapes the real providers return (verified live):
 *   - MPEG2 Layer III, 24 kHz mono, 64 kbps — `hexgrad/kokoro-82m` via /audio/speech
 *     (real magic `ff f3 84 c4`, 147 frames, 3.528 s)
 *   - MPEG1 Layer III, 44.1 kHz stereo, 128 kbps — `google/lyria-3-clip-preview`
 *     (real magic `49 44 33` ID3 tag then MPEG1 frames, ~1100 frames, ~29 s)
 */
function mp3Frames(
  kind: "mpeg2-24k-mono" | "mpeg1-44k-stereo",
  count: number,
): Buffer {
  const spec =
    kind === "mpeg2-24k-mono"
      ? { b1: 0xf3, b2: 0x84, b3: 0xc0, len: 192, secs: 576 / 24000 }
      : { b1: 0xfb, b2: 0x90, b3: 0x00, len: 417, secs: 1152 / 44100 };
  const frames: Buffer[] = [];
  for (let i = 0; i < count; i++) {
    const f = Buffer.alloc(spec.len);
    f[0] = 0xff;
    f[1] = spec.b1;
    f[2] = spec.b2;
    f[3] = spec.b3;
    frames.push(f);
  }
  return Buffer.concat(frames);
}

/** Wrap bytes in a minimal ID3v2.3 tag, exactly as Lyria's real output arrives. */
function withId3(payload: Buffer, tagSize = 32): Buffer {
  const tag = Buffer.alloc(10 + tagSize);
  tag.write("ID3", 0, "ascii");
  tag[3] = 3; // v2.3
  // 28-bit synchsafe size of the tag body (excludes the 10-byte header).
  tag[6] = (tagSize >> 21) & 0x7f;
  tag[7] = (tagSize >> 14) & 0x7f;
  tag[8] = (tagSize >> 7) & 0x7f;
  tag[9] = tagSize & 0x7f;
  return Buffer.concat([tag, payload]);
}

describe("sniffAudioBytes — the container the provider ACTUALLY sent", () => {
  /**
   * The music bug's dominant cause. `google/lyria-3-clip-preview` was asked for
   * `format:"pcm16"` and returned ID3-tagged MP3 anyway — verified live, identically for
   * `pcm16`, `wav` AND `mp3`. The shipped code then called `wavFromPcm16` on those MP3
   * bytes, prepending a RIFF header declaring 24 kHz mono PCM16. A decoder honours the
   * header, so a 29.07 s track was announced as 703859/(24000*2) = 14.66 s — the music
   * "ending early" was manufactured entirely inside our own code.
   */
  it("U-M1: passes ID3-tagged MP3 through UNTOUCHED as audio/mpeg (the Lyria regression)", () => {
    const mp3 = withId3(mp3Frames("mpeg1-44k-stereo", 4));
    const out = sniffAudioBytes(mp3);
    expect(out.contentType).toBe("audio/mpeg");
    expect(out.bytes.equals(mp3)).toBe(true);
    // The specific corruption that shipped: a RIFF header must NEVER be bolted on.
    expect(out.bytes.subarray(0, 4).toString("ascii")).not.toBe("RIFF");
  });

  it("U-M2: passes a bare MPEG frame stream (no ID3) through as audio/mpeg", () => {
    const mp3 = mp3Frames("mpeg2-24k-mono", 3);
    const out = sniffAudioBytes(mp3);
    expect(out.contentType).toBe("audio/mpeg");
    expect(out.bytes.equals(mp3)).toBe(true);
  });

  it("U-M3: passes an existing RIFF/WAVE container through untouched", () => {
    const wav = wavFromPcm16(Buffer.from([1, 2, 3, 4]));
    const out = sniffAudioBytes(wav);
    expect(out.contentType).toBe("audio/wav");
    expect(out.bytes.equals(wav)).toBe(true);
  });

  it("U-M4: WAV-wraps anything else, which is the real raw-PCM16 case", () => {
    const pcm = Buffer.from([0x10, 0x11, 0x12, 0x13]);
    const out = sniffAudioBytes(pcm);
    expect(out.contentType).toBe("audio/wav");
    expect(out.bytes.subarray(0, 4).toString("ascii")).toBe("RIFF");
    expect(out.bytes.subarray(44).equals(pcm)).toBe(true);
  });
});

describe("audioDurationSeconds — MEASURED length, the input to every sync decision", () => {
  it("U-M5: measures an MPEG2 24 kHz mono stream frame-by-frame", () => {
    // 147 frames is exactly what the real kokoro synthesis of Genesis 1:1 returned;
    // 147 * 576/24000 = 3.528 s, which is what this parser must reproduce.
    const bytes = mp3Frames("mpeg2-24k-mono", 147);
    expect(audioDurationSeconds(bytes)).toBeCloseTo(3.528, 6);
  });

  it("U-M6: measures an MPEG1 44.1 kHz stereo stream and SKIPS the ID3 tag", () => {
    const frames = 1178; // the real lyria clip length measured live
    const tagged = withId3(mp3Frames("mpeg1-44k-stereo", frames));
    expect(audioDurationSeconds(tagged)).toBeCloseTo(frames * (1152 / 44100), 6);
    // Identical answer with and without the tag — the tag must not be counted as audio.
    expect(audioDurationSeconds(mp3Frames("mpeg1-44k-stereo", frames))).toBeCloseTo(
      audioDurationSeconds(tagged) as number,
      6,
    );
  });

  it("U-M7: measures a WAV from its own header rather than guessing", () => {
    const pcm = Buffer.alloc(24_000 * 2 * 2); // 2 s at 24 kHz mono PCM16
    expect(audioDurationSeconds(wavFromPcm16(pcm))).toBeCloseTo(2, 6);
  });

  it("U-M8: returns null for bytes it cannot honestly measure", () => {
    // Better an absent duration than a fabricated one: an absent measurement makes the
    // composition fall back to the un-looped <Audio> it emits today, whereas a wrong
    // number would silently mis-time every scene.
    expect(audioDurationSeconds(Buffer.from("not audio at all"))).toBeNull();
  });
});

describe("requestSpeech — the DEDICATED /api/v1/audio/speech endpoint", () => {
  /**
   * Bug 1. The shipped implementation posted the verse as a `user` turn to a
   * CONVERSATIONAL audio model with no system message, and the model answered it.
   * Verified live against real OpenRouter with the shipped body:
   *
   *   input:  "In the beginning God created the heaven and the earth."
   *   spoken: "It sounds like you're quoting from the Book of Genesis in the Bible. …"
   *
   * 16.4 s of commentary for a 3.5 s verse — exactly the reported symptom.
   *
   * The fix is structural rather than persuasive. `/api/v1/audio/speech` (verified live:
   * 200 `audio/mpeg` for `hexgrad/kokoro-82m`) is a batch synthesis endpoint that takes an
   * `input` STRING. It has no `messages` array, so there is no conversational turn for a
   * model to reply to — a chat reply is not a thing this request can produce. That is why
   * the assertions below are written as ABSENCES: they are the whole point.
   */
  it("U-M9: posts input/voice/response_format and carries NO chat turn at all", async () => {
    const mp3 = mp3Frames("mpeg2-24k-mono", 147);
    const rec = recorder(
      () =>
        new Response(mp3, {
          status: 200,
          headers: { "content-type": "audio/mpeg" },
        }),
    );
    const result = await requestSpeech(
      { ...CFG, fetchImpl: rec.fetch },
      { modelId: "hexgrad/kokoro-82m", input: "In the beginning", voice: "alloy" },
    );

    const req = rec.reqs[0];
    expect(req.url).toBe("https://openrouter.ai/api/v1/audio/speech");
    expect(req.method).toBe("POST");
    expect(req.headers.get("authorization")).toBe("Bearer sk-or-test");

    const body = JSON.parse(req.body);
    // The bug-1 regression assertions — a conversational reply is UNREACHABLE from here.
    expect(body).not.toHaveProperty("messages");
    expect(body).not.toHaveProperty("modalities");
    expect(body).not.toHaveProperty("stream");
    expect(body).toEqual({
      model: "hexgrad/kokoro-82m",
      input: "In the beginning",
      voice: "alloy",
      response_format: "mp3",
    });

    expect(result.contentType).toBe("audio/mpeg");
    expect(result.bytes.equals(mp3)).toBe(true);
    expect(result.durationSeconds).toBeCloseTo(3.528, 6);
  });

  it("U-M10: always sends a voice — the live endpoint rejects the request without one", async () => {
    // Verified live: omitting `voice` returns
    // `{"code":"invalid_type","path":["voice"],"message":"expected string, received undefined"}`.
    const rec = recorder(
      () => new Response(mp3Frames("mpeg2-24k-mono", 2), { status: 200 }),
    );
    await requestSpeech(
      { ...CFG, fetchImpl: rec.fetch },
      { modelId: "hexgrad/kokoro-82m", input: "x" },
    );
    expect(typeof JSON.parse(rec.reqs[0].body).voice).toBe("string");
    expect(JSON.parse(rec.reqs[0].body).voice.length).toBeGreaterThan(0);
  });

  it("U-M11: surfaces a non-2xx as a ProviderHttpError", async () => {
    const rec = recorder(() => new Response("nope", { status: 500 }));
    await expect(
      requestSpeech(
        { ...CFG, fetchImpl: rec.fetch },
        { modelId: "m", input: "x", voice: "alloy" },
      ),
    ).rejects.toBeInstanceOf(ProviderHttpError);
  });

  it("U-M12: treats an empty 200 body as a transient 502 so MEDIA_RETRY re-tries", async () => {
    const rec = recorder(() => new Response(Buffer.alloc(0), { status: 200 }));
    const err = await requestSpeech(
      { ...CFG, fetchImpl: rec.fetch },
      { modelId: "m", input: "x", voice: "alloy" },
    ).catch((e) => e);
    expect(err).toBeInstanceOf(ProviderHttpError);
    expect((err as ProviderHttpError).status).toBe(502);
  });

  it("U-M13: 503-then-200 is retryable and then succeeds", async () => {
    const mp3 = mp3Frames("mpeg2-24k-mono", 5);
    const queue: Array<() => Response> = [
      () => new Response("busy", { status: 503 }),
      () => new Response(mp3, { status: 200 }),
    ];
    const rec = recorder(() => queue.shift()!());
    const args = { modelId: "hexgrad/kokoro-82m", input: "hi", voice: "alloy" };

    const transient = await requestSpeech({ ...CFG, fetchImpl: rec.fetch }, args).catch(
      (e) => e,
    );
    expect(transient).toBeInstanceOf(ProviderHttpError);
    expect(retryUnlessPermanent(transient)).toBe(true);

    const result = await requestSpeech({ ...CFG, fetchImpl: rec.fetch }, args);
    expect(result.bytes.equals(mp3)).toBe(true);
    expect(rec.reqs).toHaveLength(2);
  });
});

describe("requestMusic — streaming chat-audio, bytes preserved as sent", () => {
  it("U-M14: keeps the streaming chat contract (Lyria has no /audio/speech entry)", async () => {
    // Verified live: `/api/v1/audio/speech` answers `400 Model … does not exist` for the
    // audio-modality models, and the `output_modalities=speech` catalogue does not contain
    // Lyria. Music therefore stays on the chat-completions audio path.
    const mp3 = withId3(mp3Frames("mpeg1-44k-stereo", 1113));
    const rec = recorder(
      () =>
        new Response(audioSse([mp3.toString("base64")], { id: "gen-lyria" }), {
          status: 200,
        }),
    );
    const result = await requestMusic(
      { ...CFG, fetchImpl: rec.fetch },
      { modelId: "google/lyria-3-clip-preview", input: "ambient worship pads" },
    );

    const body = JSON.parse(rec.reqs[0].body);
    expect(rec.reqs[0].url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(body.stream).toBe(true);
    expect(body.modalities).toEqual(["text", "audio"]);
    expect(body.audio).not.toHaveProperty("voice");

    // The heart of the music fix: the provider's MP3 survives intact and is measured
    // honestly, instead of being mislabelled as 24 kHz mono PCM.
    expect(result.contentType).toBe("audio/mpeg");
    expect(result.bytes.equals(mp3)).toBe(true);
    expect(result.durationSeconds).toBeCloseTo(1113 * (1152 / 44100), 6);
    expect(result.generationId).toBe("gen-lyria");
  });

  it("U-M15: does NOT send a duration parameter, because no music model supports one", async () => {
    // Verified live: `supported_parameters` for BOTH lyria models is
    // ["max_tokens","response_format","seed","temperature","top_p"]. Sending a length is
    // an invented contract, which is the exact failure mode this repo has been burned by.
    const rec = recorder(
      () =>
        new Response(
          audioSse([mp3Frames("mpeg1-44k-stereo", 2).toString("base64")]),
          { status: 200 },
        ),
    );
    await requestMusic(
      { ...CFG, fetchImpl: rec.fetch },
      { modelId: "google/lyria-3-clip-preview", input: "pads" },
    );
    const body = JSON.parse(rec.reqs[0].body);
    for (const k of ["duration", "duration_seconds", "durationSeconds", "length"]) {
      expect(body).not.toHaveProperty(k);
    }
  });

  it("U-M16: still WAV-wraps a model that really does return raw PCM16", async () => {
    const pcm = Buffer.from([0x01, 0x02, 0x03, 0x04]);
    const rec = recorder(
      () => new Response(audioSse([pcm.toString("base64")]), { status: 200 }),
    );
    const result = await requestMusic(
      { ...CFG, fetchImpl: rec.fetch },
      { modelId: "some/pcm-music", input: "pads" },
    );
    expect(result.contentType).toBe("audio/wav");
    expect(result.bytes.subarray(44).equals(pcm)).toBe(true);
  });
});

describe("requestImage (chat-completions modalities:['image'] → inline base64 bytes)", () => {
  const okResponse = (dataUri: string) =>
    new Response(
      JSON.stringify({
        choices: [{ message: { images: [{ image_url: { url: dataUri } }] } }],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );

  it("POSTs chat/completions with modalities image and decodes the data URI to bytes", async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d]);
    const rec = recorder(() => okResponse(`data:image/png;base64,${png.toString("base64")}`));
    const result = await requestImage(
      { ...CFG, fetchImpl: rec.fetch },
      { modelId: "x-ai/grok-imagine-image-quality", prompt: "a serene sunrise over hills" },
    );
    expect(result.contentType).toBe("image/png");
    expect(result.bytes.equals(png)).toBe(true);

    const req = rec.reqs[0];
    expect(req.url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(req.method).toBe("POST");
    expect(req.headers.get("authorization")).toBe("Bearer sk-or-test");
    const body = JSON.parse(req.body);
    expect(body.model).toBe("x-ai/grok-imagine-image-quality");
    expect(body.modalities).toEqual(["image"]);
    expect(body.messages[0].content).toBe("a serene sunrise over hills");
  });

  it("classifies a 503 as transient", async () => {
    const rec = recorder(() => new Response("busy", { status: 503 }));
    const err = await requestImage(
      { ...CFG, fetchImpl: rec.fetch },
      { modelId: "m", prompt: "x" },
    ).catch((e) => e);
    expect(err).toBeInstanceOf(ProviderHttpError);
    expect((err as ProviderHttpError).status).toBe(503);
    expect(retryUnlessPermanent(err)).toBe(true);
  });

  it("classifies a 400 as permanent", async () => {
    const rec = recorder(() => new Response("bad", { status: 400 }));
    const err = await requestImage(
      { ...CFG, fetchImpl: rec.fetch },
      { modelId: "m", prompt: "x" },
    ).catch((e) => e);
    expect(err).toBeInstanceOf(ProviderHttpError);
    expect(retryUnlessPermanent(err)).toBe(false);
  });

  it("throws a 502 when a 200 body carries no image", async () => {
    const rec = recorder(
      () =>
        new Response(JSON.stringify({ choices: [{ message: {} }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    const err = await requestImage(
      { ...CFG, fetchImpl: rec.fetch },
      { modelId: "m", prompt: "x" },
    ).catch((e) => e);
    expect(err).toBeInstanceOf(ProviderHttpError);
    expect((err as ProviderHttpError).status).toBe(502);
  });
});

describe("fetchAssetBytes (generic pre-authorized download — no auth header)", () => {
  it("GETs the URL with NO auth header and returns the bytes + content-type", async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    const rec = recorder(
      () => new Response(png, { status: 200, headers: { "content-type": "image/png" } }),
    );
    const { bytes, contentType } = await fetchAssetBytes(
      { ...CFG, fetchImpl: rec.fetch },
      "https://cdn.example/img/abc.png",
    );
    expect(bytes.equals(png)).toBe(true);
    expect(contentType).toBe("image/png");
    expect(rec.reqs[0].headers.get("authorization")).toBeNull();
  });

  it("surfaces a non-2xx download as a ProviderHttpError", async () => {
    const rec = recorder(() => new Response("gone", { status: 404 }));
    await expect(
      fetchAssetBytes({ ...CFG, fetchImpl: rec.fetch }, "https://cdn.example/x"),
    ).rejects.toBeInstanceOf(ProviderHttpError);
  });
});

describe("submitVideoJob", () => {
  it("sends the Idempotency-Key header and parses the 202 job envelope", async () => {
    const rec = recorder(
      () =>
        new Response(
          JSON.stringify({
            id: "vid_1",
            polling_url: "https://openrouter.ai/api/v1/videos/vid_1",
            status: "pending",
          }),
          { status: 202, headers: { "content-type": "application/json" } },
        ),
    );
    const job = await submitVideoJob(
      { ...CFG, fetchImpl: rec.fetch },
      { modelId: "resolved/video-model", input: { prompt: "a dove" }, idempotencyKey: "job-abc" },
    );
    expect(job).toEqual({
      id: "vid_1",
      pollingUrl: "https://openrouter.ai/api/v1/videos/vid_1",
      status: "pending",
    });
    expect(rec.reqs[0].url).toBe("https://openrouter.ai/api/v1/videos");
    expect(rec.reqs[0].headers.get("idempotency-key")).toBe("job-abc");
  });

  it("surfaces a non-2xx submit as a ProviderHttpError", async () => {
    const rec = recorder(() => new Response("bad", { status: 400 }));
    await expect(
      submitVideoJob(
        { ...CFG, fetchImpl: rec.fetch },
        { modelId: "m", input: {}, idempotencyKey: "k" },
      ),
    ).rejects.toBeInstanceOf(ProviderHttpError);
  });
});

describe("getVideoJob (poll body carries unsigned_urls) / downloadBytes (authed)", () => {
  it("polls a job status and surfaces unsigned_urls from the poll body", async () => {
    const rec = recorder(
      () =>
        new Response(
          JSON.stringify({
            id: "vid_1",
            status: "completed",
            unsigned_urls: ["https://openrouter.ai/api/v1/videos/vid_1/content?index=0"],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );
    const status = await getVideoJob(
      { ...CFG, fetchImpl: rec.fetch },
      "https://openrouter.ai/api/v1/videos/vid_1",
    );
    expect(status).toEqual({
      id: "vid_1",
      status: "completed",
      unsignedUrls: ["https://openrouter.ai/api/v1/videos/vid_1/content?index=0"],
    });
    expect(rec.reqs[0].url).toBe("https://openrouter.ai/api/v1/videos/vid_1");
    expect(rec.reqs[0].headers.get("authorization")).toBe("Bearer sk-or-test");
  });

  it("returns [] for unsigned_urls while a job is still in progress", async () => {
    const rec = recorder(
      () =>
        new Response(JSON.stringify({ id: "vid_1", status: "in_progress" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    const status = await getVideoJob({ ...CFG, fetchImpl: rec.fetch }, "https://x/vid_1");
    expect(status).toEqual({ id: "vid_1", status: "in_progress", unsignedUrls: [] });
  });

  it("downloadBytes GETs the content URL WITH the bearer (the URL requires auth)", async () => {
    const mp4 = Buffer.from([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70]);
    const rec = recorder(
      () => new Response(mp4, { status: 200, headers: { "content-type": "video/mp4" } }),
    );
    const bytes = await downloadBytes(
      { ...CFG, fetchImpl: rec.fetch },
      "https://openrouter.ai/api/v1/videos/vid_1/content?index=0",
    );
    expect(bytes.equals(mp4)).toBe(true);
    expect(rec.reqs[0].headers.get("authorization")).toBe("Bearer sk-or-test");
  });
});
