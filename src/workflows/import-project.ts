import { DBOS } from "@dbos-inc/dbos-sdk";
import {
  mintInstallationToken,
  type ImportProjectPayload,
} from "@supagloo/database-lib";
import { WORKFLOW_NAMES } from "../dbos/registry";
import { getAppDb } from "../db/app-db";
import { getScaffoldConfig } from "./scaffold-project/config";
import { markJobRunning, markStageDone } from "./scaffold-project/stages";
import { NotASupaglooProjectError, ManifestInvalidError } from "./import-project/errors";
import {
  isPermanentImportFailure,
  retryUnlessPermanentImport,
} from "./import-project/retry";
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
 * there is no deterministic-commit obligation (unlike scaffold). A permanent CONTENT
 * failure (`NotASupaglooProjectError` / `ManifestInvalidError`) is non-retryable and is
 * recorded onto the job (status=failed + the offending stage `failed` + error) — the
 * 12b "NOT A SUPAGLOO PROJECT" state. Registered STATICALLY at module load.
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

/** Map a permanent content failure to the stage whose state should show `failed`. */
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

  try {
    // 0) markJobRunning — flip queued → running (status only, not a stage).
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
    await boundary("cloneRepo");
    await DBOS.runStep(
      async () => {
        await ensureImportClone(ctx);
        await markStageDone(prisma, jobId, "cloneRepo");
      },
      { name: "cloneRepo", ...NETWORK_RETRY, shouldRetry: retryUnlessPermanentImport },
    );

    // 3) verifySupaglooProject — remotion.config.ts + >=1 vN.N.N branch (NON-RETRYABLE
    //    typed failure otherwise). Reads local refs — self-heals the clone first.
    await boundary("verifySupaglooProject");
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
    await boundary("resolveLatestVersionBranch");
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
    await boundary("parseManifest");
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
    await boundary("finalizeRecords");
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
    // Record a PERMANENT content failure onto the job so the poll surfaces the terminal
    // 12b stage state ("NOT A SUPAGLOO PROJECT" / invalid manifest). Transient failures
    // are left to DBOS retry/recovery; non-content permanent failures (git/HTTP) end the
    // workflow ERROR without a specific stage (scaffold parity). Re-thrown either way.
    if (isPermanentImportFailure(err)) {
      const failedStage = failedStageFor(err);
      if (failedStage) {
        await DBOS.runStep(
          async () => {
            await markJobFailed(prisma, jobId, failedStage, (err as Error).message);
          },
          { name: "recordFailure", retriesAllowed: true, maxAttempts: 3 },
        );
      }
    }
    throw err;
  }
}

export const importProjectWorkflow = DBOS.registerWorkflow(importProjectFn, {
  name: IMPORT_PROJECT_WORKFLOW_NAME,
});
