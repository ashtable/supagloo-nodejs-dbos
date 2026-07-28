import { describe, expect, it } from "vitest";
import { requestGlooImage } from "./gloo-image";

/**
 * U-GI1..U-GI5 — the Gloo image-generation client, over an injected `fetch`.
 *
 * ── Why this client exists at all ────────────────────────────────────────────────────
 * `design-delta` §9-Q2 says "Gloo has no media modalities" and this repo believed it.
 * For images that is false: Gloo's catalogue carries 11 image-capable models and a real
 * 1024x768 PNG was generated from one on 2026-07-28. The reason nobody noticed is the
 * ROUTING — image models are NOT reachable through the chat/completions surface that
 * `generate-object.ts` uses. That surface answers:
 *
 *   400  "… does not support text output and cannot be used with the Chat Completions
 *         API. Use the POST /v2/responses endpoint instead."
 *
 * So this is a different endpoint with a different request shape and a different
 * response shape from anything else in `src/providers/`, which is exactly why it gets its
 * own module rather than a branch inside `media-client.ts` (that file is OpenRouter's
 * media surface top to bottom).
 *
 * ── The response shape ──────────────────────────────────────────────────────────────
 * `POST /ai/v2/responses` → 200, ~764 KB, with the bytes INLINE as base64 in
 * `output[0] = {type: "image_generation_call", status: "completed", result: "<base64>"}`.
 * There is no URL to download, which is why the workflow can upload straight from this
 * function's return value in a single step (the bytes-never-checkpointed fold).
 *
 * The `recorder()` idiom below is copied from `media-client.test.ts` — injected fetch,
 * hand-built `Response`, no mocking library, matching the repo's convention.
 */

