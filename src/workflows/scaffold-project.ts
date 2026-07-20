import { DBOS } from "@dbos-inc/dbos-sdk";
import {
  mintInstallationToken,
  type ScaffoldProjectPayload,
} from "@supagloo/database-lib";
import { WORKFLOW_NAMES } from "../dbos/registry";
import { getAppDb } from "../db/app-db";
import { getScaffoldConfig } from "./scaffold-project/config";
import {
  ensureRepoReachable,
  mergePullRequest,
  openPullRequest,
} from "./scaffold-project/github-rest";
import { retryUnlessPermanent } from "./scaffold-project/retry";
import {
  BASE_BRANCH,
  WORKING_BRANCH,
  cutWorkingBranchLocal,
  ensureClone,
  ensureScaffold,
  materializeBaseVersion,
  pushBranchFromWorkspace,
  removeWorkspace,
  type ScaffoldContext,
} from "./scaffold-project/workspace";
import { markJobRunning, markStageDone } from "./scaffold-project/stages";
import { finalizeRecords } from "./scaffold-project/finalize";

/**
 * `scaffoldProjectWorkflow` (queue `git-ops`) — the first real git-ops workflow.
 *
 * Design-delta §7 workflow 1. The repo already EXISTS (created pre-enqueue via the
 * JIT zero-storage user-token hop at the API/BFF layer); repo creation is OUT of
 * scope. Eight steps, each a named `DBOS.runStep`, mirroring the job-stage log
 * row-for-row:
 *   mintInstallationToken → ensureRepoAccessible → cloneToWorkspace →
 *   writeRemotionScaffold → commitBaseVersion(v0.0.0) → pushOpenMergeBasePr →
 *   cutWorkingBranch(v0.0.1) → finalizeRecords.
 *
 * Crash-safety: the clone lives in an EPHEMERAL temp dir that does not survive a
 * restart, so every FS-touching step rebuilds its local state idempotently from the
 * durable remote (see `workspace.ts`), and the base commit is byte-deterministic so
 * a rebuilt `v0.0.0` re-pushes as a clean no-op. Side effects tolerate at-least-once
 * (see `github-rest.ts`). Registered STATICALLY at module load (imported by
 * runtime.ts before `DBOS.launch()`).
 */

export const SCAFFOLD_PROJECT_WORKFLOW_NAME = WORKFLOW_NAMES.scaffoldProject;

// The workflow's argument shape is the SHARED db-lib enqueue contract (the API
// constructs + enqueues it). Re-exported so existing importers of this module (e.g.
// the e2e) keep importing `ScaffoldProjectPayload` from here.
export type { ScaffoldProjectPayload };

export interface ScaffoldProjectResult {
  workflowId: string;
  projectId: string;
  baseVersion: {
    semver: "0.0.0";
    branchName: "v0.0.0";
    headCommitSha: string;
    prNumber: number;
    prUrl: string;
  };
  workingVersion: {
    semver: "0.0.1";
    branchName: "v0.0.1";
    headCommitSha: string;
  };
}

/**
 * TEST-ONLY dependency-injection seam (undefined in production ⇒ a pure no-op). The
 * workflow body awaits this hook at each step BOUNDARY (between checkpoints), so a
 * test can park the workflow at a chosen boundary and drive a crash/replay. Reading
 * a module-level ref — never mutating one — from the workflow is a DI read (like an
 * injected `fetch`), not workflow state; and because the hook never changes which
 * steps run or their order, determinism is preserved (on replay it is cleared).
 */
export type BoundaryHook = (label: string) => void | Promise<void>;
let boundaryHook: BoundaryHook | undefined;
export function __setBoundaryHook(hook: BoundaryHook | undefined): void {
  boundaryHook = hook;
}
async function boundary(label: string): Promise<void> {
  if (boundaryHook) await boundaryHook(label);
}

