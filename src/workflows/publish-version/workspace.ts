import { existsSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { checkoutBranch, pushBranch, revParse } from "../scaffold-project/git";
import { cloneBranch } from "../commit-version/git";

/**
 * Self-healing git workspace for the publish-version workflow.
 *
 * Publish touches TWO branches, so the workspace is sub-keyed by purpose under the job dir:
 *   <root>/<jobId>/working  — a clone of the WORKING branch (the PR head; head-capture + push)
 *   <root>/<jobId>/main     — a clone of `main`, from which the NEXT version branch is cut
 * Both live in an EPHEMERAL temp dir keyed by the DBOS workflow (job) id — they do NOT
 * survive a worker restart. Every FS-touching step re-clones what it needs (self-heal), so a
 * crash that loses the workspace is healed on the resumed step.
 *
 * Unlike commit, publish makes NO new commit: the request carries no manifest (the working
 * manifest was already committed via prior commitVersionWorkflow calls), so a fresh clone of
 * the working branch is always clean. `capturePublishHead` is therefore a pure head-capture,
 * and `cutNextBranch` only creates + pushes a new branch ref at main's tip (idempotent —
 * re-pushing the same sha is a no-op).
 */

export interface PublishContext {
  /** = DBOS workflow id; keys the deterministic workspace path. */
  jobId: string;
  /** Authenticated clone URL (the workflow injects `x-access-token:<token>@`). */
  cloneUrl: string;
  /** The working branch to publish (the PR head; = the project's currentBranch). */
  branchName: string;
  /** The working version's semver (the version being published — names the release tag). */
  semver: string;
  /** The publish/release message. */
  message: string;
  /** Root for workspaces; injectable for tests. Defaults to an OS temp subdir. */
  workspaceRoot?: string;
}

const DEFAULT_ROOT = join(tmpdir(), "supagloo-publish");

export function publishWorkspacePath(
  ctx: PublishContext,
  sub: "working" | "main",
): string {
  return join(ctx.workspaceRoot ?? DEFAULT_ROOT, ctx.jobId, sub);
}

/** Ensure a valid depth-2 clone of a branch exists at `path` (reuse a live one, else fresh). */
async function ensureBranchClone(
  path: string,
  cloneUrl: string,
  branch: string,
  depth: number,
): Promise<string> {
  if (existsSync(join(path, ".git"))) return path; // reuse a live workspace
  await rm(path, { recursive: true, force: true }); // clear any partial remnant
  await mkdir(dirname(path), { recursive: true });
  await cloneBranch(cloneUrl, path, branch, { depth });
  return path;
}

/** Ensure a clone of the WORKING branch exists at the deterministic path. */
export async function ensureWorkingClone(ctx: PublishContext): Promise<string> {
  return ensureBranchClone(
    publishWorkspacePath(ctx, "working"),
    ctx.cloneUrl,
    ctx.branchName,
    2,
  );
}

/**
 * Capture the working branch's head to publish. Publish carries NO manifest, so the fresh
 * clone is always clean — this ensures the clone (self-heal) and reports HEAD. No commit is
 * made (the working manifest was already committed via prior commitVersionWorkflow calls).
 */
export async function capturePublishHead(
  ctx: PublishContext,
): Promise<{ headCommitSha: string }> {
  const path = await ensureWorkingClone(ctx);
  return { headCommitSha: await revParse(path, "HEAD") };
}

/** Push the working branch to origin (a no-op if it is already at the origin's tip). */
export async function pushWorkingBranch(ctx: PublishContext): Promise<void> {
  const path = await ensureWorkingClone(ctx);
  await pushBranch(path, ctx.branchName);
}

/**
 * Cut the NEXT working version branch from `main` and push it. Clones `main` (self-heal),
 * creates `nextBranch` at main's tip (`checkout -B` is idempotent), and pushes it (re-pushing
 * the same sha is a clean no-op, so a replay never fails). Returns the branch's head sha
 * (= main's tip).
 */
export async function cutNextBranch(
  ctx: PublishContext,
  nextBranch: string,
): Promise<{ headCommitSha: string }> {
  const path = await ensureBranchClone(
    publishWorkspacePath(ctx, "main"),
    ctx.cloneUrl,
    "main",
    1,
  );
  await checkoutBranch(path, nextBranch); // create nextBranch at main's tip
  const headCommitSha = await revParse(path, "HEAD");
  await pushBranch(path, nextBranch);
  return { headCommitSha };
}

/** Remove the ephemeral workspace (called on workflow completion). */
export async function removePublishWorkspace(ctx: PublishContext): Promise<void> {
  await rm(join(ctx.workspaceRoot ?? DEFAULT_ROOT, ctx.jobId), {
    recursive: true,
    force: true,
  });
}
