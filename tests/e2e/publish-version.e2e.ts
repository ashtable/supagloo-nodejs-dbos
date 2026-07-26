import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DBOS, DBOSClient } from "@dbos-inc/dbos-sdk";
import { createPrismaClient } from "@supagloo/database-lib";
import { loadEnv, type Env } from "../../src/config/env";
import { launchDbos, shutdownDbos } from "../../src/dbos/runtime";
import { WORKFLOW_NAMES, WORKFLOW_QUEUE } from "../../src/dbos/registry";
import { initialPublishStages } from "../../src/workflows/publish-version/stages";
import {
  __setPublishBoundaryHook,
  type PublishVersionPayload,
  type PublishVersionResult,
} from "../../src/workflows/publish-version";
import { writeRemotionScaffold } from "../../src/remotion";
import { emptyManifest } from "../../src/remotion/__fixtures__/manifests";
import {
  authenticatedRemoteUrl,
  gitFixtureExec,
  githubReaders,
  provisionFixtureRepo,
  resolveGithubE2eContext,
  resolveGithubE2eSecrets,
  type FixtureRepo,
} from "../../src/testing/github-e2e";
import { countStepExecutions } from "../../src/testing/step-introspection";

// End-to-end proof of publishVersionWorkflow against **REAL GitHub**: api.github.com mints
// the installation token, opens + merges the PR, and creates the release tag; github.com
// serves a REAL authenticated clone/push. DBOS is launched IN-PROCESS (consuming the
// uncommitted db-lib via the file: dep). No mocks.
//
// Task 62 (design-delta §11) deleted the github-stub (:4801) + git-server (:4805). Each
// test provisions its own per-run PRIVATE repo
// (the shared e2e prefix + `publish-<case>` + the run id, `auto_init: true`), never torn down
// in-suite — reclaim with root's interactive `npm run cleanup:github-e2e` (archives, never
// deletes). A fresh fixture repo carries only GitHub's `auto_init` README, so a realistic
// WORKING BRANCH (a full Remotion scaffold on `main` + a `v0.0.1` branch) is built IN-TEST
// with the host git CLI + task-16 writeRemotionScaffold. Publish then merges v0.0.1 → main,
// tags v0.0.1, and cuts v0.0.2.
//
// Two proofs: (1) happy path — the PR is opened/merged, the release tag + next branch (v0.0.2)
// exist, and the ProjectVersion states flip (working 0.0.1 → published, new working 0.0.2);
// (2) crash/replay MID-MERGE — cancel at the mergePullRequestAndTag boundary (after
// openPullRequest checkpointed), delete the workspace (fresh worker), resume → completes with
// NO duplicate PR. Both proofs assert on TWO axes (D9): DBOS step counts for durability and
// real-github.com reads (`listPulls` with `state: "all"`, `listTagRefs`) for
// non-duplication — replacing the stub's single conflated `/__stub/calls` counter.

const BRANCH = "v0.0.1";
const SEMVER = "0.0.1";
const NEXT_BRANCH = "v0.0.2";
const NEXT_SEMVER = "0.0.2";

const HERMETIC_GIT = {
  GIT_TERMINAL_PROMPT: "0",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_AUTHOR_NAME: "Publish Fixture",
  GIT_AUTHOR_EMAIL: "fixture@supagloo.test",
  GIT_COMMITTER_NAME: "Publish Fixture",
  GIT_COMMITTER_EMAIL: "fixture@supagloo.test",
};

// Real GitHub App credentials from the root `.env` (loaded per-worker by
// `tests/e2e/load-root-env.ts`); fails fast by name if any is missing.
const githubSecrets = resolveGithubE2eSecrets();

