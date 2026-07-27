import { DBOS } from "@dbos-inc/dbos-sdk";
import {
  type CommitVersionPayload,
} from "@supagloo/database-lib";
import { WORKFLOW_NAMES } from "../dbos/registry";
import { getAppDb } from "../db/app-db";
import { getScaffoldConfig } from "./scaffold-project/config";
import {
  mintEncryptedInstallationToken,
  openInstallationToken,
} from "./shared/installation-token";
import { markJobFailed, markJobRunning, markStageDone } from "./scaffold-project/stages";
import { redactSecretsFromText } from "../logging/redact";
import { retryUnlessPermanent } from "./scaffold-project/retry";
import {
  commitBranch,
  ensureCommitClone,
  ensureManifestApplied,
  removeCommitWorkspace,
  type CommitContext,
} from "./commit-version/workspace";
import { updateCommitVersionRecord } from "./commit-version/finalize";

/**
 * `commitVersionWorkflow` (queue `git-ops`) — the third real git-ops workflow.
 *
 * Design-delta §7 workflow 3. Persists an EDITED manifest onto the project's CURRENT
 * working branch. Five steps, each a named `DBOS.runStep`, mirroring the job-stage log
 * row-for-row:
 *   mintInstallationToken → cloneBranchShallow → applyManifest → commitAndPush →
 *   updateVersionRecord.
 *
 * Crash-safety: the clone is EPHEMERAL, so every FS-touching step self-heals
 * (`ensureCommitClone`) first. The commit uses a REAL user message + current time (a
 * non-deterministic SHA — unlike scaffold), so idempotency rides a `Supagloo-Job-Id:
 * <jobId>` trailer: a replayed `commitAndPush` recognises its OWN prior push and never
 * double-commits (see `commit-version/workspace.ts`). Task 21 UPDATES the existing working
 * ProjectVersion in place (same semver, same branch) — no version bump, no branch change,
 * no PR. Registered STATICALLY at module load.
 */

export const COMMIT_VERSION_WORKFLOW_NAME = WORKFLOW_NAMES.commitVersion;

// Re-exported so importers of this module (e.g. the e2e) keep importing the enqueue
// payload type from here.
export type { CommitVersionPayload };

export interface CommitVersionResult {
  workflowId: string;
  projectId: string;
  /** Whether a NEW commit was pushed (false on a replay no-op or a no-change commit). */
  committed: boolean;
  version: {
    semver: string;
    branchName: string;
    headCommitSha: string;
  };
  changedFiles: string[];
}

/**
 * TEST-ONLY DI seam (undefined in production ⇒ a pure no-op). The workflow awaits this
 * hook at each step BOUNDARY so a test can park the workflow and drive a crash/replay.
 * Reading a module-level ref (never mutating one) is a DI read, not workflow state; the
 * hook never changes which steps run, so determinism is preserved.
 */
