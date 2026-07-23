import { describe, it, expect } from "vitest";
import { APICallError, NoObjectGeneratedError } from "ai";
import {
  GlooNotConnectedError,
  LLM_STRUCTURED_RETRY,
  MEDIA_RETRY,
  OpenRouterNotConnectedError,
  ProviderHttpError,
  isPermanentHttpStatus,
  isPermanentProviderFailure,
  retryUnlessPermanent,
} from "./errors";

// The retry classifier the provider steps hand to `DBOS.runStep`'s `shouldRetry`.
// Mirrors scaffold-project/retry.ts: transient failures (5xx/429/network/unknown)
// are retried with backoff; typed permanent failures fail fast. Additionally,
// AI-SDK schema-validation failures (NoObjectGeneratedError) are NON-retryable at
// the step level — they surface to the workflow's bounded repair loop (design §6d),
// which owns re-prompting, not the step's exponential backoff.

describe("isPermanentHttpStatus", () => {
  it("treats 4xx (except 429) as permanent", () => {
    for (const s of [400, 401, 403, 404, 409, 422]) {
      expect(isPermanentHttpStatus(s)).toBe(true);
    }
  });

  it("treats 429 and 5xx as transient", () => {
    for (const s of [429, 500, 502, 503]) {
      expect(isPermanentHttpStatus(s)).toBe(false);
    }
  });
});

describe("retryUnlessPermanent / isPermanentProviderFailure", () => {
  it("does NOT retry a permanent 4xx ProviderHttpError", () => {
    const e = new ProviderHttpError("bad request", 401);
    expect(isPermanentProviderFailure(e)).toBe(true);
    expect(retryUnlessPermanent(e)).toBe(false);
  });

  it("retries a 429 / 5xx ProviderHttpError", () => {
    expect(retryUnlessPermanent(new ProviderHttpError("rate", 429))).toBe(true);
    expect(retryUnlessPermanent(new ProviderHttpError("boom", 503))).toBe(true);
  });

  it("does NOT retry a permanent 4xx surfaced by the AI SDK (APICallError)", () => {
    const e = new APICallError({
      message: "unauthorized",
      url: "http://x/api/v1/chat/completions",
      requestBodyValues: {},
      statusCode: 401,
    });
    expect(retryUnlessPermanent(e)).toBe(false);
  });

  it("retries a transient 5xx surfaced by the AI SDK (APICallError)", () => {
    const e = new APICallError({
      message: "server error",
      url: "http://x/api/v1/chat/completions",
      requestBodyValues: {},
      statusCode: 503,
    });
    expect(retryUnlessPermanent(e)).toBe(true);
  });

  it("does NOT retry a schema-validation failure — it surfaces to the repair loop", () => {
    const e = new NoObjectGeneratedError({
      message: "could not parse",
      cause: undefined,
      text: "not json",
      response: { id: "x", timestamp: new Date(), modelId: "m" },
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      finishReason: "stop",
    });
    expect(NoObjectGeneratedError.isInstance(e)).toBe(true);
    expect(isPermanentProviderFailure(e)).toBe(true);
    expect(retryUnlessPermanent(e)).toBe(false);
  });

  it("treats provider-not-connected as permanent (a missing connection won't heal on retry)", () => {
    expect(retryUnlessPermanent(new OpenRouterNotConnectedError("user-1"))).toBe(false);
    expect(retryUnlessPermanent(new GlooNotConnectedError("user-1"))).toBe(false);
  });

  it("defaults an unrecognized error to transient (never mark permanent by accident)", () => {
    expect(retryUnlessPermanent(new Error("connection reset"))).toBe(true);
  });
});

describe("LLM_STRUCTURED_RETRY", () => {
  it("carries the design-mandated maxAttempts:5 + backoff + the shouldRetry classifier", () => {
    expect(LLM_STRUCTURED_RETRY.maxAttempts).toBe(5);
    expect(LLM_STRUCTURED_RETRY.retriesAllowed).toBe(true);
    expect(LLM_STRUCTURED_RETRY.backoffRate).toBeGreaterThan(1);
    expect(LLM_STRUCTURED_RETRY.shouldRetry).toBe(retryUnlessPermanent);
  });
});

// §10.6 (task 34-E1): the media retry constant is the config half of the 503-then-200
// reclassification for the speech/video steps (the LLM half is covered above). The
// call-function SEQUENCE proof lives in media-client.test.ts; here we pin the policy the
// step spreads onto DBOS.runStep so the transient-then-succeed re-call actually happens.
describe("MEDIA_RETRY", () => {
  it("carries maxAttempts:4 + backoff + the shouldRetry classifier", () => {
    expect(MEDIA_RETRY.maxAttempts).toBe(4);
    expect(MEDIA_RETRY.retriesAllowed).toBe(true);
    expect(MEDIA_RETRY.backoffRate).toBeGreaterThan(1);
    expect(MEDIA_RETRY.shouldRetry).toBe(retryUnlessPermanent);
  });
});
