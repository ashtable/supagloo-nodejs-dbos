import { existsSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ProjectManifest } from "@supagloo/database-lib";
import { writeRemotionScaffold } from "../../remotion";
import {
  BOOTSTRAP_COMMIT,
  checkoutBranch,
  clone,
  commitAll,
  commitEmpty,
  git,
  pushBranch,
  revParse,
} from "./git";

/**
 * Self-healing, deterministic git workspace for the scaffold workflow.
 *
 * The clone lives in an EPHEMERAL temp dir keyed by the workflow (job) id — it does
 * NOT survive a worker restart. DBOS checkpoints each step's RESULT, so on recovery
 * completed steps are skipped even though their local filesystem effects are gone.
 * These helpers close that gap: every FS-touching step rebuilds exactly the local
 * state it needs, idempotently, from the durable remote. Because the base commit is
 * byte-deterministic ({@link commitAll}), a rebuild after a crash yields the
 * IDENTICAL `v0.0.0` SHA, so re-pushing it is consistent with the SHA already
 * recorded by the checkpointed `commitBaseVersion` step.
 */

export const BASE_BRANCH = "v0.0.0";
export const WORKING_BRANCH = "v0.0.1";

/**
 * The branch the base PR targets and that scaffold must leave behind (plan row 63).
 *
 * Note the naming trap: `BASE_BRANCH` above is the **version** branch (`v0.0.0`), not
 * the PR base. The PR base used to be a bare `"main"` literal in `scaffold-project.ts`;
 * it is now this constant, read through `ScaffoldContext.defaultBranch`.
 *
 * Scaffold MUST leave this ref behind (D63.4): `publish-version.ts` opens its own PR
 * with `base: "main"` and `publish-version/workspace.ts` does a literal
 * `git clone --branch main --depth 1`, so a scaffold that skipped it would break
 * publish twice.
 */
export const DEFAULT_BASE_BRANCH = "main";

export interface ScaffoldContext {
  /** = DBOS workflow id; keys the deterministic workspace path. */
  jobId: string;
  /** Authenticated clone URL (the workflow injects `x-access-token:<token>@`). */
  cloneUrl: string;
  /** Initial composition to scaffold (written as `supagloo.project.json` + code). */
  manifest: ProjectManifest;
  /** Repo default branch (the base of the PR). Defaults to {@link DEFAULT_BASE_BRANCH}. */
  defaultBranch?: string;
  /** Root for workspaces; injectable for tests. Defaults to an OS temp subdir. */
  workspaceRoot?: string;
}

/** The PR base for this run — {@link DEFAULT_BASE_BRANCH} unless the context overrides it. */
export function baseRefOf(ctx: ScaffoldContext): string {
  return ctx.defaultBranch ?? DEFAULT_BASE_BRANCH;
}

const DEFAULT_ROOT = join(tmpdir(), "supagloo-scaffold");

export function workspacePath(ctx: ScaffoldContext): string {
  return join(ctx.workspaceRoot ?? DEFAULT_ROOT, ctx.jobId);
}

async function branchSha(dir: string, branch: string): Promise<string | null> {
  try {
    const out = (
      await git(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], {
        cwd: dir,
      })
    ).trim();
    return out || null;
  } catch {
    return null; // ref does not exist (rev-parse --verify exits non-zero)
  }
}

/** Ensure a valid clone exists at the deterministic path (reuse, else fresh). */
export async function ensureClone(ctx: ScaffoldContext): Promise<string> {
  const path = workspacePath(ctx);
  if (existsSync(join(path, ".git"))) return path; // reuse a live workspace
  await rm(path, { recursive: true, force: true }); // clear any partial remnant
  await mkdir(dirname(path), { recursive: true });
  await clone(ctx.cloneUrl, path);
  return path;
}

/**
 * Bootstrap the base ref when the repository is genuinely commit-less (plan row 63).
 *
 * THE DEFECT. A repo with no commits clones with **exit 0** and an UNBORN HEAD
 * ("warning: You appear to have cloned an empty repository"), so every later step
 * appears to work: `checkout -B v0.0.0` succeeds from an unborn HEAD, `git commit`
 * makes a parentless ROOT commit, and the push succeeds — at which point REAL GITHUB
 * PROMOTES `v0.0.0` TO `default_branch`, because it is the first ref the repo ever had.
 * Only then does `openPullRequest(base: "main")` answer `422 Validation Failed
 * (field: base, code: invalid)`, leaving the repo half-scaffolded. This reaches BOTH
 * wizard paths: create-new (before row 63 the api sent no `auto_init`) and wireframe
 * 13a's "Empty · created just now" existing repo, which has no create call at all.
 *
 * THE FIX. Establish the base ref FIRST, so `main` — not `v0.0.0` — is the ref GitHub
 * promotes, and so `v0.0.0` branches from a real tip and has commits between it and the
 * base. Four self-healing levels, in order (the house idiom):
 *   (i)   the clone already has commits ⇒ nothing to do (the overwhelmingly common case:
 *         an `auto_init`ed or already-populated repo);
 *   (ii)  the REMOTE already carries the base ref (a concurrent replay won, or the local
 *         clone predates it) ⇒ fetch and adopt it, never re-create it;
 *   (iii) genuinely unborn ⇒ create the branch explicitly (`checkout -B`, because the
 *         unborn HEAD's name varies with git version and remote `init.defaultBranch`),
 *         make the deterministic EMPTY bootstrap commit, and push it;
 *   (iv)  the push loses a race (another replay pushed first) ⇒ re-fetch and adopt the
 *         remote ref instead of failing.
 *
 * Idempotent and crash-safe: the effect is durable on the REMOTE, so a rebuilt
 * (ephemeral) workspace re-clones a repo that already satisfies level (i) or (ii).
 * Called from inside the EXISTING `cloneToWorkspace` step — deliberately not a new
 * `DBOS.runStep`, because db-lib's `SCAFFOLD_STAGES` is pinned key-for-key to the step
 * names and must keep mirroring wireframe 12a's designed 7-row log (D63.2).
 */
