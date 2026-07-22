import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { loadEnv, type Env } from "../../src/config/env";
import { callLlmStructured } from "../../src/providers/generate-object";
import { mintGlooToken } from "../../src/providers/gloo";
import {
  clearDiscoveryCache,
  discoverModels,
  discoverVideoModels,
} from "../../src/providers/discovery";
import {
  downloadBytes,
  getVideoContentUrls,
  getVideoJob,
  requestSpeech,
  submitVideoJob,
} from "../../src/providers/media-client";

// End-to-end proof of the DBOS provider-call layer against the REAL provider-stub
// harness (openrouter-stub :4802, gloo-stub :4803 from docker-compose.test.yml).
// This task ships NO workflow, so the "e2e" is integration-style: the helpers are
// called DIRECTLY against the running stubs — no DBOS runtime, no enqueue,
// no crash/replay (those belong to the #30/#32/#33/#34 workflows built on top).
// Non-UI → no Stagehand. No mocks — real HTTP against the containers.

const OPENROUTER_STUB =
  process.env.OPENROUTER_STUB_URL ?? "http://localhost:4802";
const GLOO_STUB = process.env.GLOO_STUB_URL ?? "http://localhost:4803";

// Env is loaded to exercise the same base-URL / secrets validation the worker boots
// with (the helpers themselves take explicit args, matching how a workflow reads
// getProviderConfig() then passes them in).
const env: Env = loadEnv({
  DATABASE_URL:
    process.env.DATABASE_URL ??
    "postgres://supagloo:supagloo@localhost:5432/supagloo",
  DBOS_DATABASE_URL:
    process.env.DBOS_DATABASE_URL ??
    "postgres://supagloo:supagloo@localhost:5432/supagloo_dbos",
  NODE_ENV: "test",
  GITHUB_APP_ID: "123456",
  GITHUB_APP_PRIVATE_KEY:
    "-----BEGIN RSA PRIVATE KEY-----\nx\n-----END RSA PRIVATE KEY-----",
  OPENROUTER_BASE_URL: OPENROUTER_STUB,
  GLOO_BASE_URL: GLOO_STUB,
  SECRETS_ENCRYPTION_KEY: "0".repeat(64),
});

const stubSchema = z.object({ stub: z.boolean() });

async function resetStub(baseUrl: string): Promise<void> {
  await fetch(`${baseUrl}/__stub/reset`, { method: "POST" });
}

async function stubState(baseUrl: string): Promise<Record<string, number>> {
  const res = await fetch(`${baseUrl}/__stub/calls`);
  return ((await res.json()) as { state: Record<string, number> }).state;
}

async function stubCalls(
  baseUrl: string,
): Promise<{ byRoute: Record<string, number>; state: Record<string, number> }> {
  const res = await fetch(`${baseUrl}/__stub/calls`);
  return (await res.json()) as {
    byRoute: Record<string, number>;
    state: Record<string, number>;
  };
}

beforeAll(() => {
  // Assert the env loaded the stub URLs (guards a misconfigured overlay).
  expect(env.OPENROUTER_BASE_URL).toBe(OPENROUTER_STUB);
  expect(env.GLOO_BASE_URL).toBe(GLOO_STUB);
});

beforeEach(async () => {
  clearDiscoveryCache();
  await resetStub(OPENROUTER_STUB);
  await resetStub(GLOO_STUB);
});

describe("generateObject wrapper (structured text)", () => {
  it("round-trips a schema-validated object through OpenRouter's chat surface", async () => {
    const object = await callLlmStructured({
      provider: "openrouter",
      baseUrl: env.OPENROUTER_BASE_URL,
      apiKey: "sk-or-test",
      modelId: "stub/text-model", // resolved via discovery below; literal is test-only
      schema: stubSchema,
      prompt: "Draft a storyboard.",
    });

    expect(object).toEqual({ stub: true });
    // Proof the round-trip actually hit the stub's chat-completions endpoint.
    expect((await stubState(OPENROUTER_STUB)).chatCompletions).toBe(1);
  });

  it("mints a fresh Gloo bearer token PER RUN, then round-trips via Gloo's chat surface", async () => {
    const token = await mintGlooToken({
      glooBaseUrl: env.GLOO_BASE_URL,
      clientId: "cid",
      clientSecret: "csecret",
    });
    expect(token.accessToken).toMatch(/^gloo_/);
    expect(token.tokenType).toBe("Bearer");

    const object = await callLlmStructured({
      provider: "gloo",
      baseUrl: env.GLOO_BASE_URL,
      apiKey: token.accessToken,
      modelId: "gloo-stub-model",
      schema: stubSchema,
      prompt: "Draft a storyboard.",
    });
    expect(object).toEqual({ stub: true });

    // "Minted per run, never persisted": a second mint issues a DISTINCT token and
    // the stub's issued-token counter advances (no caching/reuse across runs).
    const token2 = await mintGlooToken({
      glooBaseUrl: env.GLOO_BASE_URL,
      clientId: "cid",
      clientSecret: "csecret",
    });
    expect(token2.accessToken).not.toBe(token.accessToken);
    expect((await stubState(GLOO_STUB)).tokensIssued).toBe(2);
    expect((await stubState(GLOO_STUB)).chatCompletions).toBe(1);
  });
});

