import { describe, it, expect } from "vitest";
import {
  GenerationRequestInvalidError,
  VideoJobFailedError,
  VideoJobTimedOutError,
  isPermanentGenerationFailure,
  retryUnlessPermanentGeneration,
} from "./errors";
import {
  OpenRouterNotConnectedError,
  ProviderHttpError,
} from "../../providers/errors";

// The video-workflow terminal-error taxonomy (design D7). Three workflow-specific PERMANENT
// errors — bad request row, a provider-reported terminal FAILED status, and an exhausted poll
// budget — plus the provider-layer classifier (permanent 4xx / not-connected). Everything else
// (5xx / 429 / unknown / DBOS cancellation) is transient so DBOS retry/recovery owns it.

describe("isPermanentGenerationFailure", () => {
  it("is true for the three workflow-specific terminal errors", () => {
    expect(isPermanentGenerationFailure(new GenerationRequestInvalidError("bad row"))).toBe(true);
    expect(isPermanentGenerationFailure(new VideoJobFailedError("vid_1", "failed"))).toBe(true);
    expect(isPermanentGenerationFailure(new VideoJobTimedOutError("vid_1", 40))).toBe(true);
  });

  it("is true for a permanent provider failure (4xx / not-connected)", () => {
    expect(isPermanentGenerationFailure(new ProviderHttpError("bad", 400))).toBe(true);
    expect(isPermanentGenerationFailure(new OpenRouterNotConnectedError("u1"))).toBe(true);
  });

  it("is false for transient provider failures (5xx / 429) and unknown errors", () => {
    expect(isPermanentGenerationFailure(new ProviderHttpError("boom", 503))).toBe(false);
    expect(isPermanentGenerationFailure(new ProviderHttpError("rate", 429))).toBe(false);
    expect(isPermanentGenerationFailure(new Error("network blip"))).toBe(false);
  });

  it("retryUnlessPermanentGeneration is the negation", () => {
    expect(retryUnlessPermanentGeneration(new VideoJobFailedError("v", "error"))).toBe(false);
    expect(retryUnlessPermanentGeneration(new ProviderHttpError("boom", 503))).toBe(true);
  });
});
