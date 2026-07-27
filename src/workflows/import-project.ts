import { DBOS } from "@dbos-inc/dbos-sdk";
import { type ImportProjectPayload } from "@supagloo/database-lib";
import { WORKFLOW_NAMES } from "../dbos/registry";
import { getAppDb } from "../db/app-db";
import { getScaffoldConfig } from "./scaffold-project/config";
import {
  mintEncryptedInstallationToken,
  openInstallationToken,
} from "./shared/installation-token";
import { markJobRunning, markStageDone } from "./scaffold-project/stages";
import { NotASupaglooProjectError, ManifestInvalidError } from "./import-project/errors";
// `isPermanentImportFailure` is deliberately NOT imported any more: plan row 50 item (2)
// removed it from the terminal-failure catch (it was the outer half of the double gate).
// It remains the classifier behind `retryUnlessPermanentImport`, which is where a
// permanent-vs-transient judgement actually belongs — the DBOS step's retry decision.
import { retryUnlessPermanentImport } from "./import-project/retry";
import {
  checkoutVersionBranch,
  ensureImportClone,
  hasRemotionConfig,
  listRemoteBranchNames,
  removeImportWorkspace,
  type ImportContext,
} from "./import-project/workspace";
import { verifySupaglooProject } from "./import-project/verify";
import { resolveLatestVersionBranch } from "./import-project/versions";
import { parseManifestFile } from "./import-project/manifest";
import { markJobFailed } from "./import-project/stages";
import { finalizeImportRecords } from "./import-project/finalize";

/**
 * `importProjectWorkflow` (queue `git-ops`) — the second real git-ops workflow.
 *
 * Design-delta §7 workflow 2. Imports an EXISTING Supagloo repo (no repo creation, no
 * JIT user-token hop — the installation token reaches it). Six steps, each a named
 * `DBOS.runStep`, mirroring the job-stage log row-for-row:
 *   mintInstallationToken → cloneRepo → verifySupaglooProject →
 *   resolveLatestVersionBranch → parseManifest → finalizeRecords.
 *
 * Crash-safety: the clone is EPHEMERAL, so every FS-touching step calls
 * `ensureImportClone` first (reuse-or-reclone) — import is read-only on the remote, so
 * there is no deterministic-commit obligation (unlike scaffold). EVERY escaping error is
 * recorded onto the job (status=failed + a stage `failed` + the message); the two
 * permanent CONTENT failures (`NotASupaglooProjectError` / `ManifestInvalidError`) are
 * additionally non-retryable and name their own stage — the 12b "NOT A SUPAGLOO PROJECT"
 * state. Registered STATICALLY at module load.
 */

export const IMPORT_PROJECT_WORKFLOW_NAME = WORKFLOW_NAMES.importProject;

// Re-exported so importers of this module (e.g. the e2e) keep importing the enqueue
// payload type from here.
export type { ImportProjectPayload };

export interface ImportProjectResult {
  workflowId: string;
  projectId: string;
  version: {
    semver: string;
    branchName: string;
    headCommitSha: string;
  };
}

/**
 * TEST-ONLY DI seam (undefined in production ⇒ a pure no-op). The workflow awaits this
 * hook at each step BOUNDARY so a test can park the workflow and drive a crash/replay.
 * Reading a module-level ref (never mutating one) is a DI read, not workflow state; the
 * hook never changes which steps run, so determinism is preserved.
 */