const env: Env = loadEnv({
  DATABASE_URL:
    process.env.DATABASE_URL ?? "postgres://supagloo:supagloo@localhost:5432/supagloo",
  DBOS_DATABASE_URL:
    process.env.DBOS_DATABASE_URL ??
    "postgres://supagloo:supagloo@localhost:5432/supagloo_dbos",
  NODE_ENV: "test",
  // No GITHUB_*_BASE_URL override — the env schema already defaults to the real hosts
  // (finding F1: dbos was always real-by-default; only these specs pointed it at a stub).
  GITHUB_APP_ID: githubSecrets.appId,
  GITHUB_APP_PRIVATE_KEY: githubSecrets.privateKey,
  // Task #29 made SECRETS_ENCRYPTION_KEY required at boot (unused by this workflow).
  SECRETS_ENCRYPTION_KEY: "0".repeat(64),
  // Task #32 made the S3 (writer) vars required at boot (unused by this workflow).
  S3_ENDPOINT: "http://minio:9000",
  S3_BUCKET: "supagloo-dev",
  S3_ACCESS_KEY: "supagloo",
  S3_SECRET_KEY: "supagloo-dev",
});

const prisma = createPrismaClient({ connectionString: env.DATABASE_URL });
let client: DBOSClient;

/**
 * The installation token this file's fixture git operations authenticate with, minted once
 * in `beforeAll` through the PRODUCT path (db-lib `mintInstallationToken`). Fixture repos
 * are private, so the fixture clone/push needs it; the retired git-server needed none.
 */
let installationToken = "";

/** `https://x-access-token:<token>@github.com/<owner>/<repo>.git` for a fixture repo. */
function authRemote(fullName: string): string {
  const [owner, repo] = fullName.split("/");
  return authenticatedRemoteUrl({ token: installationToken, owner, repo });
}

/**
 * Fixture `git`, ALWAYS through the redacting seam. `authRemote()` embeds a live
 * installation token in an argv element, and `execFileSync` synthesises its rejection
 * message from argv (`Command failed: git clone <url>`) — so a raw call prints the
 * credential into the vitest failure report. `gitFixtureExec` scrubs URL userinfo out of
 * the message, stdout and stderr, and supplies the hermetic git env itself.
 */
function gitFixture(args: string[], cwd?: string): string {
  return gitFixtureExec(args, { cwd, env: HERMETIC_GIT });
}

/**
 * The edit that makes the working branch genuinely AHEAD of `main`. Kept in lockstep with
 * the `ProjectVersion` row `seedPublishProjectJob` writes below
 * (`changedFiles: ["M src/scenes/Shelter.tsx"]`, `commitMessage: "Edit the shelter scene"`),
 * so the git fixture and the DB fixture describe the same history.
 */
const WORKING_EDIT_PATH = "src/scenes/Shelter.tsx";
const WORKING_EDIT_MESSAGE = "Edit the shelter scene";

/** Build a REAL working branch on the origin: a full scaffold (empty manifest) on main +
 *  a `v0.0.1` branch carrying one commit of its own. */
