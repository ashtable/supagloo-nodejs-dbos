import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeRemotionScaffold } from "../../remotion";
import { emptyManifest } from "../../remotion/__fixtures__/manifests";
import {
  capturePublishHead,
  cutNextBranch,
  ensureWorkingClone,
  publishWorkspacePath,
  removePublishWorkspace,
  type PublishContext,
} from "./workspace";

// The publish workspace helpers, exercised against REAL git in hermetic temp dirs. A bare
// origin is seeded with a full Remotion scaffold on `main` + a `v0.0.1` working branch.
// These cover: cloning/reusing/rebuilding the working branch (self-heal a crash/replay);
// capturing the working head to publish (publish makes NO commit — no manifest); and
// `cutNextBranch`, which clones `main`, cuts a NEW `v0.0.2` branch at main's tip, and pushes
// it — idempotently (a fresh-worker re-run leaves the branch at the same sha, no error).

const HERMETIC = {
  GIT_TERMINAL_PROMPT: "0",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_AUTHOR_NAME: "Publish WS Test",
  GIT_AUTHOR_EMAIL: "ws@supagloo.test",
  GIT_COMMITTER_NAME: "Publish WS Test",
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
let mainHead: string;

/** The origin's head SHA for a branch (via ls-remote), or "" if the ref is absent. */
function originHead(branch: string): string {
  return g(["ls-remote", originUrl, `refs/heads/${branch}`]).split(/\s+/)[0] ?? "";
}

function makeCtx(jobId = `publish-${Date.now()}`): PublishContext {
  return {
    jobId,
    cloneUrl: originUrl,
    branchName: BRANCH,
    semver: "0.0.1",
    message: "Publish the shelter cut",
    workspaceRoot: join(root, "workspaces"),
  };
}

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "publish-ws-test-"));
  const origin = join(root, "origin.git");
  g(["init", "--bare", "--initial-branch=main", origin]);
  originUrl = origin;

  // Seed the origin: a full Remotion scaffold on main + a v0.0.1 working branch off it.
  const seed = join(root, "seed");
  g(["init", "--initial-branch=main", seed]);
  await writeRemotionScaffold(emptyManifest, seed);
  g(["add", "-A"], seed);
  g(["commit", "-m", "scaffold"], seed);
  g(["remote", "add", "origin", origin], seed);
  g(["push", "origin", "main"], seed);
  g(["branch", BRANCH], seed);
  g(["push", "origin", BRANCH], seed);
  mainHead = originHead("main");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("ensureWorkingClone", () => {
  it("clones the working branch into the deterministic workspace path", async () => {
    const ctx = makeCtx();
    const path = await ensureWorkingClone(ctx);
    expect(path).toBe(publishWorkspacePath(ctx, "working"));
    expect(existsSync(join(path, ".git"))).toBe(true);
    expect(g(["rev-parse", "--abbrev-ref", "HEAD"], path).trim()).toBe(BRANCH);
  });

  it("reuses a live workspace, and rebuilds a lost one (crash/replay self-heal)", async () => {
    const ctx = makeCtx();
    const path = await ensureWorkingClone(ctx);
    writeFileSync(join(path, ".reuse-marker"), "x");
    expect(await ensureWorkingClone(ctx)).toBe(path);
    expect(existsSync(join(path, ".reuse-marker"))).toBe(true);

    await removePublishWorkspace(ctx);
    expect(existsSync(path)).toBe(false);
    const rebuilt = await ensureWorkingClone(ctx);
    expect(rebuilt).toBe(path);
    expect(existsSync(join(rebuilt, ".git"))).toBe(true);
  });
});

describe("capturePublishHead", () => {
  it("returns the working branch head (publish makes no commit — no manifest)", async () => {
    const ctx = makeCtx();
    const { headCommitSha } = await capturePublishHead(ctx);
    expect(headCommitSha).toMatch(/^[0-9a-f]{40}$/);
    // The working branch head is unchanged on the origin (publish is a head-capture only).
    expect(headCommitSha).toBe(originHead(BRANCH));
  });
});

describe("cutNextBranch", () => {
  it("cuts v0.0.2 from main and pushes it (origin gains the ref at main's tip)", async () => {
    const ctx = makeCtx();
    const { headCommitSha } = await cutNextBranch(ctx, "v0.0.2");

    expect(originHead("v0.0.2")).toBe(headCommitSha);
    // The next branch is cut from main's tip.
    expect(headCommitSha).toBe(mainHead);
  });

  it("re-run against a fresh worker is idempotent (branch stays at the same sha)", async () => {
    const ctx = makeCtx();
    const first = await cutNextBranch(ctx, "v0.0.2");
    const headAfterFirst = originHead("v0.0.2");

    // Simulate a fresh worker: the ephemeral workspace is gone; the SAME job re-runs.
    await removePublishWorkspace(ctx);
    const second = await cutNextBranch(ctx, "v0.0.2");

    expect(second.headCommitSha).toBe(first.headCommitSha);
    expect(originHead("v0.0.2")).toBe(headAfterFirst);
  });
});
