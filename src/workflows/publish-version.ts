import { DBOS } from "@dbos-inc/dbos-sdk";
import {
  mintInstallationToken,
  nextPatchVersion,
  type PublishVersionPayload,
} from "@supagloo/database-lib";
import { WORKFLOW_NAMES } from "../dbos/registry";
import { getAppDb } from "../db/app-db";
import { getScaffoldConfig } from "./scaffold-project/config";
import { markJobFailed, markJobRunning, markStageDone } from "./scaffold-project/stages";
import { retryUnlessPermanent } from "./scaffold-project/retry";
import {
  mergePullRequest,
  openPullRequest,
} from "./scaffold-project/github-rest";
import { createTag } from "./publish-version/github-rest";
import {
  capturePublishHead,
  cutNextBranch,
  pushWorkingBranch,
  removePublishWorkspace,
  type PublishContext,
} from "./publish-version/workspace";
import { finalizePublishRecords } from "./publish-version/finalize";

/**
 * `publishVersionWorkflow` (queue `git-ops`) — the fourth (final) git-ops workflow.
 *
 * Design-delta §7 workflow 4. Publishes the project's CURRENT working version: merges its
 * branch to `main`, tags the release, and cuts the NEXT working branch. Seven steps, each a
 * named `DBOS.runStep`, mirroring the 14a publishing-log stages row-for-row:
 *   mintInstallationToken → commitPendingChanges → pushBranch → openPullRequest →
 *   mergePullRequestAndTag → cutNextVersionBranch → finalizeRecords.
 *
 * Versioning model (design-delta §7 workflow 4 + the finalize semantics): the CURRENT
 * working version (`payload.semver`, e.g. 0.0.1) IS the version being published — merge it,
 * tag `v0.0.1`, flip it `working → published`. The NEXT working version = the PATCH bump of
 * the HIGHEST existing semver (`nextPatchVersion`), so 0.0.1 → 0.0.2 (and for an imported
 * project, highest 0.2.3 → 0.2.4). NOT a hardcoded `v0.0.(n+1)`, which breaks for imported
 * free-form semver. `main` always holds the latest published version; the user edits one
 * version ahead.
 *
 * Crash-safety: the clone is EPHEMERAL, so every FS-touching step self-heals. Publish makes
 * NO new commit (no manifest ⇒ nothing to commit), so — unlike commit — there is no
 * jobId-trailer: `commitPendingChanges` is a head-capture. The REST side effects are
 * at-least-once safe: `openPullRequest` (422→lookup) + `mergePullRequest` (405→already-merged)
 * are reused from scaffold; `createTag` treats 422-already-exists as idempotent. Registered
 * STATICALLY at module load.
 */

export const PUBLISH_VERSION_WORKFLOW_NAME = WORKFLOW_NAMES.publishVersion;

// Re-exported so importers of this module (e.g. the e2e) keep importing the enqueue payload
// type from here.
export type { PublishVersionPayload };

export interface PublishVersionResult {
  workflowId: string;
  projectId: string;
  /** The version that was published (the former working version). */
  published: {
    semver: string;
    branchName: string;
    /** The merge commit sha on `main`. */
    headCommitSha: string;
    prNumber: number;
    prUrl: string;
  };
  /** The created release tag ref (`refs/tags/v<publishedSemver>`). */
  tag: string;
  /** The new working version, cut from `main` at the bumped semver. */
  next: {
    semver: string;
    branchName: string;
    headCommitSha: string;
  };
}

/**
 * TEST-ONLY DI seam (undefined in production ⇒ a pure no-op). The workflow awaits this hook
 * at each step BOUNDARY so a test can park the workflow and drive a crash/replay. Reading a
 * module-level ref (never mutating one) is a DI read, not workflow state; the hook never
 * changes which steps run, so determinism is preserved.
 */