describe("model discovery (ids resolved at call time)", () => {
  it("lists text vs speech models filtered by output_modalities", async () => {
    const cfg = { openrouterBaseUrl: env.OPENROUTER_BASE_URL };

    const textModels = await discoverModels(cfg, { outputModalities: ["text"] });
    expect(textModels).toContain("stub/text-model");
    expect(textModels).not.toContain("stub/speech-model");

    clearDiscoveryCache();
    const speechModels = await discoverModels(cfg, {
      outputModalities: ["audio"],
    });
    expect(speechModels).toContain("stub/speech-model");
    expect(speechModels).not.toContain("stub/text-model");
  });

  it("lists video models from the dedicated video-discovery endpoint", async () => {
    const videoModels = await discoverVideoModels({
      openrouterBaseUrl: env.OPENROUTER_BASE_URL,
    });
    expect(videoModels).toContain("stub/video-model");
  });
});

describe("direct-fetch media client (de-risks #33/#34)", () => {
  const cfg = () => ({
    openrouterBaseUrl: env.OPENROUTER_BASE_URL,
    apiKey: "sk-or-test",
  });

  it("buffers raw TTS audio bytes + captures the generation id", async () => {
    const speechModel = (
      await discoverModels(
        { openrouterBaseUrl: env.OPENROUTER_BASE_URL },
        { outputModalities: ["audio"] },
      )
    )[0];

    const result = await requestSpeech(cfg(), {
      modelId: speechModel,
      input: "In the beginning God created the heavens and the earth.",
    });

    expect(result.bytes.length).toBeGreaterThan(0);
    expect(result.contentType).toContain("audio/mpeg");
    expect(result.generationId).toMatch(/^gen_/);
  });

  it("runs the async video job to completion: submit → poll → content → download", async () => {
    const videoModel = (
      await discoverVideoModels({ openrouterBaseUrl: env.OPENROUTER_BASE_URL })
    )[0];

    const job = await submitVideoJob(cfg(), {
      modelId: videoModel,
      input: { prompt: "a white dove ascending" },
      idempotencyKey: "e2e-video-1",
    });
    expect(job.status).toBe("pending");

    // Poll to completion (stub reaches `completed` after a couple of polls).
    let status = job.status;
    for (let i = 0; i < 8 && status !== "completed"; i += 1) {
      status = (await getVideoJob(cfg(), job.pollingUrl)).status;
    }
    expect(status).toBe("completed");

    const { unsignedUrls } = await getVideoContentUrls(cfg(), job.id);
    expect(unsignedUrls.length).toBeGreaterThan(0);

    const bytes = await downloadBytes(cfg(), unsignedUrls[0]);
    expect(bytes.length).toBeGreaterThan(0);
  });

  it("is idempotent on the Idempotency-Key: a replayed submit does not create a 2nd job", async () => {
    const key = "e2e-video-idem";
    const first = await submitVideoJob(cfg(), {
      modelId: "stub/video-model",
      input: { prompt: "x" },
      idempotencyKey: key,
    });
    const second = await submitVideoJob(cfg(), {
      modelId: "stub/video-model",
      input: { prompt: "x" },
      idempotencyKey: key,
    });

    expect(second.id).toBe(first.id);
    const calls = await stubCalls(OPENROUTER_STUB);
    // Two POSTs were made (byRoute), but only ONE job was created (state) — the seam
    // the #34 crash/replay recovery relies on.
    expect(calls.byRoute["POST /api/v1/videos"]).toBe(2);
    expect(calls.state.videoJobsCreated).toBe(1);
  });
});
