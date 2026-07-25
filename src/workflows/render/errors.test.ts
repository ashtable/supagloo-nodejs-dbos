import { describe, expect, it } from "vitest";
import { ProviderHttpError, OpenRouterNotConnectedError } from "../../providers/errors";
import { GitCommandError } from "../scaffold-project/git";
import {
  RENDER_NETWORK_RETRY,
  RenderCanceledError,
  RenderChildFailedError,
  RenderRequestInvalidError,
  isPermanentRenderFailure,
  isRenderCancellation,
  retryUnlessPermanentRender,
} from "./errors";

/**
 * Task #36 — typed render failures + the DBOS `shouldRetry` classification.
 *
 * The rule matches the rest of the codebase (`scaffold-project/retry.ts`,
 * `providers/errors.ts`): typed PERMANENT failures fail fast; everything we cannot
 * positively identify stays transient so we never mark something permanent by accident.
 *
 * Cancellation is its OWN axis — it is neither permanent-failure nor retryable. A
 * cancelled render must not be retried (pointless) and must not be recorded as `failed`
 * (it is `canceled`), so `isRenderCancellation` is checked BEFORE the failure
 * classification in the workflow's catch.
 */

describe("isRenderCancellation", () => {
  it("recognizes our own cooperative-abort error", () => {
    expect(isRenderCancellation(new RenderCanceledError("rj-1"))).toBe(true);
  });

  // REGRESSION (caught by the render e2e, then reproduced here): DBOS's `DBOSError` base
  // class never assigns `this.name`, so a real `DBOSWorkflowCancelledError` arrives with
  // `name === "Error"`. Matching on `name` alone missed EVERY real cancellation and left
  // the RenderJob row stranded at `bundling`. The numeric `dbosErrorCode` is the reliable
  // identity.
  //
  // The SDK does not export the class from its package entry (verified: only
  // `DBOSWorkflowConflictError` is re-exported) and its deep paths are blocked by
  // `exports`, so the real shape is reproduced faithfully here — including the crucial
  // detail that `name` is NOT set.
  class DBOSWorkflowCancelledError extends Error {
    readonly dbosErrorCode = 24;
    constructor(workflowID: string) {
      super(`Workflow ${workflowID} has been cancelled`);
    }
  }

  it("recognizes DBOS's cancellation error even though it does NOT set `name`", () => {
    const real = new DBOSWorkflowCancelledError("rj-1");
    expect(real.name).toBe("Error"); // the gotcha, pinned
    expect(isRenderCancellation(real)).toBe(true);
  });

  it("recognizes a cancellation by its numeric dbosErrorCode alone", () => {
    // 24 = WorkFlowCancelled, 27 = TargetWorkflowCancelled (dbos-sdk error.js).
    for (const dbosErrorCode of [24, 27]) {
      expect(
        isRenderCancellation(Object.assign(new Error("cancelled"), { dbosErrorCode })),
      ).toBe(true);
    }
  });

  it("still recognizes a cancellation-shaped `name` (forward-compatible)", () => {
    const dbosErr = Object.assign(new Error("Workflow rj-1 was cancelled"), {
      name: "DBOSWorkflowCancelledError",
    });
    expect(isRenderCancellation(dbosErr)).toBe(true);
  });

  it("does not treat another DBOS error code as a cancellation", () => {
    expect(
      isRenderCancellation(Object.assign(new Error("boom"), { dbosErrorCode: 1 })),
    ).toBe(false);
  });

  it("does not mistake an ordinary failure for a cancellation", () => {
    expect(isRenderCancellation(new Error("chromium crashed"))).toBe(false);
    expect(isRenderCancellation(new RenderChildFailedError("render", 1, "boom"))).toBe(
      false,
    );
  });
});

describe("isPermanentRenderFailure", () => {
  it("treats a malformed render request as permanent", () => {
    expect(isPermanentRenderFailure(new RenderRequestInvalidError("no row"))).toBe(true);
  });

  it("treats a missing OpenRouter connection as permanent (it will not heal on retry)", () => {
    expect(isPermanentRenderFailure(new OpenRouterNotConnectedError("user-1"))).toBe(
      true,
    );
  });

  it("treats a permanent git failure (bad token / repo gone) as permanent", () => {
    const err = new GitCommandError({
      message: "fatal: Authentication failed",
      stderr: "fatal: Authentication failed",
      exitCode: 128,
      permanent: true,
    });
    expect(isPermanentRenderFailure(err)).toBe(true);
  });

  it("treats a permanent provider 4xx as permanent, and 429/5xx as transient", () => {
    expect(isPermanentRenderFailure(new ProviderHttpError("bad", 400))).toBe(true);
    expect(isPermanentRenderFailure(new ProviderHttpError("rate", 429))).toBe(false);
    expect(isPermanentRenderFailure(new ProviderHttpError("boom", 502))).toBe(false);
  });

  it("treats a child-process failure marked permanent as permanent, otherwise transient", () => {
    expect(
      isPermanentRenderFailure(
        new RenderChildFailedError("bundle", 1, "SyntaxError in user code", true),
      ),
    ).toBe(true);
    expect(
      isPermanentRenderFailure(new RenderChildFailedError("render", 1, "OOM")),
    ).toBe(false);
  });

  it("defaults an unknown error to TRANSIENT (never permanent by accident)", () => {
    expect(isPermanentRenderFailure(new Error("who knows"))).toBe(false);
    expect(isPermanentRenderFailure("a string")).toBe(false);
    expect(isPermanentRenderFailure(undefined)).toBe(false);
  });

  it("does NOT classify a cancellation as a permanent failure (different axis)", () => {
    expect(isPermanentRenderFailure(new RenderCanceledError("rj-1"))).toBe(false);
  });
});

describe("retryUnlessPermanentRender", () => {
  it("retries transient failures and refuses permanent ones", () => {
    expect(retryUnlessPermanentRender(new ProviderHttpError("boom", 503))).toBe(true);
    expect(retryUnlessPermanentRender(new RenderRequestInvalidError("bad"))).toBe(false);
  });

  it("refuses to retry a cancellation (retrying a cancelled render is pointless)", () => {
    expect(retryUnlessPermanentRender(new RenderCanceledError("rj-1"))).toBe(false);
  });
});

describe("RENDER_NETWORK_RETRY", () => {
  it("retries network/git/npm steps with backoff and the shared classifier", () => {
    expect(RENDER_NETWORK_RETRY.retriesAllowed).toBe(true);
    expect(RENDER_NETWORK_RETRY.maxAttempts).toBeGreaterThan(1);
    expect(RENDER_NETWORK_RETRY.shouldRetry).toBe(retryUnlessPermanentRender);
  });
});
