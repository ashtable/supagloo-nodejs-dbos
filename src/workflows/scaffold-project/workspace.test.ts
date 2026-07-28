import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { emptyManifest } from "../../remotion/__fixtures__/manifests";
import { GitCommandError } from "./git";
import { retryUnlessPermanent } from "./retry";
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

/**
 * A bare origin whose (only, default) branch carries one seed commit — the auto_init
 * case. `branch` is parameterised because a repo that has commits under a name that is
 * NOT the PR base (`master`) is a distinct case from a repo with no commits at all.
 */
function seedBareOrigin(branch = "main", dirName = "origin.git"): string {
  const bare = join(root, dirName);
  git(["init", "--bare", `--initial-branch=${branch}`, bare]);
  git(["-C", bare, "config", "http.receivepack", "true"]);
  const work = mkdtempSync(join(root, "seed-"));
  git(["init", `--initial-branch=${branch}`, work]);
  execFileSync("bash", ["-c", "echo seeded > README.md"], { cwd: work });
  git(["-C", work, "add", "-A"]);
  git(["-C", work, "commit", "-m", "initial commit"]);
  git(["-C", work, "remote", "add", "origin", bare]);
  git(["-C", work, "push", "origin", branch]);
  return bare;
}

/** A bare origin with NO commits at all — a genuinely unborn `main` (plan row 63). */
function emptyBareOrigin(dirName = "empty-origin.git"): string {
  const bare = join(root, dirName);
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

/** How many commits `branch` carries on the origin (0 when the ref does not exist). */
function remoteCommitCount(bare: string, branch: string): number {
  try {
    return Number(
      execFileSync("git", ["-C", bare, "rev-list", "--count", `refs/heads/${branch}`], {
        env: { ...process.env, ...HERMETIC },
        stdio: ["ignore", "pipe", "ignore"],
      })
        .toString()
        .trim(),
    );
  } catch {
    return 0;
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

  // ------------------------------------------------------------------ review R4 (HIGH)
  // Row 63's own fix had a durability hole that resurrected the defect it fixed.
  // `cloneToWorkspace` is `{ ...NETWORK_RETRY, shouldRetry: retryUnlessPermanent }`, and
  // `ensureClone` REUSES a live workspace, so a transient `pushBranch` failure re-runs the
  // step body against the SAME half-built workspace. Level (iii) creates the local commit
  // BEFORE it pushes, so on re-entry a level-(i) short-circuit keyed on the LOCAL HEAD is
  // already true — the bootstrap is skipped forever, `main` is never pushed, and the
  // workflow opens its PR against a base that does not exist: row 63's original 422.
  // The short-circuit must therefore be decided by REMOTE state, which a local commit
  // cannot fake.
  it("re-entering after a FAILED push still lands the base ref on the REMOTE", async () => {
    originDir = emptyBareOrigin();
    const ctx = ctxFor("job-push-fail");
    const path = await ensureClone(ctx);

    // Simulate a transient push failure by repointing `origin` at a path that is not a
    // repository. Everything before the push (checkout + the local bootstrap commit) has
    // already happened by then, which is precisely the half-built state at issue.
    git(["-C", path, "remote", "set-url", "origin", join(root, "vanished.git")]);
    const failure = await ensureBaseRef(ctx).then(
      () => null,
      (e: unknown) => e,
    );
    expect(failure).toBeInstanceOf(GitCommandError);
    // Classified TRANSIENT ⇒ DBOS really does re-run the step body (this is not a
    // hypothetical re-entry; a permanent classification would fail the workflow instead).
    expect(retryUnlessPermanent(failure)).toBe(true);
    expect(remoteSha(originDir, DEFAULT_BASE_BRANCH)).toBeNull();
    // The local commit exists though — which is exactly what a HEAD-keyed level (i) reads.
    expect(
      execFileSync("git", ["-C", path, "rev-parse", "--verify", "HEAD"], {
        env: { ...process.env, ...HERMETIC },
      })
        .toString()
        .trim(),
    ).toMatch(/^[0-9a-f]{40}$/);

    // The retry: same live workspace (`ensureClone` returns early), origin reachable.
    git(["-C", path, "remote", "set-url", "origin", originDir]);
    await ensureClone(ctx);
    await ensureBaseRef(ctx);

    const bootstrapped = remoteSha(originDir, DEFAULT_BASE_BRANCH);
    expect(bootstrapped).not.toBeNull(); // ← the R4 hole: skipped forever, `main` never pushed
    expect(bootstrapped).toMatch(/^[0-9a-f]{40}$/);
    // …and EXACTLY ONE bootstrap commit. Re-entry must not stack a second empty commit:
    // v0.0.0 is committed on top of the base tip, so a stacked parent would change the
    // `baseSha` that `commitBaseVersion` has already checkpointed, breaking the
    // byte-determinism the crash-safe re-push depends on.
    expect(remoteCommitCount(originDir, DEFAULT_BASE_BRANCH)).toBe(1);
    // The bootstrap SHA still matches a clean single-shot run against a pristine origin.
    const pristine = emptyBareOrigin("pristine-origin.git");
    const clean = { ...ctxFor("job-push-fail-clean"), cloneUrl: pristine };
    await ensureClone(clean);
    await ensureBaseRef(clean);
    expect(remoteSha(originDir, DEFAULT_BASE_BRANCH)).toBe(
      remoteSha(pristine, DEFAULT_BASE_BRANCH),
    );
  });

  // The same class of bug one level over: the origin HAS commits, so a HEAD-keyed
  // level (i) short-circuits — but they live on `master` and the PR base `main` does not
  // exist on the remote at all. That is wireframe 13a's "pick an existing repo" path, and
  // it 422s for the identical reason. D63.4 also requires scaffold to LEAVE `main` behind
  // (`publish-version` does a literal `git clone --branch main`), so creating it is not
  // optional.
  it("creates the base ref when the origin has commits but none of them are on it", async () => {
    originDir = seedBareOrigin("master", "master-origin.git");
    expect(remoteSha(originDir, DEFAULT_BASE_BRANCH)).toBeNull();

    const ctx = ctxFor("job-master");
    await ensureClone(ctx);
    await ensureBaseRef(ctx);

    const created = remoteSha(originDir, DEFAULT_BASE_BRANCH);
    expect(created).not.toBeNull(); // ← HEAD resolves, so a HEAD-keyed level (i) skips it
    expect(created).toMatch(/^[0-9a-f]{40}$/);
    // Branched from the existing tip rather than rooted beside it, so `main` and `master`
    // share history and no redundant empty commit is added on top of a populated repo.
    expect(remoteSha(originDir, DEFAULT_BASE_BRANCH)).toBe(remoteSha(originDir, "master"));

    // …and the full sequence still reaches a PR-able v0.0.0 above it.
    const { baseSha } = await materializeBaseVersion(ctx);
    await pushBranchFromWorkspace(ctx, BASE_BRANCH);
    expect(baseSha).not.toBe(remoteSha(originDir, DEFAULT_BASE_BRANCH));
    expect(remoteBranches(originDir)).toContain(BASE_BRANCH);
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
  /**
   * Reproduce what GitHub's `PUT /merge` does to the ORIGIN when the base PR is squash-merged:
   * `main` gains a BRAND-NEW commit carrying v0.0.0's tree, parented on the pre-scaffold tip.
   * v0.0.0's own commit is deliberately NOT an ancestor of the result — that is the whole
   * shape of the defect, so the fixture must not fake it with a fast-forward.
   */
  function squashMergeIntoBase(bare: string, head: string, base = DEFAULT_BASE_BRANCH): string {
    const work = mkdtempSync(join(root, "merge-"));
    git(["clone", bare, work]);
    git(["-C", work, "checkout", base]);
    git(["-C", work, "merge", "--squash", `origin/${head}`]);
    git(["-C", work, "commit", "-m", `Squash merge ${head}`]);
    git(["-C", work, "push", "origin", base]);
    return execFileSync("git", ["-C", work, "rev-parse", "HEAD"], {
      env: { ...process.env, ...HERMETIC },
    })
      .toString()
      .trim();
  }

  /** True when `ancestor` is reachable from `descendant` on the origin. */
  function isAncestor(bare: string, ancestor: string, descendant: string): boolean {
    try {
      execFileSync(
        "git",
        [
          "-C",
          bare,
          "merge-base",
          "--is-ancestor",
          `refs/heads/${ancestor}`,
          `refs/heads/${descendant}`,
        ],
        { env: { ...process.env, ...HERMETIC }, stdio: "ignore" },
      );
      return true;
    } catch {
      return false;
    }
  }

  it("cuts v0.0.1 from the MERGED base tip and pushes it to the origin", async () => {
    const ctx = ctxFor("job-d");
    const { baseSha } = await materializeBaseVersion(ctx);
    await pushBranchFromWorkspace(ctx, BASE_BRANCH);
    const mergeSha = squashMergeIntoBase(originDir, BASE_BRANCH);

    const { workingSha } = await cutWorkingBranchLocal(ctx, mergeSha);
    // A plain cut — no new commit — but at the MERGE commit, not the local v0.0.0 tip. The
    // squash gave those two different shas, which is exactly why the distinction matters.
    expect(workingSha).toBe(mergeSha);
    expect(workingSha).not.toBe(baseSha);
    await pushBranchFromWorkspace(ctx, WORKING_BRANCH);

    const branches = remoteBranches(originDir);
    expect(branches).toContain(BASE_BRANCH);
    expect(branches).toContain(WORKING_BRANCH);
    // The scaffold is still there — cutting from main must not lose the tree it merged.
    expect(existsSync(join(workspacePath(ctx), "supagloo.project.json"))).toBe(true);
  });

  /**
   * THE REGRESSION. `publishVersionWorkflow` opens `v0.0.1 → main` and merges it; GitHub can
   * only do that if the two have not diverged. Cutting v0.0.1 from the local v0.0.0 branch
   * (as this did until now) left `main` UNREACHABLE from v0.0.1 after the squash, so every
   * publish PR was born `mergeable_state: "dirty"` and its merge answered `405 "not
   * mergeable"`. Asserting reachability on the ORIGIN is what pins the fix: it fails on the
   * old `checkoutBranch(path, WORKING_BRANCH, BASE_BRANCH)` and passes on the merge sha.
   */
  it("leaves v0.0.1 a descendant of main, so a later publish PR is mergeable", async () => {
    const ctx = ctxFor("job-d2");
    await materializeBaseVersion(ctx);
    await pushBranchFromWorkspace(ctx, BASE_BRANCH);
    const mergeSha = squashMergeIntoBase(originDir, BASE_BRANCH);

    await cutWorkingBranchLocal(ctx, mergeSha);
    await pushBranchFromWorkspace(ctx, WORKING_BRANCH);

    expect(isAncestor(originDir, DEFAULT_BASE_BRANCH, WORKING_BRANCH)).toBe(true);
    // ...and the pre-squash v0.0.0 commit is NOT on that line, confirming the fixture really
    // reproduced a squash (an accidental fast-forward would make the assertion above free).
    expect(isAncestor(originDir, BASE_BRANCH, WORKING_BRANCH)).toBe(false);
  });

  it("self-heals a lost workspace and still cuts from the merged base tip", async () => {
    const ctx = ctxFor("job-d3");
    await materializeBaseVersion(ctx);
    await pushBranchFromWorkspace(ctx, BASE_BRANCH);
    const mergeSha = squashMergeIntoBase(originDir, BASE_BRANCH);

    rmSync(workspacePath(ctx), { recursive: true, force: true }); // crash: workspace gone

    const { workingSha } = await cutWorkingBranchLocal(ctx, mergeSha);
    expect(workingSha).toBe(mergeSha);
    await pushBranchFromWorkspace(ctx, WORKING_BRANCH);
    expect(remoteSha(originDir, WORKING_BRANCH)).toBe(mergeSha);
  });
});