export type BoundaryHook = (label: string) => void | Promise<void>;
let boundaryHook: BoundaryHook | undefined;
export function __setCommitBoundaryHook(hook: BoundaryHook | undefined): void {
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

/**
 * Build the authenticated clone URL (`x-access-token:<token>@host/owner/repo.git`).
 * NOTE: this is the THIRD copy of this helper (scaffold-project.ts + import-project.ts
 * carry local copies). Worth extracting to a shared `scaffold-project/git.ts` in a future
 * cleanup; kept local here to avoid churning the other two workflows in this task.
 */
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

async function commitVersionFn(
  payload: CommitVersionPayload,
): Promise<CommitVersionResult> {
  const jobId = DBOS.workflowID;
  if (!jobId) {
    throw new Error("commitVersion: DBOS.workflowID unavailable inside the workflow");
  }
  const prisma = getAppDb();
  const cfg = getScaffoldConfig();

  // Which stage is in flight, for the terminal-failure record below (plan row 50 item 2 /
  // D50.4, copied from `scaffold-project.ts`). Free: `boundary(label)` already receives
  // EXACTLY the stage key at every step, so `at()` just remembers it on the way past. A
  // workflow-LOCAL variable (never module state), deterministically re-derived on replay,
  // and safe under the git-ops queue's worker_concurrency > 1.
  let currentStage = "markJobRunning";
  const at = async (label: string): Promise<void> => {
    currentStage = label;
    await boundary(label);
  };

  try {
    // 0) markJobRunning — flip queued → running (status only, not a stage).
    await at("markJobRunning");
    await DBOS.runStep(
      async () => {
        await markJobRunning(prisma, jobId);
      },
      { name: "markJobRunning" },
    );

    // 1) mintInstallationToken — App JWT → ~1h installation token (never persisted).
    await at("mintInstallationToken");
    // PLAN ROW 48: the step returns the token SEALED (AES-256-GCM), because a step's
    // return value is what DBOS checkpoints into `operation_outputs`. The body opens it
    // in memory; body locals are never checkpointed. Step name, step count and every
    // `functionID` are unchanged, so the `countStepExecutions === 1` durability proof and
    // the crash/replay step counts stand. See `shared/installation-token.ts`.
    const sealedToken = await DBOS.runStep(
      async () => {
        const sealed = await mintEncryptedInstallationToken({
          appId: cfg.githubAppId,
          privateKey: cfg.githubAppPrivateKey,
          installationId: payload.installationId,
          apiBaseUrl: cfg.githubApiBaseUrl,
        });
        await markStageDone(prisma, jobId, "mintInstallationToken");
        return sealed;
      },
      { name: "mintInstallationToken", ...NETWORK_RETRY },
    );
    const token = openInstallationToken(sealedToken);

    const ctx: CommitContext = {
      jobId,
      cloneUrl: authenticatedCloneUrl(
        cfg.githubGitBaseUrl,
        payload.repoOwner,
        payload.repoName,
        token,
      ),
      branchName: payload.branchName,
      manifest: payload.manifest,
      message: payload.message,
    };

    // 2) cloneBranchShallow — depth-2 clone of the working branch into the workspace.
    await at("cloneBranchShallow");
    await DBOS.runStep(
      async () => {
        await ensureCommitClone(ctx);
        await markStageDone(prisma, jobId, "cloneBranchShallow");
      },
      { name: "cloneBranchShallow", ...NETWORK_RETRY, shouldRetry: retryUnlessPermanent },
    );

    // 3) applyManifest — regenerate the manifest-derived sources (full overwrite). Self-
    //    heals the clone first so a fresh-worker replay rebuilds the tree.
    await at("applyManifest");
    await DBOS.runStep(
      async () => {
        await ensureManifestApplied(ctx);
        await markStageDone(prisma, jobId, "applyManifest");
      },
      { name: "applyManifest", ...NETWORK_RETRY, shouldRetry: retryUnlessPermanent },
    );

    // 4) commitAndPush — commit (real message + jobId trailer) + push, IDEMPOTENTLY. Self-
    //    heals (re-clone + re-apply) and recognises its own prior push, so a replay never
    //    double-commits. Returns the durable head + change set to record.
    await at("commitAndPush");
    const outcome = await DBOS.runStep(
      async () => {
        const outcome = await commitBranch(ctx);
        await markStageDone(prisma, jobId, "commitAndPush");
        return outcome;
      },
      { name: "commitAndPush", ...NETWORK_RETRY, shouldRetry: retryUnlessPermanent },
    );

    // 5) updateVersionRecord — update the working ProjectVersion in place + finish the job.
    await at("updateVersionRecord");
    await DBOS.runStep(
      async () => {
        await updateCommitVersionRecord(prisma, jobId, {
          projectId: payload.projectId,
          semver: payload.semver,
          branchName: payload.branchName,
          headCommitSha: outcome.headCommitSha,
          commitMessage: payload.message,
          changedFiles: outcome.changedFiles,
        });
        await removeCommitWorkspace(ctx);
      },
      { name: "updateVersionRecord", retriesAllowed: true, maxAttempts: 3 },
    );

    return {
      workflowId: jobId,
      projectId: payload.projectId,
      committed: outcome.committed,
      version: {
        semver: payload.semver,
        branchName: payload.branchName,
        headCommitSha: outcome.headCommitSha,
      },
      changedFiles: outcome.changedFiles,
    };
  } catch (err) {
    // Plan row 50 item (2). Until now this function had NO try/catch and no
    // `markJobFailed` at all, so a permanent failure — a revoked installation at step 1, a
    // push rejected by a branch-protection rule at `commitAndPush` — left
    // `ProjectJob.status` at `"running"` with every stage `pending` forever while DBOS
    // reported ERROR. The poller has no other source of truth (design-delta §5.1:741-746:
    // no HTTP between api and dbos), so the user-visible face of the defect is a studio
    // "Saving…" state that never resolves.
    //
    // UNGATED, exactly like scaffold's (row 63 / review finding DR4): the errors most
    // likely to be permanent here — db-lib's `GithubAppError` from step 1, a Zod/Prisma
    // error from `updateVersionRecord` — carry no git/HTTP type, so any classifier-gated
    // catch reproduces the very stuck job it was written to kill. Recording unconditionally
    // is not a guess about transience: by the time an error reaches this catch DBOS has
    // already spent that step's retry budget and CHECKPOINTED the error, so it re-throws on
    // every replay; and a crash — the case that IS recoverable — unwinds the process
    // instead of running this catch. `markJobFailed` refuses to overwrite an
    // already-`succeeded` job, which is what keeps the widened catch honest if
    // `updateVersionRecord`'s trailing `removeCommitWorkspace` ever throws after the
    // success write.
    try {
      await DBOS.runStep(
        async () => {
          await markJobFailed(
            prisma,
            jobId,
            currentStage,
            // Step-11 item 4 (R4850-3): this column is BROWSER-VISIBLE via
            // `GET /v1/projects/:id/jobs/:jobId`, and the widened catch above records every
            // escaping error class. `GitCommandError` self-redacts; `GithubAppError`, Prisma,
            // Zod and anything a library throws do NOT, and a clone/push failure surfaced
            // through one of those carries the full `x-access-token:ghs_…@github.com` remote.
            redactSecretsFromText(err instanceof Error ? err.message : String(err)),
          );
        },
        { name: "recordFailure", retriesAllowed: true, maxAttempts: 3 },
      );
    } catch {
      // The bookkeeping write must never REPLACE the real failure. It fails when the app DB
      // is unreachable, and (harmlessly) when the workflow was cancelled — DBOS rejects a
      // `runStep` in a CANCELLED workflow before it records anything, so this step cannot
      // poison the function-ID sequence a later `resumeWorkflow` replays.
    }
    throw err;
  }
}

export const commitVersionWorkflow = DBOS.registerWorkflow(commitVersionFn, {
  name: COMMIT_VERSION_WORKFLOW_NAME,
});
