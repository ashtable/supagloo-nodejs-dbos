import { describe, it, expect } from "vitest";
import { ProviderHttpError, retryUnlessPermanent } from "./errors";
import {
  decodeDataUri,
  downloadBytes,
  fetchAssetBytes,
  getVideoJob,
  parseAudioStream,
  requestImage,
  requestSpeech,
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

describe("requestSpeech (streaming chat-audio → WAV)", () => {
  it("POSTs chat/completions with modalities audio + stream + pcm16 and returns WAV bytes", async () => {
    const pcm = Buffer.from([0x10, 0x11, 0x12, 0x13]);
    const rec = recorder(
      () =>
        new Response(audioSse([pcm.toString("base64")], { id: "gen_9" }), {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        }),
    );
    const result = await requestSpeech(
      { ...CFG, fetchImpl: rec.fetch },
      { modelId: "openai/gpt-audio-mini", input: "In the beginning", voice: "alloy" },
    );
    expect(result.contentType).toBe("audio/wav");
    expect(result.generationId).toBe("gen_9");
    expect(result.bytes.subarray(0, 4).toString("ascii")).toBe("RIFF");
    expect(result.bytes.subarray(44).equals(pcm)).toBe(true);

    const req = rec.reqs[0];
    expect(req.url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(req.method).toBe("POST");
    expect(req.headers.get("authorization")).toBe("Bearer sk-or-test");
    const body = JSON.parse(req.body);
    expect(body.model).toBe("openai/gpt-audio-mini");
    expect(body.stream).toBe(true);
    expect(body.modalities).toEqual(["text", "audio"]);
    expect(body.audio).toEqual({ voice: "alloy", format: "pcm16" });
    expect(body.messages[0].content).toBe("In the beginning");
  });

  it("omits voice for music (no voice arg)", async () => {
    const pcm = Buffer.from([0x20, 0x21]);
    const rec = recorder(
      () => new Response(audioSse([pcm.toString("base64")]), { status: 200 }),
    );
    await requestSpeech(
      { ...CFG, fetchImpl: rec.fetch },
      { modelId: "google/lyria-3-clip-preview", input: "cinematic strings" },
    );
    expect(JSON.parse(rec.reqs[0].body).audio).toEqual({ format: "pcm16" });
  });

  it("surfaces a non-2xx as a ProviderHttpError", async () => {
    const rec = recorder(() => new Response("nope", { status: 500 }));
    await expect(
      requestSpeech({ ...CFG, fetchImpl: rec.fetch }, { modelId: "m", input: "x" }),
    ).rejects.toBeInstanceOf(ProviderHttpError);
  });

  it("throws a 502 when a 200 stream carries no audio deltas", async () => {
    const rec = recorder(() => new Response("data: [DONE]\n", { status: 200 }));
    const err = await requestSpeech(
      { ...CFG, fetchImpl: rec.fetch },
      { modelId: "m", input: "x" },
    ).catch((e) => e);
    expect(err).toBeInstanceOf(ProviderHttpError);
    expect((err as ProviderHttpError).status).toBe(502);
  });

  it("503-then-200: retryable ProviderHttpError on the 503, then WAV bytes on the re-invoked 200", async () => {
    const pcm = Buffer.from([0x30, 0x31, 0x32]);
    const queue: Array<() => Response> = [
      () => new Response("busy", { status: 503 }),
      () => new Response(audioSse([pcm.toString("base64")], { id: "g" }), { status: 200 }),
    ];
    const rec = recorder(() => queue.shift()!());
    const args = { modelId: "openai/gpt-audio-mini", input: "hi", voice: "alloy" };

    const transient = await requestSpeech({ ...CFG, fetchImpl: rec.fetch }, args).catch(
      (e) => e,
    );
    expect(transient).toBeInstanceOf(ProviderHttpError);
    expect((transient as ProviderHttpError).status).toBe(503);
    expect(retryUnlessPermanent(transient)).toBe(true);

    const result = await requestSpeech({ ...CFG, fetchImpl: rec.fetch }, args);
    expect(result.bytes.subarray(44).equals(pcm)).toBe(true);
    expect(rec.reqs).toHaveLength(2);
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
