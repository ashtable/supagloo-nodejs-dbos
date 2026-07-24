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
  resolveGenerationSeedCreds,
  type GenerationSeedCreds,
} from "../../src/testing/seed-connections";
import { resolveGlooModel, resolveTextModel } from "../../src/testing/e2e-models";

// End-to-end proof of the DBOS provider-call layer against the REAL provider hosts (OpenRouter +
// Gloo), reworked from the stub-coupled original in task 34-E8 (design-delta §10.7). This is the
// ONLY spec exercising real Gloo `.chat()` at the provider-primitive level — a genuine coverage
// niche — so it survives, slimmed: the OpenRouter + Gloo chat round-trips and the discovery
// assertions flip to real hosts with STRUCTURAL assertions (run-time-resolved model ids,
// non-empty catalogues, schema-valid results — no `stub/*` literals). This task ships NO workflow,
// so the "e2e" is integration-style: the provider helpers are called DIRECTLY against the live
// hosts — no DBOS runtime, no enqueue, no crash/replay (those belong to the #30/#32/#33/#34
// workflow specs). Non-UI → no Stagehand. No mocks — real HTTPS against the providers.
//
// The stub-era media-client primitives section (speech/video + the `Idempotency-Key`
// double-submit test) was DELETED here: it is duplicative of the 34-E4/34-E7 workflow-level real-
// host coverage, and the double-submit proof is provider-introspection-only (§10.5 accepted risk —
// real OpenRouter has no introspection endpoint to count create-job requests).
//
// Model ids are resolved at run time via discovery (§10.9 — never hardcoded): OpenRouter via
// `resolveTextModel` (cheapest structured-output-capable text model); Gloo via `resolveGlooModel`
// (its authenticated `/platform/v2/models` catalogue).

// Real-host base URLs default via the env schema; a sourced `.env` sets them to the live hosts.
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
  // The three provider base URLs default to the REAL hosts (never a stub) — the no-stub guard
  // below asserts exactly that.
  OPENROUTER_BASE_URL: process.env.OPENROUTER_BASE_URL,
  GLOO_BASE_URL: process.env.GLOO_BASE_URL,
  YOUVERSION_BASE_URL: process.env.YOUVERSION_BASE_URL,
  SECRETS_ENCRYPTION_KEY: "0".repeat(64),
  // S3 (writer) vars are required at boot (unused by this providers e2e).
  S3_ENDPOINT: "http://minio:9000",
  S3_BUCKET: "supagloo-dev",
  S3_ACCESS_KEY: "supagloo",
  S3_SECRET_KEY: "supagloo-dev",
});

// A minimal structured schema both providers can satisfy — proves the generateObject round-trip
// end-to-end without asserting any provider-specific fabricated content (§10.7 structural rule).
const greetingSchema = z.object({ greeting: z.string().min(1) });
const GREETING_PROMPT =
  "Return a JSON object with a single field 'greeting' set to a short, friendly greeting.";

/**
 * The inverted guard (§10.7): the old `beforeAll` asserted the base URLs EQUALLED the stub ports.
 * Now we assert the opposite — each base URL points at a real host and carries NO stub override
 * (neither a `localhost`/host-port form nor a Compose-internal `*-stub:` name). A guard against
 * the stub pattern silently creeping back.
 */
function assertNoStubOverride(name: string, url: string): void {
  expect(url, `${name} must point at a real https provider host`).toMatch(/^https:\/\//);
  expect(url, `${name} must not carry a stub override`).not.toMatch(
    /localhost|127\.0\.0\.1|-stub|:480\d/,
  );
}

beforeEach(() => {
  clearDiscoveryCache();
});

describe("no-stub guard (§10.7): provider base URLs carry no stub override", () => {
  it.each([
    ["OPENROUTER_BASE_URL", env.OPENROUTER_BASE_URL],
    ["GLOO_BASE_URL", env.GLOO_BASE_URL],
    ["YOUVERSION_BASE_URL", env.YOUVERSION_BASE_URL],
  ])("%s points at a real host, not a stub", (name, url) => {
    assertNoStubOverride(name, url);
  });
});

describe("model discovery against the real OpenRouter catalogue", () => {
  it("lists a non-empty text-model catalogue (structural — no stub literals)", async () => {
    const cfg = { openrouterBaseUrl: env.OPENROUTER_BASE_URL };
    const textModels = await discoverModels(cfg, { outputModalities: ["text"] });
    expect(Array.isArray(textModels)).toBe(true);
    expect(textModels.length).toBeGreaterThan(0);
    expect(textModels.every((id) => typeof id === "string" && id.length > 0)).toBe(true);
  });

  it("lists a non-empty audio-model catalogue filtered by output modality", async () => {
    const cfg = { openrouterBaseUrl: env.OPENROUTER_BASE_URL };
    const audioModels = await discoverModels(cfg, { outputModalities: ["audio"] });
    expect(audioModels.length).toBeGreaterThan(0);
    expect(audioModels.every((id) => typeof id === "string" && id.length > 0)).toBe(true);
  });

  it("lists a non-empty video-model catalogue from the dedicated endpoint", async () => {
    const videoModels = await discoverVideoModels({
      openrouterBaseUrl: env.OPENROUTER_BASE_URL,
    });
    expect(videoModels.length).toBeGreaterThan(0);
    expect(videoModels.every((id) => typeof id === "string" && id.length > 0)).toBe(true);
  });
});

describe("generateObject wrapper (structured text) against real hosts", () => {
  let creds: GenerationSeedCreds;
  let textModel: string;

  beforeAll(async () => {
    // Fail FAST + LOUD if a required real credential is missing — a real-provider suite that
    // silently skips is a green lie (§10.8). Names the missing var.
    creds = resolveGenerationSeedCreds();
    // Model id resolved via discovery at run time (§10.9 — never hardcoded).
    textModel = await resolveTextModel(env);
  }, 60_000);

  it("round-trips a schema-validated object through OpenRouter's chat surface", async () => {
    const object = await callLlmStructured({
      provider: "openrouter",
      baseUrl: env.OPENROUTER_BASE_URL,
      apiKey: creds.openrouterKey,
      modelId: textModel,
      schema: greetingSchema,
      prompt: GREETING_PROMPT,
    });

    // Structural: a schema-valid object with a non-empty greeting string — no fabricated literal.
    expect(typeof object.greeting).toBe("string");
    expect(object.greeting.length).toBeGreaterThan(0);
  }, 90_000);

  it("mints a live Gloo bearer token, then round-trips through Gloo's chat surface", async () => {
    // Real Gloo OAuth2 client-credentials mint (the exact call verifyClientCredentials makes).
    const token = await mintGlooToken({
      glooBaseUrl: env.GLOO_BASE_URL,
      clientId: creds.glooClientId,
      clientSecret: creds.glooClientSecret,
    });
    expect(typeof token.accessToken).toBe("string");
    expect(token.accessToken.length).toBeGreaterThan(0);
    expect(token.tokenType).toBe("Bearer");

    // Gloo model id resolved at run time from its authenticated catalogue (§10.9).
    const glooModel = await resolveGlooModel(env, token.accessToken);
    expect(typeof glooModel).toBe("string");
    expect(glooModel.length).toBeGreaterThan(0);

    const object = await callLlmStructured({
      provider: "gloo",
      baseUrl: env.GLOO_BASE_URL,
      apiKey: token.accessToken,
      modelId: glooModel,
      schema: greetingSchema,
      prompt: GREETING_PROMPT,
    });

    expect(typeof object.greeting).toBe("string");
    expect(object.greeting.length).toBeGreaterThan(0);
  }, 90_000);
});
