import { describe, expect, it } from "vitest";
import { GitCommandError } from "../scaffold-project/git";
import {
  GithubRestError,
  RepoUnreachableError,
} from "../scaffold-project/github-rest";
import { ManifestInvalidError, NotASupaglooProjectError } from "./errors";
import { isPermanentImportFailure, retryUnlessPermanentImport } from "./retry";

// The import retry predicate handed to DBOS `shouldRetry`. It extends the scaffold
// git/HTTP classifier with import's two typed CONTENT failures: a repo that is not a
// Supagloo project and a malformed manifest are PERMANENT (retrying re-clones the same
// bytes and fails identically), so they fail fast — "no retries burned". Everything
// scaffold treats as transient (5xx/429, connection blips, unknown errors) stays
// retryable, so nothing is EVER marked permanent by accident.

describe("isPermanentImportFailure / retryUnlessPermanentImport", () => {
  it("classifies NotASupaglooProjectError as permanent (do not retry)", () => {
    const e = new NotASupaglooProjectError("NOT A SUPAGLOO PROJECT: no config");
    expect(isPermanentImportFailure(e)).toBe(true);
    expect(retryUnlessPermanentImport(e)).toBe(false);
  });

  it("classifies ManifestInvalidError as permanent (do not retry)", () => {
    const e = new ManifestInvalidError("manifest does not match schema");
    expect(isPermanentImportFailure(e)).toBe(true);
    expect(retryUnlessPermanentImport(e)).toBe(false);
  });

  it("delegates git/HTTP classification to the scaffold classifier", () => {
    expect(retryUnlessPermanentImport(new RepoUnreachableError("gone"))).toBe(false);
    expect(retryUnlessPermanentImport(new GithubRestError("forbidden", 403))).toBe(
      false,
    );
    expect(retryUnlessPermanentImport(new GithubRestError("rate limited", 429))).toBe(
      true,
    );
    expect(retryUnlessPermanentImport(new GithubRestError("server error", 500))).toBe(
      true,
    );
    const permanentGit = new GitCommandError({
      message: "Command failed: git clone",
      stderr: "fatal: Authentication failed",
      exitCode: 128,
      permanent: true,
    });
    const transientGit = new GitCommandError({
      message: "Command failed: git clone",
      stderr: "fatal: unable to access: Connection refused",
      exitCode: 128,
      permanent: false,
    });
    expect(retryUnlessPermanentImport(permanentGit)).toBe(false);
    expect(retryUnlessPermanentImport(transientGit)).toBe(true);
  });

  it("retries unknown / plain errors (default: transient)", () => {
    expect(retryUnlessPermanentImport(new Error("something odd"))).toBe(true);
    expect(retryUnlessPermanentImport(undefined)).toBe(true);
  });
});
