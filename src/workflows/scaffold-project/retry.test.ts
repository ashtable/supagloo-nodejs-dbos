import { describe, expect, it } from "vitest";
import { GitCommandError } from "./git";
import { GithubRestError, RepoUnreachableError } from "./github-rest";
import { isPermanentScaffoldFailure, retryUnlessPermanent } from "./retry";

// The composed retry predicate the git-ops steps hand to DBOS `shouldRetry`. It maps
// the three typed failure shapes (RepoUnreachableError, GithubRestError, GitCommandError)
// onto permanent (do NOT retry — fail fast) vs transient (retry with backoff), and
// defaults unknown errors to transient so nothing is EVER classified permanent by
// accident.

describe("isPermanentScaffoldFailure / retryUnlessPermanent", () => {
  const permanentGit = new GitCommandError({
    message: "Command failed: git push",
    stderr: "fatal: Authentication failed",
    exitCode: 128,
    permanent: true,
  });
  const transientGit = new GitCommandError({
    message: "Command failed: git push",
    stderr: "fatal: unable to access: Connection refused",
    exitCode: 128,
    permanent: false,
  });

  it("classifies RepoUnreachableError as permanent (do not retry)", () => {
    const e = new RepoUnreachableError("not in the installation");
    expect(isPermanentScaffoldFailure(e)).toBe(true);
    expect(retryUnlessPermanent(e)).toBe(false);
  });

  it("classifies a 4xx (non-429) GithubRestError as permanent, 5xx/429 as transient", () => {
    expect(retryUnlessPermanent(new GithubRestError("forbidden", 403))).toBe(false);
    expect(retryUnlessPermanent(new GithubRestError("not found", 404))).toBe(false);
    expect(retryUnlessPermanent(new GithubRestError("rate limited", 429))).toBe(true);
    expect(retryUnlessPermanent(new GithubRestError("server error", 500))).toBe(true);
  });

  it("classifies a GitCommandError by its .permanent flag", () => {
    expect(retryUnlessPermanent(permanentGit)).toBe(false);
    expect(retryUnlessPermanent(transientGit)).toBe(true);
  });

  it("retries unknown / plain errors (default: transient)", () => {
    expect(retryUnlessPermanent(new Error("something odd"))).toBe(true);
    expect(retryUnlessPermanent(undefined)).toBe(true);
  });
});
