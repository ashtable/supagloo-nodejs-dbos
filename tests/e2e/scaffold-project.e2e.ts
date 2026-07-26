import { afterAll, beforeAll, describe, expect, it } from "vitest";
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
  gitFixtureExec,
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
//     the shared e2e prefix + `scaffold-<case>` + the run id — private, `auto_init: true`
//     by DEFAULT. Per-run names are MANDATORY, not tidiness: the v0.0.0 commit is
//     byte-deterministic by design, so a REUSED repo rejects a second run.
//     THE ONE EXCEPTION is the commit-less case below (plan row 63), which passes
//     `{ autoInit: false }` on purpose: the repo then has zero commits and no `main`, the
//     exact shape that used to 422 the base PR. It reaches `succeeded` because the
//     workflow bootstraps the base ref itself (`workspace.ts` `ensureBaseRef`). That
//     opt-out is additive and deliberately used nowhere else — every other lane
//     (scaffold-happy, commit, publish, render) depends on the default.
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
 * (the retired git-server needed no credential). It therefore goes through
 * `gitFixtureExec`, which redacts URL userinfo out of the thrown message AND out of the
 * captured stdout/stderr. That is not optional tidiness: `execFileSync` synthesises its
 * rejection message from **argv** (`Command failed: git ls-remote --heads <url>`), so a
 * raw call would print a live installation token into the vitest failure report. `stdio`
 * alone does nothing about it — the string never came from the child's streams.
 */
function remoteHeads(fixture: FixtureRepo, token: string): string[] {
  const out = gitFixtureExec([
    "ls-remote",
    "--heads",
    authenticatedRemoteUrl({ token, owner: fixture.owner, repo: fixture.repo }),
  ]);
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

// ---------------------------------------------------------------------- plan row 63
// The row's stated e2e acceptance, verbatim: "scaffold a PAT-created repo that has NO
// initial commit and reach `succeeded` — the case that 422s today".
//
// Traced failure before this row (real GitHub, real git 2.50.1):
//   git clone <empty repo>   → exit 0, "warning: You appear to have cloned an empty
//                              repository", HEAD = unborn refs/heads/main
//   git checkout -B v0.0.0   → exit 0 (works from an unborn HEAD)
//   git commit               → a ROOT commit, no parent
//   git push origin v0.0.0   → exit 0 — and REAL GITHUB PROMOTES v0.0.0 TO
//                              default_branch right here, so a naive retry is not
//                              idempotent-clean
//   POST /pulls base=main    → 422 Validation Failed (field: base, code: invalid)
// The `ensureBaseRef` bootstrap runs BEFORE any of that, so `main` exists on the remote
// first and GitHub promotes `main`, not `v0.0.0`.
describe("scaffoldProjectWorkflow — commit-less repo (row 63)", () => {
  it("scaffolds a PAT-created repo that has NO initial commit and reaches succeeded", async () => {
    const github = await resolveGithubE2eContext();
    const readers = await githubReaders();
    // `autoInit: false` ⇒ zero commits, no `main`, nothing for the branch readiness
    // gate to observe. This is the shape the product's own create-new path produced,
    // and the shape wireframe 13a's "Empty · created just now" repo has.
    const fixture = await provisionFixtureRepo("scaffold-unborn", {}, { autoInit: false });
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
    // The base PR is PRESERVED (D63.3): the bootstrap creates `main` and the base
    // version still lands through a merged PR, so `prNumber` stays non-null and
    // wireframe 12a step 2's designed row 5 ("Pushed → opened & merged PR into main")
    // stays literally true. If this goes red the bootstrap is wrong, not the assertion.
    expect(result.baseVersion.prNumber).toBeGreaterThan(0);

    // D63.4: scaffold MUST leave a `main` ref — `publish-version.ts` opens its PR with
    // `base: "main"` and `publish-version/workspace.ts` does `git clone --branch main`.
    const heads = remoteHeads(fixture, github.token);
    expect(heads).toContain("refs/heads/main");
    expect(heads).toContain("refs/heads/v0.0.0");
    expect(heads).toContain("refs/heads/v0.0.1");

    const pulls = await readers.listPulls({ repo: fixture.repo });
    expect(pulls).toHaveLength(1);
    expect(pulls[0].merged_at).not.toBeNull();
    expect(pulls[0].base.ref).toBe("main");
    expect(pulls[0].number).toBe(result.baseVersion.prNumber);

    const job = await prisma.projectJob.findUniqueOrThrow({ where: { id: jobId } });
    expect(job.status).toBe("succeeded");
    const stages = job.stages as Array<{ state: string }>;
    expect(stages.every((s) => s.state === "done")).toBe(true);

    const versions = await prisma.projectVersion.findMany({ where: { projectId } });
    expect(versions.map((v) => v.semver).sort()).toEqual(["0.0.0", "0.0.1"]);
  }, 120_000);
});

// D63.7. `scaffoldProjectFn` had NO try/catch, so row 63's own 422 left
// `ProjectJob.status = "running"` with `pushOpenMergeBasePr: pending` forever while
// DBOS reported ERROR — the user-visible face of the defect is an ETERNAL WIZARD
// SPINNER, not a failure. `import-project.ts` already had this; scaffold did not.
describe("scaffoldProjectWorkflow — permanent failure is recorded, not hung", () => {
  it("flips ProjectJob.status to failed when a scaffold step fails permanently, instead of hanging at running", async () => {
    const github = await resolveGithubE2eContext();
    // A repo the installation genuinely cannot reach ⇒ `ensureRepoAccessible` throws a
    // typed, PERMANENT RepoUnreachableError on the first attempt. Nothing is created on
    // GitHub, so this case accumulates no fixture repo.
    const missing: FixtureRepo = {
      owner: github.owner,
      repo: `no-such-repo-${randomUUID().slice(0, 8)}`,
      fullName: `${github.owner}/no-such-repo`,
      cloneUrl: "https://github.com/invalid/invalid.git",
    };
    const { jobId, payload } = await seedProjectJob(missing);

    const handle = await client.enqueue<ScaffoldProjectResult>(
      {
        workflowName: WORKFLOW_NAMES.scaffoldProject,
        queueName: WORKFLOW_QUEUE.scaffoldProject,
        workflowID: jobId,
      },
      payload,
    );
    const outcome = await handle.getResult().then(
      () => "ok",
      () => "failed",
    );
    expect(outcome).toBe("failed");

    const job = await prisma.projectJob.findUniqueOrThrow({ where: { id: jobId } });
    expect(job.status).toBe("failed");
    expect(job.completedAt).not.toBeNull();
    expect(job.error ?? "").not.toBe("");
    const stages = job.stages as Array<{ key: string; state: string }>;
    expect(stages.find((s) => s.key === "ensureRepoAccessible")?.state).toBe("failed");
    // The stage log is upserted IN PLACE — a later stage is untouched, never appended.
    expect(stages.find((s) => s.key === "pushOpenMergeBasePr")?.state).toBe("pending");
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
