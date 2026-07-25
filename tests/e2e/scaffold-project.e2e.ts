import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DBOS, DBOSClient } from "@dbos-inc/dbos-sdk";
import { createPrismaClient } from "@supagloo/database-lib";
import { loadEnv, type Env } from "../../src/config/env";
import { launchDbos, shutdownDbos } from "../../src/dbos/runtime";
import { WORKFLOW_NAMES, WORKFLOW_QUEUE } from "../../src/dbos/registry";
import { initialStages } from "../../src/workflows/scaffold-project/stages";
import {
  __setBoundaryHook,
  type ScaffoldProjectPayload,
  type ScaffoldProjectResult,
} from "../../src/workflows/scaffold-project";
import { emptyManifest } from "../../src/remotion/__fixtures__/manifests";
import {
  authenticatedRemoteUrl,
  githubReaders,
  provisionFixtureRepo,
  resolveGithubE2eContext,
  resolveGithubE2eSecrets,
  type FixtureRepo,
} from "../../src/testing/github-e2e";
import { countStepExecutions } from "../../src/testing/step-introspection";

// End-to-end proof of scaffoldProjectWorkflow against **REAL GitHub**: api.github.com
// mints the installation token (from the real App's PEM, via a runtime-DISCOVERED
// installation) and opens & merges the base PR, and github.com serves a REAL
// clone/commit/push/branch cycle over authenticated HTTPS. The DBOS runtime is launched
// IN-PROCESS (so it consumes the uncommitted db-lib via the file: dep — the containerized
// worker can't, per the in-flight-dblib-e2e constraint). The workflow shells out to the
// host `git` CLI. No mocks.
//
// Task 62 (design-delta §11) retired the github-stub (:4801) + git-server (:4805) that
// used to back this spec. Consequences that shape the code below:
//
//   • Each test provisions its OWN per-run repo,
//     the shared e2e prefix + `scaffold-<case>` + the run id — private, `auto_init: true` (a
//     commit-less repo has no `main`, and the base PR opens with `base: "main"`, which
//     real GitHub 422s). Per-run names are MANDATORY, not tidiness: the v0.0.0 commit is
//     byte-deterministic by design, so a REUSED repo rejects a second run.
//   • Nothing is torn down, ever — not even on success (D6). Reclaim the repos with
//     root's interactive `npm run cleanup:github-e2e`, which ARCHIVES (never deletes)
//     after confirming each name.
//   • The stub's `/__stub/calls` counters are replaced by TWO strictly stronger,
//     independent proofs: DBOS system-DB step counts (durability — one StepInfo row per
//     functionID, so an internal retry or a replayed resume cannot inflate it) AND real
//     github.com artifact reads (non-duplication, observed on the host that actually
//     holds the side effect). The stub conflated the two and could not attribute a call
//     to a workflow at all.
//
// Two proofs: (1) happy path enqueue → completion (branches, PR, DB rows);
// (2) crash/replay — cancel the workflow mid-run at the boundary before the base-PR
// push, delete the ephemeral workspace (simulating a fresh worker), then RESUME →
// it completes exactly once.

// Real GitHub App credentials from the root `.env` (loaded into this worker by
// `tests/e2e/load-root-env.ts`); fails fast by name if any is missing. The old generated
// throwaway keypair + `appId: "123456"` could only ever have satisfied a stub.
const githubSecrets = resolveGithubE2eSecrets();

