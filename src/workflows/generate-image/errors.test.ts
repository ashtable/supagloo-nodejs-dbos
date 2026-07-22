import { describe, it, expect } from "vitest";
import { APICallError } from "ai";
import {
  ProviderHttpError,
  OpenRouterNotConnectedError,
} from "../../providers/errors";
import {
  GenerationRequestInvalidError,
  isPermanentGenerationFailure,
  retryUnlessPermanentGeneration,
} from "./errors";

// Task #32 retry classification (design-delta §7 workflow 6). The image workflow has no
// repair loop (image output is opaque bytes, not schema-validated JSON), so its terminal
// errors are just: a bad request row (wrong kind / no project / no prompt), a missing
// OpenRouter connection, and permanent 4xx provider failures. 5xx / 429 / unknown are
// transient. DBOS cancellation is NOT one of these typed errors, so it propagates.

describe("isPermanentGenerationFailure — permanent (fail fast, mark generation failed)", () => {
  const permanent: Array<[string, unknown]> = [
    ["GenerationRequestInvalidError", new GenerationRequestInvalidError("no projectId")],
    ["OpenRouterNotConnectedError", new OpenRouterNotConnectedError("u1")],
    ["ProviderHttpError 400", new ProviderHttpError("bad", 400)],
    ["ProviderHttpError 403", new ProviderHttpError("forbidden", 403)],
    [
      "APICallError 401",
      new APICallError({
        message: "unauthorized",
        url: "https://x",
        requestBodyValues: {},
        statusCode: 401,
        isRetryable: false,
      }),
    ],
  ];
  for (const [name, err] of permanent) {
    it(`classifies ${name} as permanent`, () => {
      expect(isPermanentGenerationFailure(err)).toBe(true);
      expect(retryUnlessPermanentGeneration(err)).toBe(false);
    });
  }
});

describe("isPermanentGenerationFailure — transient (retry / recover)", () => {
  const transient: Array<[string, unknown]> = [
    ["ProviderHttpError 503", new ProviderHttpError("down", 503)],
    ["ProviderHttpError 429", new ProviderHttpError("rate", 429)],
    ["a plain unknown error", new Error("socket hang up")],
  ];
  for (const [name, err] of transient) {
    it(`classifies ${name} as transient`, () => {
      expect(isPermanentGenerationFailure(err)).toBe(false);
      expect(retryUnlessPermanentGeneration(err)).toBe(true);
    });
  }
});