export type BoundaryHook = (label: string) => void | Promise<void>;
let boundaryHook: BoundaryHook | undefined;
export function __setPublishBoundaryHook(hook: BoundaryHook | undefined): void {
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

const BASE_BRANCH = "main";

/**
 * Build the authenticated clone URL (`x-access-token:<token>@host/owner/repo.git`).
 * NOTE: this is the FOURTH copy of this helper (scaffold/import/commit carry local copies).
 * Worth extracting to a shared `scaffold-project/git.ts` in a future cleanup; kept local here
 * to avoid churning the other three workflows in this task.
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

async function publishVersionFn(
  payload: PublishVersionPayload,
): Promise<PublishVersionResult> {
  const jobId = DBOS.workflowID;
  if (!jobId) {
    throw new Error("publishVersion: DBOS.workflowID unavailable inside the workflow");
  }
  const prisma = getAppDb();
  const cfg = getScaffoldConfig();
  const rest = (token: string) => ({ apiBaseUrl: cfg.githubApiBaseUrl, token });

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

    const ctx: PublishContext = {
      jobId,
      cloneUrl: authenticatedCloneUrl(
        cfg.githubGitBaseUrl,
        payload.repoOwner,
        payload.repoName,
        token,
      ),
      branchName: payload.branchName,
      semver: payload.semver,
      message: payload.message,
    };

    // 2) commitPendingChanges — clone the working branch + capture its head to publish. Publish
    //    carries no manifest, so this is a head-capture (nothing to commit); the working
    //    manifest was already committed via prior commitVersionWorkflow calls. The captured
    //    head is CHECKPOINTED but no longer read: plan row 50 item (1) deleted the
    //    `?? workingHead` merge-sha fallback that was its only consumer.
    await at("commitPendingChanges");
    await DBOS.runStep(
      async () => {
        const { headCommitSha } = await capturePublishHead(ctx);
        await markStageDone(prisma, jobId, "commitPendingChanges");
        return headCommitSha;
      },
      { name: "commitPendingChanges", ...NETWORK_RETRY, shouldRetry: retryUnlessPermanent },
    );

    // 3) pushBranch — ensure the working branch is on origin (no-op if already current).
    await at("pushBranch");
    await DBOS.runStep(
      async () => {
        await pushWorkingBranch(ctx);
        await markStageDone(prisma, jobId, "pushBranch");
      },
      { name: "pushBranch", ...NETWORK_RETRY, shouldRetry: retryUnlessPermanent },
    );

    // 4) openPullRequest — open the release PR (working branch → main). Idempotent (422→lookup).
    await at("openPullRequest");
    const pr = await DBOS.runStep(
      async () => {
        const opened = await openPullRequest(rest(token), {
          owner: payload.repoOwner,
          repo: payload.repoName,
          head: payload.branchName,
          base: BASE_BRANCH,
          title: `Publish ${payload.branchName}`,
          body: payload.message,
        });
        await markStageDone(prisma, jobId, "openPullRequest");
        return opened;
      },
      { name: "openPullRequest", ...NETWORK_RETRY, shouldRetry: retryUnlessPermanent },
    );

    // 5) mergePullRequestAndTag — squash-merge the PR into main, then tag the release at the
    //    merge sha. Both idempotent (405-already-merged / 422-tag-exists) for step retries.
    await at("mergePullRequestAndTag");
    const merge = await DBOS.runStep(
      async () => {
        const merged = await mergePullRequest(rest(token), {
          owner: payload.repoOwner,
          repo: payload.repoName,
          number: pr.number,
        });
        // The merge sha (published head). Plan row 50 item (1): this used to be
        // `merged.sha ?? workingHead`, a deliberate mirror of scaffold's `?? baseSha` — and
        // the mirror propagated the bug rather than the fix. `workingHead` is the PRE-merge
        // branch tip, which a squash merge never produces, and this value is double-damage:
        // it is the release TAG's target and the permanently stored
        // `ProjectVersion.headCommitSha`. `mergePullRequest` now re-reads the true merge
        // commit on the 405 path (D50.1) and throws rather than guess (D50.2).
        const mergeSha = merged.sha;
        const tag = await createTag(rest(token), {
          owner: payload.repoOwner,
          repo: payload.repoName,
          semver: payload.semver,
          sha: mergeSha,
        });
        await markStageDone(prisma, jobId, "mergePullRequestAndTag");
        return { mergeSha, tag: tag.ref };
      },
      { name: "mergePullRequestAndTag", ...NETWORK_RETRY, shouldRetry: retryUnlessPermanent },
    );

    // 6) cutNextVersionBranch — bump the patch of the highest existing semver, cut that branch
    //    from main, and push it. The next semver is derived from the project's versions in the
    //    DB (deterministic on replay: finalize, which adds the next version, runs AFTER this).
    await at("cutNextVersionBranch");
    const next = await DBOS.runStep(
      async () => {
        const existing = await prisma.projectVersion.findMany({
          where: { projectId: payload.projectId },
          select: { semver: true },
        });
        const nextSemver = nextPatchVersion(existing.map((v) => v.semver));
        const nextBranch = `v${nextSemver}`;
        const { headCommitSha } = await cutNextBranch(ctx, nextBranch);
        await markStageDone(prisma, jobId, "cutNextVersionBranch");
        return { semver: nextSemver, branchName: nextBranch, headCommitSha };
      },
      { name: "cutNextVersionBranch", ...NETWORK_RETRY, shouldRetry: retryUnlessPermanent },
    );

    // 7) finalizeRecords — flip the working version → published, upsert the new working version,
    //    advance the Project, finish the job.
    await at("finalizeRecords");
    await DBOS.runStep(
      async () => {
        await finalizePublishRecords(prisma, jobId, {
          projectId: payload.projectId,
          published: {
            semver: payload.semver,
            branchName: payload.branchName,
            headCommitSha: merge.mergeSha,
            prNumber: pr.number,
            prUrl: pr.url,
          },
          next: {
            semver: next.semver,
            branchName: next.branchName,
            headCommitSha: next.headCommitSha,
          },
        });
        await removePublishWorkspace(ctx);
      },
      { name: "finalizeRecords", retriesAllowed: true, maxAttempts: 3 },
    );

    return {
      workflowId: jobId,
      projectId: payload.projectId,
      published: {
        semver: payload.semver,
        branchName: payload.branchName,
        headCommitSha: merge.mergeSha,
        prNumber: pr.number,
        prUrl: pr.url,
      },
      tag: merge.tag,
      next: {
        semver: next.semver,
        branchName: next.branchName,
        headCommitSha: next.headCommitSha,
      },
    };
  } catch (err) {
    // Plan row 50 item (2). Until now this function had NO try/catch and no
    // `markJobFailed` at all, so a permanent failure — a 422 "No commits between" from
    // `openPullRequest` being the realistic one — left `ProjectJob.status` at `"running"`
    // with every stage `pending` forever while DBOS reported ERROR. The poller has no other
    // source of truth (design-delta §5.1:741-746: no HTTP between api and dbos), so the
    // user-visible face of the defect is an eternal spinner.
    //
    // UNGATED, exactly like scaffold's (row 63 / review finding DR4): the errors most
    // likely to be permanent here — db-lib's `GithubAppError` from step 1, a Zod/Prisma
    // error from `finalizeRecords` — carry no git/HTTP type, so any classifier-gated catch
    // reproduces the very spinner it was written to kill. Recording unconditionally is not
    // a guess about transience: by the time an error reaches this catch DBOS has already
    // spent that step's retry budget and CHECKPOINTED the error, so it re-throws on every
    // replay; and a crash — the case that IS recoverable — unwinds the process instead of
    // running this catch. `markJobFailed` refuses to overwrite an already-`succeeded` job,
    // which is what keeps the widened catch honest if `finalizeRecords`' trailing
    // `removePublishWorkspace` ever throws after the success write.
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
      // The bookkeeping write must never REPLACE the real failure. It fails when the app DB
      // is unreachable, and (harmlessly) when the workflow was cancelled — DBOS rejects a
      // `runStep` in a CANCELLED workflow before it records anything, so this step cannot
      // poison the function-ID sequence a later `resumeWorkflow` replays.
    }
    throw err;
  }
}

export const publishVersionWorkflow = DBOS.registerWorkflow(publishVersionFn, {
  name: PUBLISH_VERSION_WORKFLOW_NAME,
});
