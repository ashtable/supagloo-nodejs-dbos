import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clone,
  GitCommandError,
  isPermanentGitFailure,
  redactUrlCredentials,
} from "./git";

// git.ts is the thin execFile wrapper. Two concerns are unit-tested here against
// REAL git (hermetic — a non-empty destination makes `git clone` fail BEFORE any
// network I/O, so no server or socket is involved):
//   (1) a credential embedded in a clone/push URL is REDACTED from every thrown
//       error before it can reach a DBOS checkpoint or the application logs, and
//   (2) git failures are wrapped in a typed GitCommandError that classifies
//       permanent (auth / permission / not-found) vs transient (network) failures,
//       so a step's `shouldRetry` can fail fast on permanent errors instead of
//       burning the whole backoff budget.

const SECRET = "ghs_SUPERSECRET_TOKEN_do_not_leak_123";

describe("redactUrlCredentials", () => {
  it("redacts the password but keeps the username for debuggability", () => {
    const s = `git clone https://x-access-token:${SECRET}@github.com/acme/repo.git /dst`;
    const red = redactUrlCredentials(s);
    expect(red).not.toContain(SECRET);
    expect(red).toContain("https://x-access-token:***@github.com/acme/repo.git");
  });

  it("redacts bare userinfo (no username:password split) entirely", () => {
    const red = redactUrlCredentials(`https://${SECRET}@github.com/x.git`);
    expect(red).not.toContain(SECRET);
    expect(red).toContain("https://***@github.com/x.git");
  });

  it("redacts EVERY occurrence and leaves credential-free URLs untouched", () => {
    const s =
      `a https://u:${SECRET}@h1/x ` +
      `b https://u2:${SECRET}@h2/y ` +
      `c https://github.com/plain`;
    const red = redactUrlCredentials(s);
    expect(red).not.toContain(SECRET);
    expect(red).toContain("https://u:***@h1/x");
    expect(red).toContain("https://u2:***@h2/y");
    expect(red).toContain("https://github.com/plain");
  });
});

describe("isPermanentGitFailure", () => {
  it("classifies auth / permission / not-found signals as permanent", () => {
    expect(
      isPermanentGitFailure("fatal: Authentication failed for 'https://github.com/x'", ""),
    ).toBe(true);
    expect(isPermanentGitFailure("remote: Invalid username or password.", "")).toBe(true);
    expect(
      isPermanentGitFailure("remote: Repository not found.\nfatal: repository not found", ""),
    ).toBe(true);
    expect(
      isPermanentGitFailure("remote: Permission to acme/x.git denied to bot.", ""),
    ).toBe(true);
    expect(isPermanentGitFailure("error: The requested URL returned error: 403", "")).toBe(
      true,
    );
    expect(isPermanentGitFailure("error: The requested URL returned error: 404", "")).toBe(
      true,
    );
  });

  it("treats network / connection failures as transient (retryable)", () => {
    expect(
      isPermanentGitFailure(
        "fatal: unable to access '...': Could not resolve host: github.com",
        "",
      ),
    ).toBe(false);
    expect(
      isPermanentGitFailure(
        "fatal: unable to access '...': Failed to connect to 127.0.0.1 port 1: Connection refused",
        "",
      ),
    ).toBe(false);
    expect(
      isPermanentGitFailure("error: RPC failed; curl 56 Recv failure: Connection reset", ""),
    ).toBe(false);
    expect(isPermanentGitFailure("", "")).toBe(false);
  });
});

describe("clone() error handling (real git, hermetic)", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "supagloo-git-test-"));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  /** A non-empty destination fails `git clone` immediately, before any network. */
  function occupiedDest(name: string): string {
    const dst = join(root, name);
    mkdirSync(dst, { recursive: true });
    writeFileSync(join(dst, "occupied.txt"), "x");
    return dst;
  }

  it("redacts the embedded credential from the thrown error but keeps the sanitized command", async () => {
    const dst = occupiedDest("dst");
    const url = `https://x-access-token:${SECRET}@github.com/acme/repo.git`;

    const err = await clone(url, dst).then(
      () => null,
      (e: unknown) => e as GitCommandError,
    );
    expect(err).toBeInstanceOf(GitCommandError);
    // The raw credential must not survive ANYWHERE reachable on the error.
    expect(err!.message).not.toContain(SECRET);
    expect(err!.stderr).not.toContain(SECRET);
    expect(String(err!.stack)).not.toContain(SECRET);
    // ...but a debuggable, sanitized command IS still present.
    expect(err!.message).toContain(
      "git clone https://x-access-token:***@github.com/acme/repo.git",
    );
  });

  it("wraps a failed git command in a GitCommandError carrying exitCode + classification", async () => {
    const dst = occupiedDest("dst2");
    const url = `https://x-access-token:${SECRET}@github.com/acme/repo.git`;

    const err = (await clone(url, dst).then(
      () => null,
      (e: unknown) => e,
    )) as GitCommandError;
    expect(err).toBeInstanceOf(GitCommandError);
    expect(err.exitCode).toBe(128);
    // "destination already exists" is not an auth/permission/not-found signal → transient.
    expect(err.permanent).toBe(false);
  });
});
