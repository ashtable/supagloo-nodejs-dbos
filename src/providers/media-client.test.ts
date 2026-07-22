import { describe, it, expect } from "vitest";
import { ProviderHttpError, retryUnlessPermanent } from "./errors";
import {
  downloadBytes,
  fetchAssetBytes,
  getVideoContentUrls,
  getVideoJob,
  requestImage,
  requestSpeech,
  submitVideoJob,
} from "./media-client";

// Media generation is direct `fetch` (NOT the AI SDK): TTS is a raw byte-stream
// response, video is an async job + poll + unsigned-URL download. These primitives
// are the reusable pieces the #33/#34 workflows wrap in DBOS steps (durable polling
// sleeps live there, not here). Injected fetch, hand-built Responses.

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

describe("requestSpeech (TTS raw byte stream)", () => {
  it("returns the raw audio bytes + generation id from a non-JSON audio/mpeg body", async () => {
    const audio = Buffer.from([0xff, 0xfb, 0x90, 0x64, 0x01, 0x02]);
    const rec = recorder(
      () =>
        new Response(audio, {
          status: 200,
          headers: {
            "content-type": "audio/mpeg",
            "x-generation-id": "gen_stub_7",
          },
        }),
    );
    const result = await requestSpeech(
      { ...CFG, fetchImpl: rec.fetch },
      { modelId: "resolved/speech-model", input: "In the beginning" },
    );
    expect(Buffer.isBuffer(result.bytes)).toBe(true);
    expect(result.bytes.equals(audio)).toBe(true);
    expect(result.generationId).toBe("gen_stub_7");

    const req = rec.reqs[0];
    expect(req.url).toBe("https://openrouter.ai/api/v1/audio/speech");
    expect(req.method).toBe("POST");
    expect(req.headers.get("authorization")).toBe("Bearer sk-or-test");
    expect(JSON.parse(req.body).model).toBe("resolved/speech-model");
  });

  it("surfaces a non-2xx as a ProviderHttpError", async () => {
    const rec = recorder(() => new Response("nope", { status: 500 }));
    await expect(
      requestSpeech(
        { ...CFG, fetchImpl: rec.fetch },
        { modelId: "m", input: "x" },
      ),
    ).rejects.toBeInstanceOf(ProviderHttpError);
  });
});

describe("requestImage (Task #32 — OpenAI-Images-compatible URL response)", () => {
  it("POSTs /api/v1/images/generations with {model, prompt} + Bearer auth and parses data[0].url", async () => {
    const rec = recorder(
      () =>
        new Response(
          JSON.stringify({
            created: 1700000000,
            data: [{ url: "https://cdn.example/img/abc.png" }],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );
    const result = await requestImage(
      { ...CFG, fetchImpl: rec.fetch },
      { modelId: "resolved/image-model", prompt: "a serene sunrise over hills" },
    );
    expect(result.imageUrl).toBe("https://cdn.example/img/abc.png");

    const req = rec.reqs[0];
    expect(req.url).toBe("https://openrouter.ai/api/v1/images/generations");
    expect(req.method).toBe("POST");
    expect(req.headers.get("authorization")).toBe("Bearer sk-or-test");
    const body = JSON.parse(req.body);
    expect(body.model).toBe("resolved/image-model");
    expect(body.prompt).toBe("a serene sunrise over hills");
  });

  it("classifies a 503 as transient (ProviderHttpError → retryUnlessPermanent true)", async () => {
    const rec = recorder(() => new Response("busy", { status: 503 }));
    const err = await requestImage(
      { ...CFG, fetchImpl: rec.fetch },
      { modelId: "m", prompt: "x" },
    ).catch((e) => e);
    expect(err).toBeInstanceOf(ProviderHttpError);
    expect((err as ProviderHttpError).status).toBe(503);
    expect(retryUnlessPermanent(err)).toBe(true);
  });

  it("classifies a 400 as permanent (ProviderHttpError → retryUnlessPermanent false)", async () => {
    const rec = recorder(() => new Response("bad prompt", { status: 400 }));
    const err = await requestImage(
      { ...CFG, fetchImpl: rec.fetch },
      { modelId: "m", prompt: "x" },
    ).catch((e) => e);
    expect(err).toBeInstanceOf(ProviderHttpError);
    expect(retryUnlessPermanent(err)).toBe(false);
  });
});

describe("fetchAssetBytes (Task #32 — download a pre-authorized asset URL, no auth header)", () => {
  it("GETs the URL with NO auth header and returns the bytes + content-type", async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const rec = recorder(
      () =>
        new Response(png, {
          status: 200,
          headers: { "content-type": "image/png" },
        }),
    );
    const { bytes, contentType } = await fetchAssetBytes(
      { ...CFG, fetchImpl: rec.fetch },
      "https://cdn.example/img/abc.png",
    );
    expect(bytes.equals(png)).toBe(true);
    expect(contentType).toBe("image/png");
    // A pre-authorized URL must not carry the provider bearer.
    expect(rec.reqs[0].headers.get("authorization")).toBeNull();
    expect(rec.reqs[0].url).toBe("https://cdn.example/img/abc.png");
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
      (req) =>
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
      {
        modelId: "resolved/video-model",
        input: { prompt: "a dove" },
        idempotencyKey: "job-abc",
      },
    );
    expect(job).toEqual({
      id: "vid_1",
      pollingUrl: "https://openrouter.ai/api/v1/videos/vid_1",
      status: "pending",
    });
    const req = rec.reqs[0];
    expect(req.url).toBe("https://openrouter.ai/api/v1/videos");
    expect(req.headers.get("idempotency-key")).toBe("job-abc");
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

describe("getVideoJob / getVideoContentUrls / downloadBytes", () => {
  it("polls a job status by its polling URL", async () => {
    const rec = recorder(
      () =>
        new Response(JSON.stringify({ id: "vid_1", status: "in_progress" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    const status = await getVideoJob(
      { ...CFG, fetchImpl: rec.fetch },
      "https://openrouter.ai/api/v1/videos/vid_1",
    );
    expect(status).toEqual({ id: "vid_1", status: "in_progress" });
    expect(rec.reqs[0].url).toBe("https://openrouter.ai/api/v1/videos/vid_1");
  });

  it("reads the unsigned content URLs for a completed job", async () => {
    const rec = recorder(
      () =>
        new Response(
          JSON.stringify({
            unsigned_urls: [
              "https://openrouter.ai/api/v1/videos/vid_1/download?index=0",
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );
    const { unsignedUrls } = await getVideoContentUrls(
      { ...CFG, fetchImpl: rec.fetch },
      "vid_1",
    );
    expect(unsignedUrls).toEqual([
      "https://openrouter.ai/api/v1/videos/vid_1/download?index=0",
    ]);
    expect(rec.reqs[0].url).toBe(
      "https://openrouter.ai/api/v1/videos/vid_1/content?index=0",
    );
  });

  it("downloads raw bytes from an unsigned URL", async () => {
    const mp4 = Buffer.from([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70]);
    const rec = recorder(
      () => new Response(mp4, { status: 200, headers: { "content-type": "video/mp4" } }),
    );
    const bytes = await downloadBytes(
      { ...CFG, fetchImpl: rec.fetch },
      "https://openrouter.ai/api/v1/videos/vid_1/download?index=0",
    );
    expect(bytes.equals(mp4)).toBe(true);
  });
});
