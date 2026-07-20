import { existsSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ProjectManifest } from "@supagloo/database-lib";
import { applyManifest } from "../../remotion";
import { pushBranch, revParse } from "../scaffold-project/git";
import {
  changedFilesForHead,
  cloneBranch,
  commitWithMessage,
  headCommitHasJobId,
  workingTreeDirty,
} from "./git";

/**
 * Self-healing git workspace for the commit-version workflow.
 *
 * The clone lives in an EPHEMERAL temp dir keyed by the DBOS workflow (job) id — it does
 * NOT survive a worker restart. Every FS-touching step calls {@link ensureCommitClone}
 * first (reuse-or-reclone the WORKING branch), so a crash that loses the workspace is
 * healed by a clean re-clone on the resumed step.
 *
 * Commit WRITES to the remote (unlike import) with a non-deterministic SHA (unlike
 * scaffold), so {@link commitBranch} carries the crux idempotency: it recognises its OWN
 * prior push via the jobId trailer and never double-commits (see the three cases below).
 */

export interface CommitContext {
  /** = DBOS workflow id; keys the deterministic workspace path AND the commit trailer. */
  jobId: string;
  /** Authenticated clone URL (the workflow injects `x-access-token:<token>@`). */
  cloneUrl: string;
  /** The working branch to clone, commit onto, and push (= the project's currentBranch). */
  branchName: string;
  /** The edited composition to persist (regenerated into the tree by applyManifest). */
  manifest: ProjectManifest;
  /** The real user-supplied commit message. */
  message: string;
  /** Root for workspaces; injectable for tests. Defaults to an OS temp subdir. */
  workspaceRoot?: string;
}

/** The outcome of {@link commitBranch}: whether a NEW commit was pushed, plus the durable
 *  head SHA + change set to record on the working ProjectVersion. */
export interface CommitOutcome {
  committed: boolean;
  headCommitSha: string;
  changedFiles: string[];
}

const DEFAULT_ROOT = join(tmpdir(), "supagloo-commit");

export function commitWorkspacePath(ctx: CommitContext): string {
  return join(ctx.workspaceRoot ?? DEFAULT_ROOT, ctx.jobId);
}

/** Ensure a valid depth-2 clone of the working branch exists at the deterministic path. */
export async function ensureCommitClone(ctx: CommitContext): Promise<string> {
  const path = commitWorkspacePath(ctx);
  if (existsSync(join(path, ".git"))) return path; // reuse a live workspace
  await rm(path, { recursive: true, force: true }); // clear any partial remnant
  await mkdir(dirname(path), { recursive: true });
  await cloneBranch(ctx.cloneUrl, path, ctx.branchName, { depth: 2 });
  return path;
}

/**
 * Ensure clone + regenerate the manifest-derived files (a deterministic full overwrite;
 * the manifest is the sole source of truth in v1 — hand-edits to `src/scenes/*` are not
 * preserved). Idempotent on repeat.
 */
export async function ensureManifestApplied(
  ctx: CommitContext,
): Promise<{ path: string; filesWritten: string[]; removed: string[] }> {
  const path = await ensureCommitClone(ctx);
  const { filesWritten, removed } = await applyManifest(ctx.manifest, path);
  return { path, filesWritten, removed };
}

/**
 * Commit + push the edited manifest — the crux idempotent step. Self-heals (ensure clone +
 * re-apply manifest, since the workspace may be a fresh re-clone on replay), then:
 *
 *   1. HEAD already carries THIS job's trailer ⇒ a prior attempt already committed+pushed
 *      (the pushed-but-not-checkpointed crash window). No-op; report the real change set.
 *   2. Working tree dirty ⇒ commit (with the trailer) + push; report the new head + diff.
 *   3. Clean tree, HEAD not ours ⇒ the manifest already matches the tip (a genuine
 *      no-change commit). No-op; report `[]` changed.
 *
 * Every path yields at most ONE commit for a given job — "re-run doesn't double-commit".
 */
export async function commitBranch(ctx: CommitContext): Promise<CommitOutcome> {
  const path = await ensureCommitClone(ctx);
  await applyManifest(ctx.manifest, path);

  // Case 1: our own prior attempt already pushed this commit.
  if (await headCommitHasJobId(path, ctx.jobId)) {
    return {
      committed: false,
      headCommitSha: await revParse(path, "HEAD"),
      changedFiles: await changedFilesForHead(path),
    };
  }

  // Case 2: the manifest produced a real change → commit + push.
  if (await workingTreeDirty(path)) {
    const headCommitSha = await commitWithMessage(path, ctx.message, ctx.jobId);
    await pushBranch(path, ctx.branchName);
    return {
      committed: true,
      headCommitSha,
      changedFiles: await changedFilesForHead(path),
    };
  }

  // Case 3: no change (the manifest already matches the tip) → no-op.
  return {
    committed: false,
    headCommitSha: await revParse(path, "HEAD"),
    changedFiles: [],
  };
}

/** Remove the ephemeral workspace (called on workflow completion). */
export async function removeCommitWorkspace(ctx: CommitContext): Promise<void> {
  await rm(commitWorkspacePath(ctx), { recursive: true, force: true });
}