/** Retry policy for network/git steps: retry transient failures with backoff. */
const NETWORK_RETRY = {
  retriesAllowed: true,
  maxAttempts: 4,
  intervalSeconds: 1,
  backoffRate: 2,
} as const;

const PR_TITLE = "Initial Supagloo scaffold (v0.0.0)";
const PR_BODY =
  "Automated base scaffold created by Supagloo. Merging establishes the base " +
  "version (v0.0.0); the working branch (v0.0.1) is cut from it.";

/** Build the authenticated clone URL (`x-access-token:<token>@host/owner/repo.git`). */
function authenticatedCloneUrl(
  gitBaseUrl: string,
  owner: string,
  repo: string,
  token: string,
): string {
  const url = new URL(`${gitBaseUrl.replace(/\/+$/, "")}/${owner}/${repo}.git`);
  url.username = "x-access-token";
  url.password = token;
  return url.toString();
}

async function scaffoldProjectFn(
  payload: ScaffoldProjectPayload,
): Promise<ScaffoldProjectResult> {
  const jobId = DBOS.workflowID;
  if (!jobId) {
    throw new Error("scaffoldProject: DBOS.workflowID unavailable inside the workflow");
  }
  const prisma = getAppDb();
  const cfg = getScaffoldConfig();
  const rest = (token: string) => ({ apiBaseUrl: cfg.githubApiBaseUrl, token });

  // 0) markJobRunning — flip the job lifecycle status queued → running so the polling
  //    UI observes progress before any stage completes. Status ONLY (no stage change).
  await boundary("markJobRunning");
  await DBOS.runStep(
    async () => {
      await markJobRunning(prisma, jobId);
    },
    { name: "markJobRunning" },
  );

  // 1) mintInstallationToken — App JWT → ~1h installation token (never persisted).
  await boundary("mintInstallationToken");
  const token = await DBOS.runStep(
    async () => {
      const minted = await mintInstallationToken({
        appId: cfg.githubAppId,
        privateKey: cfg.githubAppPrivateKey,
        installationId: payload.installationId,
        apiBaseUrl: cfg.githubApiBaseUrl,
      });
      await markStageDone(prisma, jobId, "mintInstallationToken");
      return minted.token;
    },
    { name: "mintInstallationToken", ...NETWORK_RETRY },
  );

  // 2) ensureRepoAccessible — idempotent reachability (NOT repo creation).
  await boundary("ensureRepoAccessible");
  await DBOS.runStep(
    async () => {
      await ensureRepoReachable(rest(token), payload.repoOwner, payload.repoName);
      await markStageDone(prisma, jobId, "ensureRepoAccessible");
    },
    {
      name: "ensureRepoAccessible",
      ...NETWORK_RETRY,
      // Fail fast on typed permanent failures (unreachable repo, permanent 4xx);
      // retry transient ones. Shared classifier — see `retry.ts`.
      shouldRetry: retryUnlessPermanent,
    },
  );

  const ctx: ScaffoldContext = {
    jobId,
    cloneUrl: authenticatedCloneUrl(
      cfg.githubGitBaseUrl,
      payload.repoOwner,
      payload.repoName,
      token,
    ),
    manifest: payload.manifest,
    defaultBranch: "main",
  };

  // 3) cloneToWorkspace — clone into the ephemeral, deterministic workspace.
  await boundary("cloneToWorkspace");
  await DBOS.runStep(
    async () => {
      await ensureClone(ctx);
      await markStageDone(prisma, jobId, "cloneToWorkspace");
    },
    // Clone shells out to git; a redacted, classified GitCommandError lets a
    // permanent auth/not-found failure fail fast (see `git.ts` / `retry.ts`).
    { name: "cloneToWorkspace", ...NETWORK_RETRY, shouldRetry: retryUnlessPermanent },
  );

  // 4) writeRemotionScaffold — template + supagloo.project.json (task-16 fn).
  await boundary("writeRemotionScaffold");
  const filesWritten = await DBOS.runStep(
    async () => {
      const { filesWritten } = await ensureScaffold(ctx);
      await markStageDone(prisma, jobId, "writeRemotionScaffold");
      return filesWritten;
    },
    { name: "writeRemotionScaffold" },
  );

  // 5) commitBaseVersion — deterministic v0.0.0 commit.
  await boundary("commitBaseVersion");
  const baseSha = await DBOS.runStep(
    async () => {
      const { baseSha } = await materializeBaseVersion(ctx);
      await markStageDone(prisma, jobId, "commitBaseVersion");
      return baseSha;
    },
    { name: "commitBaseVersion" },
  );

  // 6) pushOpenMergeBasePr — push v0.0.0, open the base PR, merge it. Self-heals the
  //    workspace first so a crash-recovered run (workspace lost) rebuilds v0.0.0.
  await boundary("pushOpenMergeBasePr");
  const pr = await DBOS.runStep(
    async () => {
      await materializeBaseVersion(ctx);
      await pushBranchFromWorkspace(ctx, BASE_BRANCH);
      const opened = await openPullRequest(rest(token), {
        owner: payload.repoOwner,
        repo: payload.repoName,
        head: BASE_BRANCH,
        base: "main",
        title: PR_TITLE,
        body: PR_BODY,
      });
      const merged = await mergePullRequest(rest(token), {
        owner: payload.repoOwner,
        repo: payload.repoName,
        number: opened.number,
      });
      await markStageDone(prisma, jobId, "pushOpenMergeBasePr");
      return {
        number: opened.number,
        url: opened.url,
        // The merge sha (base version's recorded head); falls back to the local
        // base sha on the idempotent 405-already-merged replay path.
        mergeSha: merged.sha ?? baseSha,
      };
    },
    // Push (git) + PR open/merge (REST): fail fast on a permanent git auth failure
    // or a permanent 4xx from GitHub; retry transient 5xx/429/network.
    { name: "pushOpenMergeBasePr", ...NETWORK_RETRY, shouldRetry: retryUnlessPermanent },
  );

  // 7) cutWorkingBranch — cut v0.0.1 from the base and push it.
  await boundary("cutWorkingBranch");
  const workingSha = await DBOS.runStep(
    async () => {
      const { workingSha } = await cutWorkingBranchLocal(ctx);
      await pushBranchFromWorkspace(ctx, WORKING_BRANCH);
      await markStageDone(prisma, jobId, "cutWorkingBranch");
      return workingSha;
    },
    // Pushes the working branch (git); fail fast on a permanent git auth/push failure.
    { name: "cutWorkingBranch", ...NETWORK_RETRY, shouldRetry: retryUnlessPermanent },
  );

  // 8) finalizeRecords — Project + 2 ProjectVersion rows + job stages/status.
  await boundary("finalizeRecords");
  await DBOS.runStep(
    async () => {
      await finalizeRecords(prisma, jobId, {
        projectId: payload.projectId,
        repoOwner: payload.repoOwner,
        repoName: payload.repoName,
        repoVisibility: payload.repoVisibility,
        base: { headCommitSha: pr.mergeSha, prNumber: pr.number, prUrl: pr.url },
        working: { headCommitSha: workingSha },
        changedFiles: filesWritten,
      });
      await removeWorkspace(ctx);
    },
    { name: "finalizeRecords", retriesAllowed: true, maxAttempts: 3 },
  );

  return {
    workflowId: jobId,
    projectId: payload.projectId,
    baseVersion: {
      semver: "0.0.0",
      branchName: "v0.0.0",
      headCommitSha: pr.mergeSha,
      prNumber: pr.number,
      prUrl: pr.url,
    },
    workingVersion: {
      semver: "0.0.1",
      branchName: "v0.0.1",
      headCommitSha: workingSha,
    },
  };
}

export const scaffoldProjectWorkflow = DBOS.registerWorkflow(scaffoldProjectFn, {
  name: SCAFFOLD_PROJECT_WORKFLOW_NAME,
});