export async function ensureBaseRef(ctx: ScaffoldContext): Promise<void> {
  const path = workspacePath(ctx);
  const base = baseRefOf(ctx);

  // (i) The clone has commits — HEAD resolves. Nothing to bootstrap.
  if (await headExists(path)) return;

  // (ii) Someone already created the base ref on the remote (a concurrent replay).
  if (await adoptRemoteBaseRef(path, base)) return;

  // (iii) Genuinely unborn: create the ref and push it.
  await checkoutBranch(path, base);
  await commitEmpty(path, BOOTSTRAP_COMMIT.message);
  try {
    await pushBranch(path, base);
  } catch (err) {
    // (iv) A racing replay won the push. Adopt its ref rather than failing the step;
    // re-throw only if the remote genuinely still has no base ref (a real push error).
    if (!(await adoptRemoteBaseRef(path, base))) throw err;
  }
}

/** True when the working tree has a resolvable HEAD (i.e. the clone has commits). */
async function headExists(dir: string): Promise<boolean> {
  try {
    const out = (await git(["rev-parse", "--verify", "--quiet", "HEAD"], { cwd: dir })).trim();
    return out !== "";
  } catch {
    return false; // unborn HEAD — `rev-parse --verify` exits non-zero
  }
}

/** Fetch and check out `branch` from the origin if the REMOTE has it; else `false`. */
async function adoptRemoteBaseRef(dir: string, branch: string): Promise<boolean> {
  let listed: string;
  try {
    listed = await git(["ls-remote", "--heads", "origin", branch], { cwd: dir });
  } catch {
    return false;
  }
  if (!listed.trim()) return false;
  await git(["fetch", "origin", branch], { cwd: dir });
  await checkoutBranch(dir, branch, "FETCH_HEAD");
  return true;
}

/** Ensure clone + write the Remotion scaffold (a deterministic full overwrite). */
export async function ensureScaffold(
  ctx: ScaffoldContext,
): Promise<{ path: string; filesWritten: string[] }> {
  const path = await ensureClone(ctx);
  const { filesWritten } = await writeRemotionScaffold(ctx.manifest, path);
  return { path, filesWritten };
}

/**
 * Ensure the `v0.0.0` base commit exists. Idempotent: if the branch is already
 * committed (reused workspace), return its SHA without re-committing; otherwise
 * scaffold onto the default branch and make the deterministic base commit.
 */
export async function materializeBaseVersion(
  ctx: ScaffoldContext,
): Promise<{ path: string; baseSha: string; filesWritten: string[] }> {
  const { path, filesWritten } = await ensureScaffold(ctx);
  const existing = await branchSha(path, BASE_BRANCH);
  if (existing) return { path, baseSha: existing, filesWritten };

  // Create v0.0.0 at the CURRENT HEAD — which is the base-branch tip, because the clone
  // checked the default branch out and `ensureBaseRef` has already established it (and
  // left the workspace on it) for a repository that had no commits. Before plan row 63
  // this comment claimed "at the default-branch tip" while the repo could legitimately
  // have an unborn HEAD, in which case this produced a parentless ROOT commit.
  await checkoutBranch(path, BASE_BRANCH);
  const baseSha = await commitAll(path);
  return { path, baseSha, filesWritten };
}

/** Cut the `v0.0.1` working branch from the base commit (a plain branch, no commit). */
export async function cutWorkingBranchLocal(
  ctx: ScaffoldContext,
): Promise<{ path: string; workingSha: string }> {
  const { path } = await materializeBaseVersion(ctx);
  await checkoutBranch(path, WORKING_BRANCH, BASE_BRANCH);
  const workingSha = await revParse(path, "HEAD");
  return { path, workingSha };
}

/** Push a branch from the workspace to the origin (re-push of same SHA is a no-op). */
export async function pushBranchFromWorkspace(
  ctx: ScaffoldContext,
  branch: string,
): Promise<void> {
  await pushBranch(workspacePath(ctx), branch);
}

/** Remove the ephemeral workspace (called on workflow completion). */
export async function removeWorkspace(ctx: ScaffoldContext): Promise<void> {
  await rm(workspacePath(ctx), { recursive: true, force: true });
}
