import { existsSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ProjectManifest } from "@supagloo/database-lib";
import { writeRemotionScaffold } from "../../remotion";
import {
  checkoutBranch,
  clone,
  commitAll,
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

export interface ScaffoldContext {
  /** = DBOS workflow id; keys the deterministic workspace path. */
  jobId: string;
  /** Authenticated clone URL (the workflow injects `x-access-token:<token>@`). */
  cloneUrl: string;
  /** Initial composition to scaffold (written as `supagloo.project.json` + code). */
  manifest: ProjectManifest;
  /** Repo default branch (the base of the PR). Defaults to `main`. */
  defaultBranch?: string;
  /** Root for workspaces; injectable for tests. Defaults to an OS temp subdir. */
  workspaceRoot?: string;
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

  await checkoutBranch(path, BASE_BRANCH); // create v0.0.0 at the default-branch tip
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
