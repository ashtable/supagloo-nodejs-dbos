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
  DEFAULT_BASE_BRANCH,
  WORKING_BRANCH,
  baseRefOf,
  cutWorkingBranchLocal,
  ensureBaseRef,
  ensureClone,
  ensureScaffold,
  materializeBaseVersion,
  pushBranchFromWorkspace,
  removeWorkspace,
  type ScaffoldContext,
} from "./scaffold-project/workspace";
import {
  markJobFailed,
  markJobRunning,
  markStageDone,
} from "./scaffold-project/stages";
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

  // Which stage is in flight, for the terminal-failure record below (D63.7). Free:
  // `boundary(label)` already receives EXACTLY the stage key at every step, so `at()`
  // just remembers it on the way past. A workflow-LOCAL variable (never module state),
  // deterministically re-derived on replay, and safe under the git-ops queue's
  // worker_concurrency > 1.
  let currentStage = "markJobRunning";
  const at = async (label: string): Promise<void> => {
    currentStage = label;
    await boundary(label);
  };

  try {
    // 0) markJobRunning — flip the job lifecycle status queued → running so the polling
    //    UI observes progress before any stage completes. Status ONLY (no stage change).
    await at("markJobRunning");
    await DBOS.runStep(
      async () => {
        await markJobRunning(prisma, jobId);
      },
      { name: "markJobRunning" },
    );

    // 1) mintInstallationToken — App JWT → ~1h installation token (never persisted).
    //
    // NO `shouldRetry` HERE, DELIBERATELY (plan row 64 / D64.5). Every one of the six
    // `mintInstallationToken` steps in this repo omits it — `import-project.ts`,
    // `publish-version.ts`, `commit-version.ts` and `render.ts` x2 — and row 64 leaves
    // all six alone on purpose. Adding `shouldRetry: retryUnlessPermanent` here would
    // classify a `GithubAppError` as permanent and fail fast, which sounds like an
    // improvement and is the opposite: a **secondary-limit `403 + Retry-After` is
    // survivable**, and db-lib's `mintInstallationToken` already honours it in-process
    // (row 64's db-lib half). A strict classifier at this layer would turn that
    // survivable throttle into an immediate FATAL at step 1 of every git-ops workflow —
    // the one place row 64's nominal fix would make things strictly worse. The cost of
    // leaving it is bounded and known: a genuinely bad private key burns the 4-attempt
    // NETWORK_RETRY budget (~7s) before failing, which is cheap insurance.
    await at("mintInstallationToken");
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
    await at("ensureRepoAccessible");
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
      defaultBranch: DEFAULT_BASE_BRANCH,
    };

    // 3) cloneToWorkspace — clone into the ephemeral, deterministic workspace, then
    //    BOOTSTRAP the base ref if the repository turns out to have no commits at all
    //    (plan row 63). A commit-less repo clones with exit 0 and an unborn HEAD, so
    //    without this the failure only surfaces three steps later as an unattributable
    //    422 on the base PR, with `v0.0.0` already pushed and promoted to the repo's
    //    default branch. Deliberately INSIDE this existing step, not a new one: db-lib's
    //    `SCAFFOLD_STAGES` is pinned key-for-key to these `runStep` names and must keep
    //    mirroring wireframe 12a's designed log row-for-row (D63.2).
    await at("cloneToWorkspace");
    await DBOS.runStep(
      async () => {
        await ensureClone(ctx);
        await ensureBaseRef(ctx);
        await markStageDone(prisma, jobId, "cloneToWorkspace");
      },
      // Clone shells out to git; a redacted, classified GitCommandError lets a
      // permanent auth/not-found failure fail fast (see `git.ts` / `retry.ts`).
      { name: "cloneToWorkspace", ...NETWORK_RETRY, shouldRetry: retryUnlessPermanent },
    );

    // 4) writeRemotionScaffold — template + supagloo.project.json (task-16 fn).
    await at("writeRemotionScaffold");
    const filesWritten = await DBOS.runStep(
      async () => {
        const { filesWritten } = await ensureScaffold(ctx);
        await markStageDone(prisma, jobId, "writeRemotionScaffold");
        return filesWritten;
      },
      { name: "writeRemotionScaffold" },
    );

    // 5) commitBaseVersion — deterministic v0.0.0 commit.
    await at("commitBaseVersion");
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
    await at("pushOpenMergeBasePr");
    const pr = await DBOS.runStep(
      async () => {
        await materializeBaseVersion(ctx);
        await pushBranchFromWorkspace(ctx, BASE_BRANCH);
        const opened = await openPullRequest(rest(token), {
          owner: payload.repoOwner,
          repo: payload.repoName,
          head: BASE_BRANCH,
          // The PR base, read from the context instead of a bare literal (plan row 63).
          // `ScaffoldContext.defaultBranch` had been dead code since task 17 — written
          // once, never read — which is precisely why nothing noticed that the base ref
          // might not exist. `ensureBaseRef` guarantees it does by this point.
          base: baseRefOf(ctx),
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
    await at("cutWorkingBranch");
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
    await at("finalizeRecords");
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
  } catch (err) {
    // Plan row 63 / D63.7. Until now this function had NO try/catch and no
    // `markJobFailed`, so a failure — row 63's own `422 field:base code:invalid` among
    // them — left `ProjectJob.status` at `"running"` with the offending stage `pending`
    // forever while DBOS reported ERROR. The user-visible face of the defect was an
    // ETERNAL WIZARD SPINNER instead of a failure.
    //
    // EVERY escaping error is recorded, not just the typed-permanent ones (review
    // finding DR4). The first cut gated this on `isPermanentScaffoldFailure(err)`, which
    // recognises exactly `RepoUnreachableError` / `GithubRestError` / `GitCommandError` —
    // and therefore NOT db-lib's `GithubAppError`, which is what step 1
    // `mintInstallationToken` throws, and not the Zod/Prisma errors `writeRemotionScaffold`
    // and `finalizeRecords` throw. A bad App private key or a revoked installation — the
    // single most likely permanent failure there is — reproduced the eternal spinner in
    // full inside the fix meant to kill it.
    //
    // Recording unconditionally is not a guess about transience: by the time an error
    // reaches this catch, DBOS has ALREADY spent that step's retry budget and
    // CHECKPOINTED the error (`dbos-executor.ts` writes it via `recordOperationResult`
    // and only then throws), so the step re-throws the same recorded error on every
    // replay. There is no path back to success without an operator `resumeWorkflow`, and
    // the workflow rethrows below either way, so the DBOS status is unchanged. A crash
    // — the case that IS recoverable — unwinds the process instead of running this catch.
    //
    // `markJobFailed` refuses to overwrite an already-`succeeded` job, which is what
    // keeps the widened catch honest if `finalizeRecords`' trailing `removeWorkspace`
    // ever throws after the success write (see `stages.ts`).
    try {
      await DBOS.runStep(
        async () => {
          await markJobFailed(
            prisma,
            jobId,
            currentStage,
            err instanceof Error ? err.message : String(err),
          );
        },
        { name: "recordFailure", retriesAllowed: true, maxAttempts: 3 },
      );
    } catch {
      // The bookkeeping write must never REPLACE the real failure. It fails when the app
      // DB is unreachable, and (harmlessly) when the workflow was cancelled — DBOS
      // rejects a `runStep` in a CANCELLED workflow before it records anything, so this
      // step cannot poison the function-ID sequence a later `resumeWorkflow` replays.
      // Swallow, and rethrow the cause below.
    }
    throw err;
  }
}

export const scaffoldProjectWorkflow = DBOS.registerWorkflow(scaffoldProjectFn, {
  name: SCAFFOLD_PROJECT_WORKFLOW_NAME,
});