const CFG = {
  glooBaseUrl: "https://platform.example.invalid",
  accessToken: "gloo-bearer-token-for-tests",
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

/** A minimal but genuinely valid 1x1 PNG, so the content-type sniff has real bytes. */
const PNG_BYTES = Buffer.from(
  "89504e470d0a1a0a0000000d4948445200000001000000010806000000" +
    "1f15c4890000000a49444154789c6300010000050001" +
    "0d0a2db40000000049454e44ae426082",
  "hex",
);

function responsesBody(base64: string): string {
  return JSON.stringify({
    id: "resp_test",
    object: "response",
    output: [
      { type: "image_generation_call", status: "completed", result: base64 },
    ],
    usage: { input_tokens: 1042, output_tokens: 0, cost: 0.002508165 },
  });
}

describe("requestGlooImage", () => {
  it("U-GI1: POSTs {root}/ai/v2/responses with a bearer and {model, input}", async () => {
    const rec = recorder(
      () =>
        new Response(responsesBody(PNG_BYTES.toString("base64")), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );

    await requestGlooImage(
      { ...CFG, fetchImpl: rec.fetch },
      { modelId: "some-image-model", prompt: "a serene sunrise over hills" },
    );

    expect(rec.reqs).toHaveLength(1);
    const req = rec.reqs[0];
    // The `/ai/v2` surface — NOT `/platform/v2` (that is the catalogue) and NOT
    // `/ai/v2/chat/completions` (which 400s for image models).
    expect(req.url).toBe("https://platform.example.invalid/ai/v2/responses");
    expect(req.method).toBe("POST");
    expect(req.headers.get("authorization")).toBe(
      "Bearer gloo-bearer-token-for-tests",
    );
    expect(req.headers.get("content-type")).toBe("application/json");
    const body = JSON.parse(req.body) as Record<string, unknown>;
    expect(body.model).toBe("some-image-model");
    // The prompt rides as `input` (a bare string), not as a `messages` array.
    expect(body.input).toBe("a serene sunrise over hills");
    expect("messages" in body).toBe(false);
  });

  it("U-GI2: decodes the base64 `result` to real bytes and sniffs the content type", async () => {
    const rec = recorder(
      () => new Response(responsesBody(PNG_BYTES.toString("base64")), { status: 200 }),
    );

    const result = await requestGlooImage(
      { ...CFG, fetchImpl: rec.fetch },
      { modelId: "some-image-model", prompt: "x" },
    );

    expect(Buffer.compare(result.bytes, PNG_BYTES)).toBe(0);
    // The manifest never records a MIME type, but S3 does — and the studio presigns the
    // object straight into an <Img>, so a wrong content type is a broken preview.
    expect(result.contentType).toBe("image/png");
  });

  it("U-GI3: `tradition` rides the body ONLY when supplied", async () => {
    const withOut = recorder(
      () => new Response(responsesBody(PNG_BYTES.toString("base64")), { status: 200 }),
    );
    await requestGlooImage(
      { ...CFG, fetchImpl: withOut.fetch },
      { modelId: "m", prompt: "x" },
    );
    expect("tradition" in JSON.parse(withOut.reqs[0].body)).toBe(false);

    const withIt = recorder(
      () => new Response(responsesBody(PNG_BYTES.toString("base64")), { status: 200 }),
    );
    await requestGlooImage(
      { ...CFG, fetchImpl: withIt.fetch },
      { modelId: "m", prompt: "x", tradition: "catholic" },
    );
    expect(JSON.parse(withIt.reqs[0].body).tradition).toBe("catholic");
  });

  it("U-GI4: a 200 with no completed image output is a TRANSIENT 502", async () => {
    // Deliberately transient so the step's MEDIA_RETRY re-tries rather than burning the
    // row. Same call as `requestImage`'s "200 with no image data" branch.
    for (const body of [
      JSON.stringify({ output: [] }),
      JSON.stringify({ output: [{ type: "message", content: "I can't do that" }] }),
      JSON.stringify({
        output: [{ type: "image_generation_call", status: "failed", result: null }],
      }),
      JSON.stringify({}),
    ]) {
      const rec = recorder(() => new Response(body, { status: 200 }));
      await expect(
        requestGlooImage(
          { ...CFG, fetchImpl: rec.fetch },
          { modelId: "m", prompt: "x" },
        ),
      ).rejects.toMatchObject({ name: "ProviderHttpError", status: 502 });
    }
  });

  it("U-GI5a: a 400 surfaces as a PERMANENT ProviderHttpError carrying the body text", async () => {
    const rec = recorder(
      () =>
        new Response(JSON.stringify({ error: { message: "Unknown model" } }), {
          status: 400,
        }),
    );
    await expect(
      requestGlooImage({ ...CFG, fetchImpl: rec.fetch }, { modelId: "m", prompt: "x" }),
    ).rejects.toMatchObject({ name: "ProviderHttpError", status: 400 });
  });

  it("U-GI5b: 503 THEN 200 over a sequenced fetch returns cleanly (the runStep retry)", async () => {
    // The §10.6 reproduction: a DBOS `runStep` retry is modelled by invoking the call
    // function TWICE over a sequenced fetch. Call 1 consumes the 503 and throws (the
    // classifier says transient); call 2 consumes the good response and returns. This is
    // the app-owned half; the retry ENGINE is the DBOS SDK's own responsibility.
    const responses: Array<() => Response> = [
      () => new Response("upstream busy", { status: 503 }),
      () => new Response(responsesBody(PNG_BYTES.toString("base64")), { status: 200 }),
    ];
    const fetchImpl = (async () =>
      (responses.shift() ?? (() => new Response("", { status: 500 })))()) as unknown as typeof fetch;

    await expect(
      requestGlooImage({ ...CFG, fetchImpl }, { modelId: "m", prompt: "x" }),
    ).rejects.toMatchObject({ name: "ProviderHttpError", status: 503 });

    const ok = await requestGlooImage(
      { ...CFG, fetchImpl },
      { modelId: "m", prompt: "x" },
    );
    expect(Buffer.compare(ok.bytes, PNG_BYTES)).toBe(0);
  });

  it("U-GI5c: a non-base64 `result` is a transient 502, not a crash", async () => {
    const rec = recorder(
      () => new Response(responsesBody("!!!! not base64 !!!!"), { status: 200 }),
    );
    await expect(
      requestGlooImage({ ...CFG, fetchImpl: rec.fetch }, { modelId: "m", prompt: "x" }),
    ).rejects.toMatchObject({ name: "ProviderHttpError", status: 502 });
  });

  it("U-GI5d: a trailing slash on the base URL does not produce a doubled path", async () => {
    const rec = recorder(
      () => new Response(responsesBody(PNG_BYTES.toString("base64")), { status: 200 }),
    );
    await requestGlooImage(
      {
        glooBaseUrl: "https://platform.example.invalid///",
        accessToken: "t",
        fetchImpl: rec.fetch,
      },
      { modelId: "m", prompt: "x" },
    );
    expect(rec.reqs[0].url).toBe("https://platform.example.invalid/ai/v2/responses");
  });
});
