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

/** Resolve any ref to its SHA, or `null` when the ref does not exist. */
async function refSha(dir: string, ref: string): Promise<string | null> {
  try {
    const out = (await git(["rev-parse", "--verify", "--quiet", ref], { cwd: dir })).trim();
    return out || null;
  } catch {
    return null; // ref does not exist (rev-parse --verify exits non-zero)
  }
}

async function branchSha(dir: string, branch: string): Promise<string | null> {
  return refSha(dir, `refs/heads/${branch}`);
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
 *   (i)   the origin is already KNOWN to carry the base ref ⇒ adopt it locally, no
 *         network (the overwhelmingly common case: an `auto_init`ed or already-populated
 *         repo, whose clone recorded `refs/remotes/origin/<base>`);
 *   (ii)  our cached view may be stale, so ASK the origin (a concurrent replay won, or
 *         our push landed but its report was lost) ⇒ fetch and adopt, never re-create;
 *   (iii) the origin genuinely lacks the ref ⇒ create the branch explicitly (`checkout
 *         -B`, because the unborn HEAD's name varies with git version and remote
 *         `init.defaultBranch`), give it the deterministic EMPTY bootstrap commit if and
 *         only if HEAD is still unborn, and push it;
 *   (iv)  the push loses a race (another replay pushed first) ⇒ re-fetch and adopt the
 *         remote ref instead of failing.
 *
 * EVERY LEVEL IS KEYED ON REMOTE STATE, WHICH IS THE WHOLE POINT (review R4). The durable
 * effect lives on the origin, and level (iii) necessarily creates the local commit BEFORE
 * it pushes. So a short-circuit keyed on the LOCAL `HEAD` — "the clone already has
 * commits" — is satisfied by our own half-finished work: `cloneToWorkspace` is
 * `{ ...NETWORK_RETRY, shouldRetry: retryUnlessPermanent }` and `ensureClone` REUSES a
 * live workspace, so one transient `pushBranch` failure re-enters this function on a
 * workspace whose HEAD now resolves, the bootstrap is skipped permanently, `main` is
 * never pushed, and `openPullRequest(base: "main")` 422s — the exact defect above.
 * `refs/remotes/origin/<base>` is the local record of an OBSERVATION of the origin: git
 * writes it on clone, on fetch, and on a SUCCESSFUL push, and a local `git commit` can
 * never forge it. (Residual, deliberately not handled: a branch deleted on the origin
 * after we cloned leaves a stale tracking ref. That is an external mutation, not a replay
 * hazard, and re-checking it would cost a network round-trip on every scaffold.)
 *
 * Idempotent and crash-safe: the effect is durable on the REMOTE, so a rebuilt
 * (ephemeral) workspace re-clones a repo that already satisfies level (i) or (ii), and a
 * re-entry at level (iii) re-pushes the SAME single bootstrap commit rather than stacking
 * a second one — which matters because `v0.0.0` is committed on top of the base tip, so a
 * changed parent would change the `baseSha` that `commitBaseVersion` already checkpointed.
 * Called from inside the EXISTING `cloneToWorkspace` step — deliberately not a new
 * `DBOS.runStep`, because db-lib's `SCAFFOLD_STAGES` is pinned key-for-key to the step
 * names and must keep mirroring wireframe 12a's designed 7-row log (D63.2).
 */
export async function ensureBaseRef(ctx: ScaffoldContext): Promise<void> {
  const path = workspacePath(ctx);
  const base = baseRefOf(ctx);

  // (i) The origin was OBSERVED to have the base ref — by the clone, by a fetch, or by a
  // push of ours that succeeded. Adopt it and stop; no network, and no local commit can
  // fake this ref. Checking out from it (rather than just returning) also leaves the
  // workspace ON the base branch even when the origin's default branch is some other name.
  const trackingRef = `refs/remotes/origin/${base}`;
  if (await refSha(path, trackingRef)) {
    await checkoutBranch(path, base, trackingRef);
    return;
  }

  // (ii) That view can be stale — ask the origin itself (a concurrent replay may have
  // pushed after we cloned, or our own push may have landed with its report lost).
  if (await adoptRemoteBaseRef(path, base)) return;

  // (iii) The origin genuinely has no base ref. Create it — from the current tip if the
  // clone has commits under a different branch name, else as a root commit.
  await checkoutBranch(path, base);
  // The bootstrap commit exists only to give a commit-less repo something to point at, so
  // make it ONLY when HEAD is still unborn. That keeps a re-entry after a failed push
  // idempotent (it re-pushes the same commit instead of stacking another empty one) and
  // keeps a populated-but-differently-named repo free of a pointless empty commit.
  if (!(await headExists(path))) await commitEmpty(path, BOOTSTRAP_COMMIT.message);
  try {
    await pushBranch(path, base);
  } catch (err) {
    // (iv) A racing replay won the push. Adopt its ref rather than failing the step;
    // re-throw only if the remote genuinely still has no base ref (a real push error).
    if (!(await adoptRemoteBaseRef(path, base))) throw err;
  }
}

/**
 * True when the working tree has a resolvable HEAD (i.e. it has commits).
 *
 * ONLY safe as "does a commit exist here to point a branch at" — never as "is the
 * bootstrap done", because this function cannot distinguish a commit that is durable on
 * the origin from one this workspace made and failed to push (review R4).
 */
async function headExists(dir: string): Promise<boolean> {
  return (await refSha(dir, "HEAD")) !== null;
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

/**
 * Cut the `v0.0.1` working branch from the MERGED base tip (a plain branch, no commit).
 *
 * `mergedBaseSha` is the sha `pushOpenMergeBasePr` got back from merging the base PR — the
 * commit that `main` actually points at, NOT the local `v0.0.0` tip.
 *
 * **Cutting from the local `v0.0.0` branch is the bug this parameter exists to prevent.**
 * The base PR is SQUASH-merged, so `main` receives a BRAND-NEW commit parented on the base
 * tip; `v0.0.0`'s own commit is never an ancestor of `main`. A `v0.0.1` cut from `v0.0.0`
 * therefore DIVERGES from `main` at the pre-scaffold commit, and both sides independently
 * "add" all 14 scaffold files. Everything the user then edits on `v0.0.1` turns those into
 * add/add conflicts with different content, so `publishVersionWorkflow`'s PR is born
 * `mergeable_state: "dirty"` and GitHub answers its merge `405 "not mergeable"` — surfacing
 * as publish-version's `is NOT merged … refusing its test-merge sha` (the correct refusal
 * from a resolveMergeCommitSha that was handed an unmergeable PR). Reproduced on
 * `ashtable/genesis-1#2`: `main`/`v0.0.1` `status: "diverged"`, merge base = the auto_init
 * commit. Cutting from the merge sha makes `v0.0.1` a descendant of `main`, which is also
 * exactly what `publish-version/workspace.ts#cutNextBranch` already does for every LATER
 * version — this makes scaffold agree with publish instead of contradicting it.
 *
 * The merge commit is created on the ORIGIN by the REST merge, so a workspace cloned before
 * that call has never seen it: fetch the base branch first (which carries the merge sha, and
 * still carries it as an ancestor if the branch has since moved on).
 */
export async function cutWorkingBranchLocal(
  ctx: ScaffoldContext,
  mergedBaseSha: string,
): Promise<{ path: string; workingSha: string }> {
  const path = await ensureClone(ctx); // self-heal: a crash-lost workspace re-clones
  await git(["fetch", "origin", baseRefOf(ctx)], { cwd: path });
  await checkoutBranch(path, WORKING_BRANCH, mergedBaseSha);
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