async function seedWorkingBranch(fullName: string): Promise<void> {
  const work = mkdtempSync(join(tmpdir(), "publish-fixture-"));
  try {
    gitFixture(["clone", authRemote(fullName), work]);
    await writeRemotionScaffold(emptyManifest, work);
    gitFixture(["add", "-A"], work);
    gitFixture(["commit", "-m", "supagloo scaffold"], work);
    gitFixture(["push", "origin", "main"], work);

    // Cut the working branch and give it a REAL commit of its own. This is load-bearing
    // against REAL github.com: `POST /repos/{o}/{r}/pulls` 422s with "No commits between
    // main and v0.0.1" when the head ref is identical to base, and openPullRequest
    // deliberately does NOT swallow that 422 (only the duplicate-head one resolves to an
    // existing PR). The retired task-9 github-stub returned 201 unconditionally, so an
    // identical-SHA working branch went unnoticed until task 62 pointed this lane at the
    // real host. It is also the only realistic shape: publishing a branch with nothing to
    // publish is not a scenario the product can reach — scaffold cuts v0.0.1 from v0.0.0
    // and the user's edits land on it before publish runs.
    gitFixture(["checkout", "-b", BRANCH], work);
    mkdirSync(join(work, "src", "scenes"), { recursive: true });
    writeFileSync(
      join(work, WORKING_EDIT_PATH),
      `// ${WORKING_EDIT_MESSAGE}\nexport const Shelter = () => null;\n`,
    );
    gitFixture(["add", "-A"], work);
    gitFixture(["commit", "-m", WORKING_EDIT_MESSAGE], work);
    gitFixture(["push", "origin", BRANCH], work);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/** The origin's head SHA for `branch` (via ls-remote), or "" if the ref is absent. */
function branchHead(fullName: string, branch: string): string {
  const out = gitFixture([
    "ls-remote",
    "--heads",
    authRemote(fullName),
    `refs/heads/${branch}`,
  ]);
  return out.split(/\s+/)[0] ?? "";
}

async function seedPublishProjectJob(fixture: FixtureRepo): Promise<{
  projectId: string;
  jobId: string;
  payload: PublishVersionPayload;
}> {
  const github = await resolveGithubE2eContext();
  const suffix = randomUUID().slice(0, 8);
  const user = await prisma.user.create({
    data: {
      youversionUserId: `yv-publish-${suffix}`,
      displayName: "Publish E2E",
      email: `${suffix}@supagloo.test`,
      avatarInitials: "PE",
    },
  });
  const ownerId = user.id;
  const project = await prisma.project.create({
    data: {
      slug: `publish-${suffix}`,
      ownerId,
      name: "Publish E2E",
      repoOwner: fixture.owner,
      repoName: fixture.repo,
      repoVisibility: "private",
      createdFrom: "blank",
      currentBranch: BRANCH,
    },
  });
  // A scaffolded project carries a base (0.0.0) + a working (0.0.1) version. The highest
  // existing semver (0.0.1) is what the publish workflow bumps to 0.0.2.
  await prisma.projectVersion.create({
    data: {
      projectId: project.id,
      semver: "0.0.0",
      branchName: "v0.0.0",
      state: "base",
      changedFiles: [],
    },
  });
  await prisma.projectVersion.create({
    data: {
      projectId: project.id,
      semver: SEMVER,
      branchName: BRANCH,
      state: "working",
      commitMessage: "Edit the shelter scene",
      changedFiles: ["M src/scenes/Shelter.tsx"],
    },
  });
  const jobId = `publish-${project.id}-${suffix}`;
  await prisma.projectJob.create({
    data: {
      id: jobId,
      projectId: project.id,
      userId: ownerId,
      kind: "publish",
      status: "queued",
      stages: initialPublishStages(),
    },
  });
  const payload: PublishVersionPayload = {
    projectId: project.id,
    userId: ownerId,
    // DISCOVERED at runtime (D5) — never the fabricated `"42"` real GitHub 404s on.
    installationId: github.installationId,
    repoOwner: fixture.owner,
    repoName: fixture.repo,
    branchName: BRANCH,
    semver: SEMVER,
    message: "Publish the shelter cut",
  };
  return { projectId: project.id, jobId, payload };
}

async function waitForStatus(jobId: string, statuses: string[]): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const [wf] = await DBOS.listWorkflows({ workflowIDs: [jobId] });
    if (wf && statuses.includes(wf.status)) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`workflow ${jobId} did not reach ${statuses.join("/")} in time`);
}

beforeAll(async () => {
  installationToken = (await resolveGithubE2eContext()).token;
  await launchDbos(env);
  client = await DBOSClient.create({ systemDatabaseUrl: env.DBOS_DATABASE_URL });
}, 120_000);

afterAll(async () => {
  __setPublishBoundaryHook(undefined);
  await client?.destroy().catch(() => {});
  await shutdownDbos();
  await prisma.$disconnect().catch(() => {});
});

