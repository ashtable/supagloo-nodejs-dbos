import { existsSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { checkoutBranch, clone, git, revParse } from "../scaffold-project/git";

/**
 * Self-healing git workspace for the import-verify workflow.
 *
 * Import is READ-ONLY on the remote (clone + inspect; never push), so the crash-safety
 * story is simpler than scaffold's: there is no deterministic-commit obligation. Every
 * FS-touching step calls {@link ensureImportClone} first (reuse-or-reclone), so a crash
 * that loses the ephemeral clone is healed by a clean re-clone on the resumed step. The
 * workspace is keyed by the DBOS workflow (job) id.
 *
 * Branch enumeration + version-branch checkout read the LOCAL remote-tracking refs that
 * `git clone` already fetched — no extra network round-trip — so verify and resolve add
 * zero remote git ops beyond the single clone.
 */

export interface ImportContext {
  /** = DBOS workflow id; keys the deterministic workspace path. */
  jobId: string;
  /** Authenticated clone URL (the workflow injects `x-access-token:<token>@`). */
  cloneUrl: string;
  /** Root for workspaces; injectable for tests. Defaults to an OS temp subdir. */
  workspaceRoot?: string;
}

const DEFAULT_ROOT = join(tmpdir(), "supagloo-import");

export function importWorkspacePath(ctx: ImportContext): string {
  return join(ctx.workspaceRoot ?? DEFAULT_ROOT, ctx.jobId);
}

/** Ensure a valid clone exists at the deterministic path (reuse, else fresh). */
export async function ensureImportClone(ctx: ImportContext): Promise<string> {
  const path = importWorkspacePath(ctx);
  if (existsSync(join(path, ".git"))) return path; // reuse a live workspace
  await rm(path, { recursive: true, force: true }); // clear any partial remnant
  await mkdir(dirname(path), { recursive: true });
  await clone(ctx.cloneUrl, path);
  return path;
}

/** Remove the ephemeral workspace (called on workflow completion). */
export async function removeImportWorkspace(ctx: ImportContext): Promise<void> {
  await rm(importWorkspacePath(ctx), { recursive: true, force: true });
}

/**
 * List every remote-tracking branch (short name, e.g. `main`, `v0.10.0`) from the local
 * clone — no network. `git clone` fetches all branch refs into `refs/remotes/origin/*`;
 * `origin/HEAD` (the symbolic default pointer) is filtered out.
 */
export async function listRemoteBranchNames(dir: string): Promise<string[]> {
  // Use the FULL refname so the symbolic default pointer (`refs/remotes/origin/HEAD`,
  // whose short form is the bare `origin`) can be excluded unambiguously before the
  // prefix is stripped.
  const out = await git(
    ["for-each-ref", "--format=%(refname)", "refs/remotes/origin"],
    { cwd: dir },
  );
  return out
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((ref) => ref !== "refs/remotes/origin/HEAD")
    .map((ref) => ref.replace(/^refs\/remotes\/origin\//, ""));
}

/** True iff `remotion.config.ts` exists at the checked-out repo root (the marker). */
export function hasRemotionConfig(dir: string): boolean {
  return existsSync(join(dir, "remotion.config.ts"));
}

/**
 * Check out a version branch from origin locally (no network — the ref is already
 * fetched) and return its head sha. `checkout -B` is idempotent on replay.
 */
export async function checkoutVersionBranch(
  dir: string,
  branch: string,
): Promise<string> {
  await checkoutBranch(dir, branch, `origin/${branch}`);
  return revParse(dir, "HEAD");
}
