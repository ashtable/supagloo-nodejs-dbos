import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { emptyManifest } from "../../remotion/__fixtures__/manifests";
import {
  BASE_BRANCH,
  DEFAULT_BASE_BRANCH,
  WORKING_BRANCH,
  cutWorkingBranchLocal,
  ensureBaseRef,
  ensureClone,
  ensureScaffold,
  materializeBaseVersion,
  pushBranchFromWorkspace,
  removeWorkspace,
  workspacePath,
  type ScaffoldContext,
} from "./workspace";

// The git half is tested with REAL git against a local BARE repo (temp-dir
// fixtures are cheap and fast — the repo's TDD guidance says prefer real git over
// mocks here). Only GitHub HTTP is mocked (github-rest.test.ts). This suite proves
// the workspace helpers clone/scaffold/commit/push/branch correctly AND — the crux
// of crash-safety — that materializeBaseVersion is byte-deterministic (identical
// SHA on re-run) and self-heals after the ephemeral workspace is deleted.

// Hermetic git env so CI machine/user config can't perturb the fixture.
const HERMETIC = {
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_TERMINAL_PROMPT: "0",
  GIT_AUTHOR_NAME: "Fixture",
  GIT_AUTHOR_EMAIL: "fixture@supagloo.test",
  GIT_COMMITTER_NAME: "Fixture",
  GIT_COMMITTER_EMAIL: "fixture@supagloo.test",
};
const git = (args: string[], cwd?: string) =>
  execFileSync("git", args, { cwd, env: { ...process.env, ...HERMETIC } });

let root: string;
let originDir: string;

/** A bare origin with a `main` branch carrying one seed commit (the auto_init case). */
function seedBareOrigin(): string {
  const bare = join(root, "origin.git");
  git(["init", "--bare", "--initial-branch=main", bare]);
  git(["-C", bare, "config", "http.receivepack", "true"]);
  const work = mkdtempSync(join(root, "seed-"));
  git(["init", "--initial-branch=main", work]);
  execFileSync("bash", ["-c", "echo seeded > README.md"], { cwd: work });
  git(["-C", work, "add", "-A"]);
  git(["-C", work, "commit", "-m", "initial commit"]);
  git(["-C", work, "remote", "add", "origin", bare]);
  git(["-C", work, "push", "origin", "main"]);
  return bare;
}

/** A bare origin with NO commits at all — a genuinely unborn `main` (plan row 63). */
function emptyBareOrigin(): string {
  const bare = join(root, "empty-origin.git");
  git(["init", "--bare", "--initial-branch=main", bare]);
  git(["-C", bare, "config", "http.receivepack", "true"]);
  return bare;
}

