import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  COMMIT_AUTHOR,
  changedFilesForHead,
  cloneBranch,
  commitJobTrailer,
  commitWithMessage,
  headCommitHasJobId,
  workingTreeDirty,
} from "./git";

// The commit-version git helpers, exercised against REAL git in hermetic temp dirs
// (house style — mock only the GitHub HTTP layer, never git itself). Unlike scaffold's
// deterministic base commit, commit uses a REAL user message + the current time, so the
// SHA is not reproducible; idempotency instead rides a `Supagloo-Job-Id: <jobId>` trailer
// embedded in the commit. This suite pins: a depth-2 branch-scoped clone (HEAD~1 present),
// commit-message handling (subject = message, body = the jobId trailer, bot identity), the
// changed-file computation wire format, working-tree dirtiness, and trailer detection.

const HERMETIC = {
  GIT_TERMINAL_PROMPT: "0",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_AUTHOR_NAME: "Commit Fixture",
  GIT_AUTHOR_EMAIL: "fixture@supagloo.test",
  GIT_COMMITTER_NAME: "Commit Fixture",
  GIT_COMMITTER_EMAIL: "fixture@supagloo.test",
};

function g(args: string[], cwd?: string): string {
  return execFileSync("git", args, {
    cwd,
    env: { ...process.env, ...HERMETIC },
  }).toString();
}

let root: string;
let originUrl: string;
let work: string;

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "commit-git-test-"));
  const origin = join(root, "origin.git");
  g(["init", "--bare", "--initial-branch=main", origin]);
  originUrl = origin;

  // Seed the origin's v0.0.1 working branch with TWO commits so HEAD~1 exists on a
  // depth-2 clone: commit1 adds a.txt; commit2 modifies a.txt + adds b.txt.
  const seed = join(root, "seed");
  g(["init", "--initial-branch=main", seed]);
  writeFileSync(join(seed, "a.txt"), "one\n");
  g(["add", "-A"], seed);
  g(["commit", "-m", "c1"], seed);
  writeFileSync(join(seed, "a.txt"), "two\n");
  writeFileSync(join(seed, "b.txt"), "bee\n");
  g(["add", "-A"], seed);
  g(["commit", "-m", "c2"], seed);
  g(["remote", "add", "origin", origin], seed);
  g(["push", "origin", "main"], seed);
  g(["branch", "v0.0.1"], seed);
  g(["push", "origin", "v0.0.1"], seed);

  work = join(root, "work");
  await cloneBranch(originUrl, work, "v0.0.1", { depth: 2 });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("cloneBranch", () => {
  it("clones ONLY the named branch at depth 2 (HEAD + its parent present)", () => {
    expect(existsSync(join(work, ".git"))).toBe(true);
    expect(existsSync(join(work, "a.txt"))).toBe(true);
    // The current branch is the requested one.
    expect(g(["rev-parse", "--abbrev-ref", "HEAD"], work).trim()).toBe("v0.0.1");
    // Depth 2 ⇒ the parent commit is present locally (required for HEAD~1 diffs).
    expect(() => g(["rev-parse", "HEAD~1"], work)).not.toThrow();
  });
});

describe("changedFilesForHead", () => {
  it("returns the tip commit's diff in `<status> <path>` wire format", async () => {
    // HEAD (c2) modified a.txt and added b.txt.
    const changed = await changedFilesForHead(work);
    expect(changed).toContain("M a.txt");
    expect(changed).toContain("A b.txt");
    expect(changed).toHaveLength(2);
  });

  it("reflects a fresh commit's own change set", async () => {
    writeFileSync(join(work, "c.txt"), "sea\n");
    await commitWithMessage(work, "add c", "job-x");
    expect(await changedFilesForHead(work)).toEqual(["A c.txt"]);
  });
});

describe("workingTreeDirty", () => {
  it("is false on a clean checkout and true after an uncommitted edit", async () => {
    expect(await workingTreeDirty(work)).toBe(false);
    writeFileSync(join(work, "a.txt"), "changed\n");
    expect(await workingTreeDirty(work)).toBe(true);
  });
});

describe("commitWithMessage + headCommitHasJobId", () => {
  it("commits with the real message as subject, the jobId trailer as body, and the bot identity", async () => {
    writeFileSync(join(work, "a.txt"), "edited\n");
    const sha = await commitWithMessage(work, "Tighten the shelter pacing", "job-123");

    expect(sha).toMatch(/^[0-9a-f]{40}$/);
    expect(g(["log", "-1", "--format=%s"], work).trim()).toBe(
      "Tighten the shelter pacing",
    );
    expect(g(["log", "-1", "--format=%b"], work)).toContain(
      commitJobTrailer("job-123"),
    );
    // Committed under the fixed bot identity (not the ambient fixture identity).
    expect(g(["log", "-1", "--format=%an"], work).trim()).toBe(COMMIT_AUTHOR.name);
    expect(g(["log", "-1", "--format=%ae"], work).trim()).toBe(COMMIT_AUTHOR.email);
  });

  it("detects the trailer only for the matching jobId", async () => {
    writeFileSync(join(work, "a.txt"), "edited\n");
    await commitWithMessage(work, "msg", "job-abc");
    expect(await headCommitHasJobId(work, "job-abc")).toBe(true);
    expect(await headCommitHasJobId(work, "job-def")).toBe(false);
  });
});
