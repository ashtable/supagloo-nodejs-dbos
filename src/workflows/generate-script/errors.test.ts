import { describe, it, expect } from "vitest";
import { APICallError } from "ai";
import {
  ProviderHttpError,
  OpenRouterNotConnectedError,
} from "../../providers/errors";
import {
  YouVersionPassageNotFoundError,
  YouVersionUnsupportedVersionError,
} from "../../providers/youversion";
import {
  isPermanentGenerationFailure,
  RepairExhaustedError,
  TranslationNotLicensedError,
  UnsupportedGenerationKindError,
} from "./errors";

// Task #30 retry classification (design-delta §6d). The workflow's outer catch marks the
// generation `failed` ONLY on a permanent typed error and lets transient failures propagate
// for DBOS retry/recovery. Composes the provider-layer classifier with the workflow's own
// terminal errors. 4xx / not-connected / not-licensed / repair-exhausted / bad-request-content
// are permanent; 5xx / 429 / unknown are transient.

describe("isPermanentGenerationFailure — permanent (fail fast, mark generation failed)", () => {
  const permanent: Array<[string, unknown]> = [
    ["TranslationNotLicensedError", new TranslationNotLicensedError("NIV")],
    ["RepairExhaustedError", new RepairExhaustedError(4, "scenes: Required")],
    ["UnsupportedGenerationKindError", new UnsupportedGenerationKindError("image")],
    ["OpenRouterNotConnectedError", new OpenRouterNotConnectedError("u1")],
    ["YouVersionUnsupportedVersionError", new YouVersionUnsupportedVersionError("niv")],
    ["YouVersionPassageNotFoundError", new YouVersionPassageNotFoundError("Nowhere 9:9")],
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
    });
  }
});