export type BoundaryHook = (label: string) => void | Promise<void>;
let boundaryHook: BoundaryHook | undefined;
export function __setImportBoundaryHook(hook: BoundaryHook | undefined): void {
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

/**
 * Map a permanent CONTENT failure to the stage whose state should show `failed`.
 *
 * Plan row 50 item (2) / D50.3: this is now the PREFERRED stage key, not a gate. It used
 * to be half of a double gate (`isPermanentImportFailure(err)` AND a non-null return
 * here), which meant a failure was recorded for exactly these two error types and NOTHING
 * was written for every other class. It survives because these two mappings are
 * load-bearing for wireframe 12b's terminal "NOT A SUPAGLOO PROJECT" / invalid-manifest
 * stage state: the offending stage is not necessarily the one in flight (verification
 * fails inside the `verifySupaglooProject` step, but a manifest error can surface from a
 * step whose own label is less specific).
 */
function failedStageFor(err: unknown): string | null {
  if (err instanceof NotASupaglooProjectError) return "verifySupaglooProject";
  if (err instanceof ManifestInvalidError) return "parseManifest";
  return null;
}

async function importProjectFn(
  payload: ImportProjectPayload,
): Promise<ImportProjectResult> {
  const jobId = DBOS.workflowID;
  if (!jobId) {
    throw new Error("importProject: DBOS.workflowID unavailable inside the workflow");
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

    const ctx: ImportContext = {
      jobId,
      cloneUrl: authenticatedCloneUrl(
        cfg.githubGitBaseUrl,
        payload.repoOwner,
        payload.repoName,
        token,
      ),
    };

    // 2) cloneRepo — clone the existing repo into the ephemeral workspace.
    await at("cloneRepo");
    await DBOS.runStep(
      async () => {
        await ensureImportClone(ctx);
        await markStageDone(prisma, jobId, "cloneRepo");
      },
      { name: "cloneRepo", ...NETWORK_RETRY, shouldRetry: retryUnlessPermanentImport },
    );

    // 3) verifySupaglooProject — remotion.config.ts + >=1 vN.N.N branch (NON-RETRYABLE
    //    typed failure otherwise). Reads local refs — self-heals the clone first.
    await at("verifySupaglooProject");
    const branches = await DBOS.runStep(
      async () => {
        const path = await ensureImportClone(ctx);
        const branches = await listRemoteBranchNames(path);
        verifySupaglooProject({
          hasRemotionConfig: hasRemotionConfig(path),
          branches,
        });
        await markStageDone(prisma, jobId, "verifySupaglooProject");
        return branches;
      },
      {
        name: "verifySupaglooProject",
        ...NETWORK_RETRY,
        shouldRetry: retryUnlessPermanentImport,
      },
    );

    // 4) resolveLatestVersionBranch — highest vN.N.N by REAL semver compare.
    await at("resolveLatestVersionBranch");
    const resolved = await DBOS.runStep(
      async () => {
        const resolved = resolveLatestVersionBranch(branches);
        await markStageDone(prisma, jobId, "resolveLatestVersionBranch");
        return resolved;
      },
      { name: "resolveLatestVersionBranch" },
    );

    // 5) parseManifest — checkout the resolved version branch, validate its manifest
    //    (NON-RETRYABLE typed failure otherwise). Self-heals the clone first.
    await at("parseManifest");
    const headCommitSha = await DBOS.runStep(
      async () => {
        const path = await ensureImportClone(ctx);
        const sha = await checkoutVersionBranch(path, resolved.branchName);
        await parseManifestFile(path); // validation gate
        await markStageDone(prisma, jobId, "parseManifest");
        return sha;
      },
      { name: "parseManifest", ...NETWORK_RETRY, shouldRetry: retryUnlessPermanentImport },
    );

    // 6) finalizeRecords — Project + ONE ProjectVersion(working) + job stages/status.
    await at("finalizeRecords");
    await DBOS.runStep(
      async () => {
        await finalizeImportRecords(prisma, jobId, {
          projectId: payload.projectId,
          repoOwner: payload.repoOwner,
          repoName: payload.repoName,
          repoVisibility: payload.repoVisibility,
          version: {
            semver: resolved.semver,
            branchName: resolved.branchName,
            headCommitSha,
          },
        });
        await removeImportWorkspace(ctx);
      },
      { name: "finalizeRecords", retriesAllowed: true, maxAttempts: 3 },
    );

    return {
      workflowId: jobId,
      projectId: payload.projectId,
      version: {
        semver: resolved.semver,
        branchName: resolved.branchName,
        headCommitSha,
      },
    };
  } catch (err) {
    // Plan row 50 item (2) / D50.3 — this catch is now UNGATED, matching scaffold's.
    //
    // It used to be DOUBLY gated: `isPermanentImportFailure(err)` AND a non-null
    // `failedStageFor(err)`, which answers for exactly `NotASupaglooProjectError` and
    // `ManifestInvalidError`. Everything else — db-lib's `GithubAppError` from step 1
    // `mintInstallationToken`, a `GitCommandError` from the clone, a Prisma/Zod error from
    // `finalizeRecords` — escaped with NOTHING written, leaving `ProjectJob.status` at
    // `"running"` with every stage `pending` forever while DBOS reported ERROR. That is the
    // eternal wizard spinner row 63 killed in scaffold, still fully alive here for every
    // class but two. (plan.md row 50's parenthetical "importProjectWorkflow already did"
    // is wrong, and contradicts its own Notes column, which says task 19's catch "only
    // narrowly covers two content-classification errors".)
    //
    // The typed content mappings are PRESERVED as the preferred stage key — wireframe 12b's
    // terminal "NOT A SUPAGLOO PROJECT" state depends on the offending stage being
    // `verifySupaglooProject` rather than merely whichever step was in flight — and
    // `currentStage` is the fallback for everything else.
    //
    // Recording unconditionally is not a guess about transience: by the time an error
    // reaches this catch DBOS has already spent that step's retry budget and CHECKPOINTED
    // the error, so it re-throws on every replay; a crash — the case that IS recoverable —
    // unwinds the process instead of running this catch. `markJobFailed` refuses to
    // overwrite an already-`succeeded` job, which is what keeps the widened catch honest if
    // `finalizeRecords`' trailing `removeImportWorkspace` ever throws after the success
    // write.
    try {
      await DBOS.runStep(
        async () => {
          await markJobFailed(
            prisma,
            jobId,
            failedStageFor(err) ?? currentStage,
            err instanceof Error ? err.message : String(err),
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

export const importProjectWorkflow = DBOS.registerWorkflow(importProjectFn, {
  name: IMPORT_PROJECT_WORKFLOW_NAME,
});
