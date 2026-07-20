import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeRemotionScaffold } from "../../remotion";
import {
  emptyManifest,
  shelterManifest,
} from "../../remotion/__fixtures__/manifests";
import {
  commitBranch,
  commitWorkspacePath,
  ensureCommitClone,
  ensureManifestApplied,
  removeCommitWorkspace,
  type CommitContext,
} from "./workspace";

// The commit workspace helpers, exercised against REAL git in hermetic temp dirs. A bare
// origin is seeded with a full Remotion scaffold (emptyManifest) on a `v0.0.1` working
// branch. These tests cover the clone → apply-manifest → commit → push cycle the workflow
// drives, the self-healing reuse/re-clone a crash/replay depends on, AND the crux of the
// task: `commitBranch` is IDEMPOTENT under replay — re-running it against a fresh clone of
// the branch its OWN prior attempt already advanced does NOT create a second commit.

const HERMETIC = {
  GIT_TERMINAL_PROMPT: "0",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_AUTHOR_NAME: "Commit WS Test",
  GIT_AUTHOR_EMAIL: "ws@supagloo.test",
  GIT_COMMITTER_NAME: "Commit WS Test",
  GIT_COMMITTER_EMAIL: "ws@supagloo.test",
};

function g(args: string[], cwd?: string): string {
  return execFileSync("git", args, {
    cwd,
    env: { ...process.env, ...HERMETIC },
  }).toString();
}

const BRANCH = "v0.0.1";
let root: string;
let originUrl: string;
let seededHead: string;

/** The origin's current head SHA for the working branch (via ls-remote). */
function originHead(): string {
  return g(["ls-remote", originUrl, `refs/heads/${BRANCH}`]).split(/\s+/)[0];
}

/** Count of commits in `from..to`, resolved from a fresh full clone of the origin. */
function commitsBetween(from: string, to: string): number {
  const verify = mkdtempSync(join(tmpdir(), "commit-verify-"));
  try {
    g(["clone", "--branch", BRANCH, originUrl, verify]);
    return Number(g(["rev-list", "--count", `${from}..${to}`], verify).trim());
  } finally {
    rmSync(verify, { recursive: true, force: true });
  }
}

function makeCtx(manifest = shelterManifest, jobId = `commit-${Date.now()}`): CommitContext {
  return {
    jobId,
    cloneUrl: originUrl,
    branchName: BRANCH,
    manifest,
    message: "Edit the composition",
    workspaceRoot: join(root, "workspaces"),
  };
}

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "commit-ws-test-"));
  const origin = join(root, "origin.git");
  g(["init", "--bare", "--initial-branch=main", origin]);
  originUrl = origin;

  // Seed the origin: a full Remotion scaffold for the EMPTY manifest on main, then a
  // v0.0.1 working branch. Committing shelterManifest onto it produces a real diff.
  const seed = join(root, "seed");
  g(["init", "--initial-branch=main", seed]);
  await writeRemotionScaffold(emptyManifest, seed);
  g(["add", "-A"], seed);
  g(["commit", "-m", "scaffold"], seed);
  g(["remote", "add", "origin", origin], seed);
  g(["push", "origin", "main"], seed);
  g(["branch", BRANCH], seed);
  g(["push", "origin", BRANCH], seed);
  seededHead = originHead();
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("ensureCommitClone", () => {
  it("clones the working branch into the deterministic workspace path", async () => {
    const ctx = makeCtx();
    const path = await ensureCommitClone(ctx);
    expect(path).toBe(commitWorkspacePath(ctx));
    expect(existsSync(join(path, ".git"))).toBe(true);
    expect(g(["rev-parse", "--abbrev-ref", "HEAD"], path).trim()).toBe(BRANCH);
  });

  it("reuses a live workspace, and rebuilds a lost one (crash/replay self-heal)", async () => {
    const ctx = makeCtx();
    const path = await ensureCommitClone(ctx);
    writeFileSync(join(path, ".reuse-marker"), "x");
    expect(await ensureCommitClone(ctx)).toBe(path);
    expect(existsSync(join(path, ".reuse-marker"))).toBe(true);

    await removeCommitWorkspace(ctx);
    expect(existsSync(path)).toBe(false);
    const rebuilt = await ensureCommitClone(ctx);
    expect(rebuilt).toBe(path);
    expect(existsSync(join(path, ".git"))).toBe(true);
  });
});

describe("ensureManifestApplied", () => {
  it("regenerates the manifest-derived scene sources in the clone", async () => {
    const ctx = makeCtx();
    const { path, filesWritten } = await ensureManifestApplied(ctx);
    expect(existsSync(join(path, "src/scenes/Shelter.tsx"))).toBe(true);
    expect(filesWritten.some((f) => f.endsWith("Shelter.tsx"))).toBe(true);
  });
});

describe("commitBranch — idempotent commit + push (replay-safe)", () => {
  it("commits + pushes the edited manifest exactly once, advancing the branch by one commit", async () => {
    const ctx = makeCtx();
    const outcome = await commitBranch(ctx);

    expect(outcome.committed).toBe(true);
    expect(outcome.headCommitSha).toMatch(/^[0-9a-f]{40}$/);
    expect(outcome.changedFiles.length).toBeGreaterThan(0);
    expect(outcome.changedFiles.some((f) => f.endsWith("Shelter.tsx"))).toBe(true);

    // The origin advanced to the new commit — by EXACTLY one commit.
    expect(originHead()).toBe(outcome.headCommitSha);
    expect(commitsBetween(seededHead, outcome.headCommitSha)).toBe(1);
  });

  it("re-run against a fresh clone of the already-advanced branch does NOT double-commit", async () => {
    const ctx = makeCtx();
    const first = await commitBranch(ctx);
    expect(first.committed).toBe(true);
    const headAfterFirst = originHead();

    // Simulate a fresh worker: the ephemeral workspace is gone, the SAME job re-runs.
    await removeCommitWorkspace(ctx);
    const second = await commitBranch(ctx);

    // No new commit: the trailer on HEAD identifies this job's own prior push.
    expect(second.committed).toBe(false);
    expect(second.headCommitSha).toBe(first.headCommitSha);
    expect(originHead()).toBe(headAfterFirst);
    expect(commitsBetween(seededHead, originHead())).toBe(1);
    // The recorded change set is still the real one (matches the happy path).
    expect(second.changedFiles).toEqual(first.changedFiles);
  });

  it("a DIFFERENT job committing an unchanged manifest is a no-op (no push, [] changed)", async () => {
    const first = await commitBranch(makeCtx(shelterManifest, "job-a"));
    expect(first.committed).toBe(true);
    const headAfterFirst = originHead();

    // A second job with the SAME manifest: the tree matches HEAD, but the trailer is a
    // different job's — so it is a genuine no-change commit, not a replay.
    const second = await commitBranch(makeCtx(shelterManifest, "job-b"));
    expect(second.committed).toBe(false);
    expect(second.changedFiles).toEqual([]);
    expect(originHead()).toBe(headAfterFirst);
  });
});