describe("publishVersionWorkflow — happy path", () => {
  it("merges + tags the working branch and cuts the next version branch, flipping the version states", async () => {
    const readers = await githubReaders();
    const fixture = await provisionFixtureRepo("publish-happy");
    await seedWorkingBranch(fixture.fullName);
    const { projectId, jobId, payload } = await seedPublishProjectJob(fixture);

    const handle = await client.enqueue<PublishVersionResult>(
      {
        workflowName: WORKFLOW_NAMES.publishVersion,
        queueName: WORKFLOW_QUEUE.publishVersion,
        workflowID: jobId,
      },
      payload,
    );
    const result = (await handle.getResult()) as PublishVersionResult;

    expect(result.workflowId).toBe(jobId);
    expect(result.published.semver).toBe(SEMVER);
    expect(result.published.branchName).toBe(BRANCH);
    expect(result.published.prNumber).toBeGreaterThan(0);
    expect(result.tag).toBe("refs/tags/v0.0.1");
    expect(result.next.semver).toBe(NEXT_SEMVER);
    expect(result.next.branchName).toBe(NEXT_BRANCH);

    // The next version branch exists on the origin, cut at a real commit.
    const nextHead = branchHead(fixture.fullName, NEXT_BRANCH);
    expect(nextHead).toMatch(/^[0-9a-f]{40}$/);
    expect(nextHead).toBe(result.next.headCommitSha);

    // (1) DURABILITY — each REST-touching step ran exactly once, attributed to THIS
    //     workflow id in the DBOS system DB.
    expect(await countStepExecutions(client, jobId, "mintInstallationToken")).toBe(1);
    expect(await countStepExecutions(client, jobId, "openPullRequest")).toBe(1);
    expect(await countStepExecutions(client, jobId, "mergePullRequestAndTag")).toBe(1);
    expect(await countStepExecutions(client, jobId, "cutNextVersionBranch")).toBe(1);
    // (2) NON-DUPLICATION — real GitHub holds exactly one MERGED pull request and exactly
    //     one release tag for this repo. `state: "all"` is mandatory: a merged PR is
    //     `closed`, so a state=open read would find nothing.
    const pulls = await readers.listPulls({ repo: fixture.repo });
    expect(pulls).toHaveLength(1);
    expect(pulls[0].merged_at).not.toBeNull();
    const tags = (await readers.listTagRefs({ repo: fixture.repo })) as Array<
      Record<string, unknown> | string
    >;
    const tagRefs = tags.map((t) => (typeof t === "string" ? t : String(t.ref)));
    expect(tagRefs.filter((r) => r === `refs/tags/v${SEMVER}`)).toHaveLength(1);

    // The version records flipped: working(0.0.1) → published; NEW working(0.0.2) created.
    const versions = await prisma.projectVersion.findMany({
      where: { projectId },
      orderBy: { semver: "asc" },
    });
    expect(versions.map((v) => v.semver).sort()).toEqual(["0.0.0", "0.0.1", "0.0.2"]);
    const published = versions.find((v) => v.semver === SEMVER)!;
    expect(published.state).toBe("published");
    expect(published.publishedAt).toBeInstanceOf(Date);
    expect(published.prNumber).toBeGreaterThan(0);
    expect(published.prUrl).toBeTruthy();
    expect(published.headCommitSha).toMatch(/^[0-9a-f]{40}$/);
    // The published version's own commit history (changedFiles) is preserved, not clobbered.
    expect(published.changedFiles as string[]).toEqual(["M src/scenes/Shelter.tsx"]);

    const nextVersion = versions.find((v) => v.semver === NEXT_SEMVER)!;
    expect(nextVersion.state).toBe("working");
    expect(nextVersion.branchName).toBe(NEXT_BRANCH);
    expect(nextVersion.headCommitSha).toBe(nextHead);

    // The Project advanced to the new working branch.
    const project = await prisma.project.findUniqueOrThrow({ where: { id: projectId } });
    expect(project.currentBranch).toBe(NEXT_BRANCH);

    // Job succeeded with every stage done.
    const job = await prisma.projectJob.findUniqueOrThrow({ where: { id: jobId } });
    expect(job.status).toBe("succeeded");
    const stages = job.stages as Array<{ state: string }>;
    expect(stages).toHaveLength(7);
    expect(stages.every((s) => s.state === "done")).toBe(true);
  }, 120_000);
});