function remoteSha(bare: string, branch: string): string | null {
  try {
    return execFileSync("git", ["-C", bare, "rev-parse", "--verify", `refs/heads/${branch}`], {
      env: { ...process.env, ...HERMETIC },
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim();
  } catch {
    return null;
  }
}

function remoteBranches(bare: string): string[] {
  return execFileSync("git", ["-C", bare, "branch", "--list"], {
    env: { ...process.env, ...HERMETIC },
  })
    .toString()
    .split("\n")
    .map((l) => l.replace(/[*+]/, "").trim())
    .filter(Boolean);
}

function ctxFor(jobId: string): ScaffoldContext {
  return {
    jobId,
    cloneUrl: originDir,
    manifest: emptyManifest,
    defaultBranch: "main",
    workspaceRoot: join(root, "workspaces"),
  };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "supagloo-ws-test-"));
  originDir = seedBareOrigin();
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("ensureClone / ensureScaffold", () => {
  it("clones the origin into the deterministic workspace path", async () => {
    const ctx = ctxFor("job-a");
    const path = await ensureClone(ctx);
    expect(path).toBe(workspacePath(ctx));
    expect(existsSync(join(path, ".git"))).toBe(true);
    expect(existsSync(join(path, "README.md"))).toBe(true);
  });

  it("writes the Remotion scaffold incl. supagloo.project.json", async () => {
    const ctx = ctxFor("job-b");
    const { path, filesWritten } = await ensureScaffold(ctx);
    expect(existsSync(join(path, "supagloo.project.json"))).toBe(true);
    expect(existsSync(join(path, "src", "Root.tsx"))).toBe(true);
    expect(filesWritten).toContain("supagloo.project.json");
    // The manifest we scaffolded round-trips into the written file.
    const written = JSON.parse(readFileSync(join(path, "supagloo.project.json"), "utf8"));
    expect(written.manifestVersion).toBe(1);
  });
});

describe("materializeBaseVersion", () => {
  it("commits the scaffold onto the v0.0.0 branch and pushes it to the origin", async () => {
    const ctx = ctxFor("job-c");
    const { baseSha } = await materializeBaseVersion(ctx);
    expect(baseSha).toMatch(/^[0-9a-f]{40}$/);
    await pushBranchFromWorkspace(ctx, BASE_BRANCH);
    expect(remoteBranches(originDir)).toContain(BASE_BRANCH);
  });

  it("is byte-deterministic: two independent runs against the same origin yield the SAME sha", async () => {
    const a = await materializeBaseVersion(ctxFor("job-det-1"));
    const b = await materializeBaseVersion(ctxFor("job-det-2"));
    expect(a.baseSha).toBe(b.baseSha);
  });

  it("self-heals: after the ephemeral workspace is deleted, re-running rebuilds the SAME sha", async () => {
    const ctx = ctxFor("job-heal");
    const first = await materializeBaseVersion(ctx);
    await removeWorkspace(ctx);
    expect(existsSync(workspacePath(ctx))).toBe(false);

    const second = await materializeBaseVersion(ctx);
    expect(second.baseSha).toBe(first.baseSha);
    expect(existsSync(join(workspacePath(ctx), ".git"))).toBe(true);
  });
});

// --------------------------------------------------------------------- plan row 63
// `ensureBaseRef` is the dbos half of the unborn-`main` defect. A repo with no commits
// clones with exit 0 and an UNBORN HEAD, so every later step "works" right up until
// `openPullRequest(base: "main")`, which real GitHub answers `422 Validation Failed
// (field: base, code: invalid)`. It is not only the create-new path: wireframe 13a's
// selectable "Empty · created just now" existing repo has no `auto_init` to send at all.
//
// The bootstrap runs INSIDE the existing `cloneToWorkspace` step (D63.2 — adding a
// `runStep` would break db-lib's `SCAFFOLD_STAGES` key-for-key pin), and it must be
// self-healing/idempotent because the workspace is ephemeral and the step can replay.
describe("ensureBaseRef", () => {
  it("creates and pushes an initial commit on main when the clone has an unborn HEAD", async () => {
    originDir = emptyBareOrigin();
    const ctx = ctxFor("job-unborn");
    expect(remoteSha(originDir, DEFAULT_BASE_BRANCH)).toBeNull();

    const path = await ensureClone(ctx);
    await ensureBaseRef(ctx);

    // The durable fix lives on the REMOTE — that is what makes it survive the
    // ephemeral workspace being thrown away between steps.
    expect(remoteSha(originDir, DEFAULT_BASE_BRANCH)).toMatch(/^[0-9a-f]{40}$/);
    // …and the local clone is left on the base branch, so `checkout -B v0.0.0` next
    // branches FROM the base tip rather than creating a parentless root commit.
    expect(
      execFileSync("git", ["-C", path, "symbolic-ref", "HEAD"], {
        env: { ...process.env, ...HERMETIC },
      })
        .toString()
        .trim(),
    ).toBe(`refs/heads/${DEFAULT_BASE_BRANCH}`);
  });

  it("is a no-op when the remote already has the base ref", async () => {
    // The auto_init / existing-project case: the clone has commits, so the bootstrap
    // must not touch the remote at all.
    const before = remoteSha(originDir, DEFAULT_BASE_BRANCH);
    expect(before).toMatch(/^[0-9a-f]{40}$/);

    const ctx = ctxFor("job-noop");
    await ensureClone(ctx);
    await ensureBaseRef(ctx);

    expect(remoteSha(originDir, DEFAULT_BASE_BRANCH)).toBe(before);
  });

  it("is idempotent across a second invocation on a rebuilt workspace", async () => {
    // Crash-replay safety: `cloneToWorkspace` can re-run after the ephemeral workspace
    // is gone. The second run must adopt the ref the first run pushed, never re-create
    // (and therefore never re-parent) it.
    originDir = emptyBareOrigin();
    const ctx = ctxFor("job-replay");
    await ensureClone(ctx);
    await ensureBaseRef(ctx);
    const first = remoteSha(originDir, DEFAULT_BASE_BRANCH);

    await removeWorkspace(ctx);
    await ensureClone(ctx);
    await ensureBaseRef(ctx);

    expect(remoteSha(originDir, DEFAULT_BASE_BRANCH)).toBe(first);
  });

  it("lets the full base-version sequence reach a PR-able v0.0.0 on a commit-less origin", async () => {
    // The whole point: after the bootstrap, `main` and `v0.0.0` are two DISTINCT refs
    // with commits between them, which is exactly what `POST /pulls` needs.
    originDir = emptyBareOrigin();
    const ctx = ctxFor("job-full");
    await ensureClone(ctx);
    await ensureBaseRef(ctx);
    const { baseSha } = await materializeBaseVersion(ctx);
    await pushBranchFromWorkspace(ctx, BASE_BRANCH);

    const branches = remoteBranches(originDir);
    expect(branches).toContain(DEFAULT_BASE_BRANCH);
    expect(branches).toContain(BASE_BRANCH);
    expect(baseSha).not.toBe(remoteSha(originDir, DEFAULT_BASE_BRANCH));
  });
});

describe("cutWorkingBranchLocal", () => {
  it("cuts v0.0.1 from the base and pushes it to the origin", async () => {
    const ctx = ctxFor("job-d");
    const { baseSha } = await materializeBaseVersion(ctx);
    await pushBranchFromWorkspace(ctx, BASE_BRANCH);

    const { workingSha } = await cutWorkingBranchLocal(ctx);
    // Working branch starts at the base commit (a plain cut — no new commit).
    expect(workingSha).toBe(baseSha);
    await pushBranchFromWorkspace(ctx, WORKING_BRANCH);

    const branches = remoteBranches(originDir);
    expect(branches).toContain(BASE_BRANCH);
    expect(branches).toContain(WORKING_BRANCH);
  });
});