const env: Env = loadEnv({
  DATABASE_URL:
    process.env.DATABASE_URL ?? "postgres://supagloo:supagloo@localhost:5432/supagloo",
  DBOS_DATABASE_URL:
    process.env.DBOS_DATABASE_URL ??
    "postgres://supagloo:supagloo@localhost:5432/supagloo_dbos",
  NODE_ENV: "test",
  // NO GITHUB_API_BASE_URL / GITHUB_GIT_BASE_URL override: `src/config/env.ts` already
  // defaults them to https://api.github.com and https://github.com. Real-by-default is
  // achieved by NOT overriding them (finding F1 — the worker was always real; only these
  // specs pointed it at the stub).
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
 * Head refs on the origin, via a real `git ls-remote` against **github.com**.
 *
 * The fixture repos are private, so this needs the installation token in the remote URL
 * (the retired git-server needed no credential). `stdio: "pipe"` keeps the URL — which
 * contains a live token — out of the test output on failure; the thrown error's message
 * is a git message, not the URL.
 */
function remoteHeads(fixture: FixtureRepo, token: string): string[] {
  const out = execFileSync(
    "git",
    [
      "ls-remote",
      "--heads",
      authenticatedRemoteUrl({ token, owner: fixture.owner, repo: fixture.repo }),
    ],
    { env: { ...process.env, GIT_TERMINAL_PROMPT: "0" }, stdio: ["ignore", "pipe", "pipe"] },
  ).toString();
  return out
    .split("\n")
    .filter(Boolean)
    .map((line) => line.split(/\s+/)[1]);
}

async function seedProjectJob(fixture: FixtureRepo): Promise<{
  projectId: string;
  jobId: string;
  payload: ScaffoldProjectPayload;
}> {
  const github = await resolveGithubE2eContext();
  const suffix = randomUUID().slice(0, 8);
  // Project.ownerId + ProjectJob.userId are FKs to User — seed one first.
  const user = await prisma.user.create({
    data: {
      youversionUserId: `yv-${suffix}`,
      displayName: "Scaffold E2E",
      email: `${suffix}@supagloo.test`,
      avatarInitials: "SE",
    },
  });
  const ownerId = user.id;
  const project = await prisma.project.create({
    data: {
      slug: `scaffold-${suffix}`,
      ownerId,
      name: "Scaffold E2E",
      repoOwner: fixture.owner,
      repoName: fixture.repo,
      repoVisibility: "private",
      createdFrom: "blank",
      currentBranch: "main",
    },
  });
  const jobId = `scaffold-${project.id}-${suffix}`;
  await prisma.projectJob.create({
    data: {
      id: jobId,
      projectId: project.id,
      userId: ownerId,
      kind: "scaffold",
      status: "queued",
      stages: initialStages(),
    },
  });
  const payload: ScaffoldProjectPayload = {
    projectId: project.id,
    userId: ownerId,
    ownerId,
    // DISCOVERED at runtime (D5). The fabricated `"42"` this used to pass is precisely
    // why real GitHub 404'd `POST /app/installations/42/access_tokens` — plan row 62
    // item (d), which was never a stub-routing bug at all.
    installationId: github.installationId,
    repoOwner: fixture.owner,
    repoName: fixture.repo,
    repoVisibility: "private",
    createdFrom: "blank",
    slug: project.slug,
    name: project.name,
    manifest: emptyManifest,
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
  await launchDbos(env);
  client = await DBOSClient.create({ systemDatabaseUrl: env.DBOS_DATABASE_URL });
}, 120_000);

afterAll(async () => {
  __setBoundaryHook(undefined);
  await client?.destroy().catch(() => {});
  await shutdownDbos();
  await prisma.$disconnect().catch(() => {});
});

describe("scaffoldProjectWorkflow — happy path", () => {
  it("scaffolds a pre-existing repo end to end: v0.0.0/v0.0.1 branches, merged base PR, finalized records", async () => {
    const github = await resolveGithubE2eContext();
    const readers = await githubReaders();
    const fixture = await provisionFixtureRepo("scaffold-happy");
    const { projectId, jobId, payload } = await seedProjectJob(fixture);

    const handle = await client.enqueue<ScaffoldProjectResult>(
      {
        workflowName: WORKFLOW_NAMES.scaffoldProject,
        queueName: WORKFLOW_QUEUE.scaffoldProject,
        workflowID: jobId,
      },
      payload,
    );
    const result = (await handle.getResult()) as ScaffoldProjectResult;

    expect(result.workflowId).toBe(jobId);
    expect(result.baseVersion.branchName).toBe("v0.0.0");
    expect(result.workingVersion.branchName).toBe("v0.0.1");
    expect(result.baseVersion.prNumber).toBeGreaterThan(0);

    // Real branches on the real origin, read back with a real `git ls-remote`.
    const heads = remoteHeads(fixture, github.token);
    expect(heads).toContain("refs/heads/v0.0.0");
    expect(heads).toContain("refs/heads/v0.0.1");

    // Exactly-once, proven along TWO independent axes (D9) instead of the stub's single
    // conflated counter.
    //
    // (1) DURABILITY — DBOS system-DB step counts, attributed to THIS workflow id. One
    //     StepInfo row per functionID, so neither an internal `retriesAllowed` retry nor
    //     a replayed resume can inflate them.
    expect(await countStepExecutions(client, jobId, "mintInstallationToken")).toBe(1);
    expect(await countStepExecutions(client, jobId, "pushOpenMergeBasePr")).toBe(1);
    // (2) NON-DUPLICATION — the side effect as REAL GitHub holds it. `state: "all"` is
    //     mandatory: a merged PR is `closed`, so a state=open read would report zero PRs
    //     for a successfully scaffolded repo.
    const pulls = await readers.listPulls({ repo: fixture.repo });
    expect(pulls).toHaveLength(1);
    expect(pulls[0].merged_at).not.toBeNull();
    expect(pulls[0].number).toBe(result.baseVersion.prNumber);

    // Project finalized against the DISCOVERED owner + the per-run fixture repo.
    const project = await prisma.project.findUniqueOrThrow({ where: { id: projectId } });
    expect(project.currentBranch).toBe("v0.0.1");
    expect(project.repoOwner).toBe(fixture.owner);
    expect(project.repoName).toBe(fixture.repo);

    // Two ProjectVersion rows.
    const versions = await prisma.projectVersion.findMany({
      where: { projectId },
      orderBy: { semver: "asc" },
    });
    expect(versions.map((v) => v.semver)).toEqual(["0.0.0", "0.0.1"]);
    const base = versions.find((v) => v.semver === "0.0.0")!;
    const working = versions.find((v) => v.semver === "0.0.1")!;
    expect(base.state).toBe("base");
    expect(base.branchName).toBe("v0.0.0");
    expect(base.prNumber).toBeGreaterThan(0);
    expect(base.prUrl).toBeTruthy();
    expect(working.state).toBe("working");
    expect(working.branchName).toBe("v0.0.1");
    expect(working.headCommitSha).toBeTruthy();

    // Job succeeded with every stage done.
    const job = await prisma.projectJob.findUniqueOrThrow({ where: { id: jobId } });
    expect(job.status).toBe("succeeded");
    const stages = job.stages as Array<{ state: string }>;
    expect(stages.every((s) => s.state === "done")).toBe(true);
  }, 90_000);
});

describe("scaffoldProjectWorkflow — crash / replay", () => {
  it("cancels mid-run before the base-PR push, deletes the workspace, then resumes to completion WITHOUT double-scaffolding", async () => {
    const github = await resolveGithubE2eContext();
    const readers = await githubReaders();
    const fixture = await provisionFixtureRepo("scaffold-replay");
    const { projectId, jobId, payload } = await seedProjectJob(fixture);

    // Park the workflow at the boundary just before pushOpenMergeBasePr (after
    // commitBaseVersion has checkpointed) so the cancel lands at a step boundary.
    let release!: () => void;
    const reached = new Promise<void>((resolve) => {
      __setBoundaryHook(async (label) => {
        if (label === "pushOpenMergeBasePr") {
          resolve();
          await new Promise<void>((r) => {
            release = r;
          });
        }
      });
    });

    const handle = await client.enqueue<ScaffoldProjectResult>(
      {
        workflowName: WORKFLOW_NAMES.scaffoldProject,
        queueName: WORKFLOW_QUEUE.scaffoldProject,
        workflowID: jobId,
      },
      payload,
    );
    const settled = handle.getResult().then(
      () => "ok",
      () => "interrupted",
    );

    await reached;
    // Cancel preempts at the NEXT DBOS call (the push runStep never executes).
    await DBOS.cancelWorkflow(jobId);
    // Simulate a fresh worker with no local FS: the resumed run must re-clone.
    rmSync(join(tmpdir(), "supagloo-scaffold", jobId), { recursive: true, force: true });
    release();
    await settled; // the cancelled run has fully unwound

    // Nothing was pushed / no PR opened by the cancelled attempt — observed on REAL
    // GitHub rather than in a stub's in-memory counter. Strictly stronger: it is the
    // absence of the side effect on the host that would actually hold it.
    expect(await readers.listPulls({ repo: fixture.repo })).toEqual([]);
    expect(await countStepExecutions(client, jobId, "pushOpenMergeBasePr")).toBe(0);

    // Recover: resume from the last completed step (commitBaseVersion).
    __setBoundaryHook(undefined);
    await waitForStatus(jobId, ["CANCELLED", "ERROR"]);
    const resumeHandle = await DBOS.resumeWorkflow<ScaffoldProjectResult>(jobId);
    const result = (await resumeHandle.getResult()) as ScaffoldProjectResult;

    expect(result.workflowId).toBe(jobId);
    const heads = remoteHeads(fixture, github.token);
    expect(heads).toContain("refs/heads/v0.0.0");
    expect(heads).toContain("refs/heads/v0.0.1");

    // Exactly-once side effects across the resume, both dimensions (D9):
    //
    // (1) DURABILITY — the completed mint step was NOT re-run, and the push/open/merge
    //     step ran exactly once in total across the interrupted attempt + the resume.
    expect(await countStepExecutions(client, jobId, "mintInstallationToken")).toBe(1);
    expect(await countStepExecutions(client, jobId, "pushOpenMergeBasePr")).toBe(1);
    // (2) NON-DUPLICATION — real GitHub holds exactly ONE pull request for this repo, and
    //     it is merged. This is the assertion that goes red if the replayed
    //     `openPullRequest` mishandles real GitHub's 422-already-exists (task 62 D18-1:
    //     the lookup must query `state=all`, since the PR it needs to re-resolve is
    //     `closed` by then).
    const pulls = await readers.listPulls({ repo: fixture.repo });
    expect(pulls).toHaveLength(1);
    expect(pulls[0].merged_at).not.toBeNull();

    // Records finalized exactly once.
    const job = await prisma.projectJob.findUniqueOrThrow({ where: { id: jobId } });
    expect(job.status).toBe("succeeded");
    const versions = await prisma.projectVersion.findMany({ where: { projectId } });
    expect(versions.map((v) => v.semver).sort()).toEqual(["0.0.0", "0.0.1"]);
  }, 120_000);
});