describe("publishVersionWorkflow — crash / replay (mid-merge, no duplicate PR)", () => {
  it("cancels at the merge boundary, deletes the workspace, then resumes WITHOUT re-opening the PR", async () => {
    const readers = await githubReaders();
    const fixture = await provisionFixtureRepo("publish-replay");
    await seedWorkingBranch(fixture.fullName);
    const { projectId, jobId, payload } = await seedPublishProjectJob(fixture);

    // Park at the boundary just before mergePullRequestAndTag (after openPullRequest has
    // opened the PR + checkpointed), so the cancel lands mid-merge at a step boundary.
    let release!: () => void;
    const reached = new Promise<void>((resolve) => {
      __setPublishBoundaryHook(async (label) => {
        if (label === "mergePullRequestAndTag") {
          resolve();
          await new Promise<void>((r) => {
            release = r;
          });
        }
      });
    });

    const handle = await client.enqueue<PublishVersionResult>(
      {
        workflowName: WORKFLOW_NAMES.publishVersion,
        queueName: WORKFLOW_QUEUE.publishVersion,
        workflowID: jobId,
      },
      payload,
    );
    const settled = handle.getResult().then(
      () => "ok",
      () => "interrupted",
    );

    await reached;
    // The PR is already opened + checkpointed at this boundary; cancel preempts the merge.
    await DBOS.cancelWorkflow(jobId);
    // Simulate a fresh worker with no local FS.
    rmSync(join(tmpdir(), "supagloo-publish", jobId), { recursive: true, force: true });
    release();
    await settled;

    __setPublishBoundaryHook(undefined);
    await waitForStatus(jobId, ["CANCELLED", "ERROR"]);
    const resumeHandle = await DBOS.resumeWorkflow<PublishVersionResult>(jobId);
    const result = (await resumeHandle.getResult()) as PublishVersionResult;

    expect(result.workflowId).toBe(jobId);

    // The crux, on BOTH axes: openPullRequest was checkpointed on attempt 1 and skipped
    // on resume, and real GitHub holds exactly ONE pull request — no duplicate PR.
    expect(await countStepExecutions(client, jobId, "mintInstallationToken")).toBe(1);
    expect(await countStepExecutions(client, jobId, "openPullRequest")).toBe(1);
    const pulls = await readers.listPulls({ repo: fixture.repo });
    expect(pulls).toHaveLength(1);
    expect(pulls[0].merged_at).not.toBeNull();
    // Exactly one release tag survived the replayed `createTag` — its 422
    // "Reference already exists" branch is no longer production-only (task 62 D18-4).
    const tags = (await readers.listTagRefs({ repo: fixture.repo })) as Array<
      Record<string, unknown> | string
    >;
    const tagRefs = tags.map((t) => (typeof t === "string" ? t : String(t.ref)));
    expect(tagRefs.filter((r) => r === `refs/tags/v${SEMVER}`)).toHaveLength(1);

    // The publish completed: next branch exists, versions flipped, project advanced.
    expect(branchHead(fixture.fullName, NEXT_BRANCH)).toMatch(/^[0-9a-f]{40}$/);
    const versions = await prisma.projectVersion.findMany({ where: { projectId } });
    expect(versions.find((v) => v.semver === SEMVER)!.state).toBe("published");
    expect(versions.find((v) => v.semver === NEXT_SEMVER)!.state).toBe("working");
    const project = await prisma.project.findUniqueOrThrow({ where: { id: projectId } });
    expect(project.currentBranch).toBe(NEXT_BRANCH);
    const job = await prisma.projectJob.findUniqueOrThrow({ where: { id: jobId } });
    expect(job.status).toBe("succeeded");
  }, 150_000);
});
