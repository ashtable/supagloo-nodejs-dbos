import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DBOS, DBOSClient } from "@dbos-inc/dbos-sdk";
import { createPrismaClient } from "@supagloo/database-lib";
import { loadEnv, type Env } from "../../src/config/env";
import { TEST_SECRETS_ENCRYPTION_KEY } from "../../src/testing/secrets-fixture";
import { launchDbos, shutdownDbos } from "../../src/dbos/runtime";
import {
  assertLaneRuntimeIsolated,
  assertWorkflowIsolated,
  laneSystemSchema,
  resetLaneSchema,
} from "../../src/testing/dbos-lane-isolation";
import { WORKFLOW_NAMES, WORKFLOW_QUEUE } from "../../src/dbos/registry";
import { initialCommitStages } from "../../src/workflows/commit-version/stages";
import {
  __setCommitBoundaryHook,
  type CommitVersionPayload,
  type CommitVersionResult,
} from "../../src/workflows/commit-version";
import { writeRemotionScaffold } from "../../src/remotion";
import {
  emptyManifest,
  shelterManifest,
} from "../../src/remotion/__fixtures__/manifests";
import {
  authenticatedRemoteUrl,
  gitFixtureExec,
  provisionFixtureRepo,
  resolveGithubE2eContext,
  resolveGithubE2eSecrets,
  type FixtureRepo,
} from "../../src/testing/github-e2e";
import { countStepExecutions } from "../../src/testing/step-introspection";
import { assertCheckpointedTokensSealed } from "../../src/testing/token-leak-probe";

// End-to-end proof of commitVersionWorkflow against **REAL GitHub**: api.github.com mints
// the installation token (real App PEM, runtime-DISCOVERED installation) and github.com
// serves a REAL authenticated clone/commit/push of the project's working branch. The DBOS
// runtime is launched IN-PROCESS (consuming the uncommitted db-lib via the file: dep).
// No mocks.
//
// Task 62 (design-delta §11) deleted the github-stub (:4801) + git-server (:4805). Each
// test provisions its own per-run PRIVATE repo
// (the shared e2e prefix + `commit-<case>` + the run id, `auto_init: true` — the harness
// DEFAULT, which every lane but `scaffold-project.e2e.ts`'s row-63 commit-less case uses)
// and is never torn
// down in-suite — reclaim with root's interactive `npm run cleanup:github-e2e`, which
// archives rather than deletes.
//
// A fixture repo starts with only GitHub's `auto_init` README, so a realistic WORKING
// BRANCH (a full Remotion scaffold on a `v0.0.1` branch) is built IN-TEST with the host
// `git` CLI + task-16 writeRemotionScaffold. Commit then persists the 2-scene
// shelterManifest.
//
// Two proofs: (1) happy path — the working branch head ADVANCES by EXACTLY ONE commit,
// the regenerated scene sources are present, the working ProjectVersion is updated in
// place; (2) crash/replay — cancel after commitAndPush (before updateVersionRecord),
// delete the workspace (fresh worker), resume → completes with NO double-commit.

const BRANCH = "v0.0.1";
const SEMVER = "0.0.1";

const HERMETIC_GIT = {
  GIT_TERMINAL_PROMPT: "0",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_AUTHOR_NAME: "Commit Fixture",
  GIT_AUTHOR_EMAIL: "fixture@supagloo.test",
  GIT_COMMITTER_NAME: "Commit Fixture",
  GIT_COMMITTER_EMAIL: "fixture@supagloo.test",
};

// Real GitHub App credentials from the root `.env` (loaded per-worker by
// `tests/e2e/load-root-env.ts`); fails fast by name if any is missing.
const githubSecrets = resolveGithubE2eSecrets();

// ISOLATION, NOT A PRECONDITION. This spec launches the REAL DBOS runtime in-process and
// registers the REAL static workflow names on the REAL shared queues — exactly what the
// root Compose `dbos` container does. Nothing used to distinguish them: `executor_id` is
// "local" for both (and is a recovery filter, never a dequeue filter), the in-process
// worker's auto-computed application version MATCHES the container's, and the dequeue
// predicate accepts `application_version IS NULL`. So the container could dequeue this
// spec's work — and, worse, could be the executor that resumes a workflow the crash/replay
// specs just killed, leaving the exactly-once proof measuring the wrong process.
//
// Requiring the container to be stopped is not an option: that precondition is
// unsatisfiable across a full sweep (root's own e2e lane and nextjs's render lane both
// bring `dbos` UP and deliberately leave it up). Instead the in-process runtime AND the
// DBOSClient share a per-lane DBOS system SCHEMA inside the same `supagloo_dbos` database
// (SDK `systemDatabaseSchemaName`), so the two executors cannot see each other's rows in
// EITHER direction. The container may be up or down; both pass. Queue and workflow names
// are unchanged and deliberately still the real ones — static registration is a hard
// constraint of src/dbos/registry.ts and the real names are what this spec proves.

/** This lane's private DBOS system schema inside `supagloo_dbos` (see the header note). */
const SYSTEM_SCHEMA = laneSystemSchema("dbos_commit");

const env: Env = loadEnv({
  DATABASE_URL:
    process.env.DATABASE_URL ?? "postgres://supagloo:supagloo@localhost:5432/supagloo",
  DBOS_DATABASE_URL:
    process.env.DBOS_DATABASE_URL ??
    "postgres://supagloo:supagloo@localhost:5432/supagloo_dbos",
  // The lane half of the isolation seam: launchDbos() forwards this to
  // DBOS.setConfig({ systemDatabaseSchemaName }). Unset in Compose; explicit here.
  DBOS_SYSTEM_DATABASE_SCHEMA: SYSTEM_SCHEMA,
  NODE_ENV: "test",
  // No GITHUB_*_BASE_URL override — the env schema already defaults to the real hosts
  // (finding F1: dbos was always real-by-default; only these specs pointed it at a stub).
  GITHUB_APP_ID: githubSecrets.appId,
  GITHUB_APP_PRIVATE_KEY: githubSecrets.privateKey,
  // dbos 6c8a89b (2026-07-30) made YOUVERSION_APP_KEY required at boot (unused by this
  // workflow — `generate-script.ts` is the only caller of the YouVersion provider and this
  // spec never enqueues it). Deliberately a PLACEHOLDER rather than
  // `process.env.YOUVERSION_APP_KEY`: a spec that reads no scripture must not need the
  // operator's real key to boot. Same literal as `src/config/env.test.ts`.
  YOUVERSION_APP_KEY: "yvp-app-key-value",
  // Task #29 made SECRETS_ENCRYPTION_KEY required at boot; since plan row 48 this
  // workflow USES it — the mintInstallationToken step seals its result with it, so this
  // value and the probe's `encryptionKey` below must stay the same key.
  SECRETS_ENCRYPTION_KEY: TEST_SECRETS_ENCRYPTION_KEY,
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
 * in `beforeAll` by the PRODUCT path (db-lib `mintInstallationToken`). The fixture repos
 * are private, so every `git clone`/`push` below needs it — the retired git-server needed
 * no credential at all, which is why these helpers used bare URLs.
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

/** Build a REAL working branch on the origin: a full scaffold (empty manifest) on main +
 *  a `v0.0.1` branch. Returns the branch's seeded head SHA. */
async function seedWorkingBranch(fullName: string): Promise<string> {
  const work = mkdtempSync(join(tmpdir(), "commit-fixture-"));
  try {
    gitFixture(["clone", authRemote(fullName), work]);
    await writeRemotionScaffold(emptyManifest, work);
    gitFixture(["add", "-A"], work);
    gitFixture(["commit", "-m", "supagloo scaffold"], work);
    gitFixture(["push", "origin", "main"], work);
    gitFixture(["branch", BRANCH], work);
    gitFixture(["push", "origin", BRANCH], work);
    return branchHead(fullName);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/** The origin's current head SHA for the working branch (via ls-remote). */
function branchHead(fullName: string): string {
  const out = gitFixture([
    "ls-remote",
    "--heads",
    authRemote(fullName),
    `refs/heads/${BRANCH}`,
  ]);
  return out.split(/\s+/)[0];
}

/** Count of commits in `from..to`, resolved from a fresh full clone of the working branch. */
function commitsBetween(fullName: string, from: string, to: string): number {
  const verify = mkdtempSync(join(tmpdir(), "commit-verify-"));
  try {
    gitFixture(["clone", "--branch", BRANCH, authRemote(fullName), verify]);
    return Number(
      gitFixture(["rev-list", "--count", `${from}..${to}`], verify).trim(),
    );
  } finally {
    rmSync(verify, { recursive: true, force: true });
  }
}

/** True iff the working branch head carries a regenerated scene source for the manifest. */
function branchHasSceneSource(fullName: string, sceneFile: string): boolean {
  const verify = mkdtempSync(join(tmpdir(), "commit-scene-"));
  try {
    gitFixture(["clone", "--branch", BRANCH, authRemote(fullName), verify]);
    return existsSync(join(verify, "src/scenes", sceneFile));
  } finally {
    rmSync(verify, { recursive: true, force: true });
  }
}

async function seedCommitProjectJob(fixture: FixtureRepo): Promise<{
  projectId: string;
  jobId: string;
  payload: CommitVersionPayload;
}> {
  const github = await resolveGithubE2eContext();
  const suffix = randomUUID().slice(0, 8);
  const user = await prisma.user.create({
    data: {
      youversionUserId: `yv-commit-${suffix}`,
      displayName: "Commit E2E",
      email: `${suffix}@supagloo.test`,
      avatarInitials: "CE",
    },
  });
  const ownerId = user.id;
  const project = await prisma.project.create({
    data: {
      slug: `commit-${suffix}`,
      ownerId,
      name: "Commit E2E",
      repoOwner: fixture.owner,
      repoName: fixture.repo,
      repoVisibility: "private",
      createdFrom: "blank",
      currentBranch: BRANCH,
    },
  });
  // The working version the commit updates in place.
  await prisma.projectVersion.create({
    data: {
      projectId: project.id,
      semver: SEMVER,
      branchName: BRANCH,
      state: "working",
      changedFiles: [],
    },
  });
  const jobId = `commit-${project.id}-${suffix}`;
  await prisma.projectJob.create({
    data: {
      id: jobId,
      projectId: project.id,
      userId: ownerId,
      kind: "commit",
      status: "queued",
      stages: initialCommitStages(),
    },
  });
  const payload: CommitVersionPayload = {
    projectId: project.id,
    userId: ownerId,
    // DISCOVERED at runtime (D5) — never the fabricated `"42"` real GitHub 404s on.
    installationId: github.installationId,
    repoOwner: fixture.owner,
    repoName: fixture.repo,
    branchName: BRANCH,
    semver: SEMVER,
    manifest: shelterManifest,
    message: "Persist the shelter composition",
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
  // Self-heal a crashed previous run BEFORE launch, so no stale PENDING row is adopted
  // by DBOS's recovery sweep (same executor_id "local", same auto-computed app version).
  await resetLaneSchema({
    systemDatabaseUrl: env.DBOS_DATABASE_URL,
    schema: SYSTEM_SCHEMA,
  });
  await launchDbos(env);
  // Fail FAST and LOUD if the config did not take. Never a warn, never a skip.
  await assertLaneRuntimeIsolated({
    systemDatabaseUrl: env.DBOS_DATABASE_URL,
    schema: SYSTEM_SCHEMA,
  });
  client = await DBOSClient.create({
    systemDatabaseUrl: env.DBOS_DATABASE_URL,
    systemDatabaseSchemaName: SYSTEM_SCHEMA, // ← the client half
  });
}, 120_000);

afterAll(async () => {
  __setCommitBoundaryHook(undefined);
  await client?.destroy().catch(() => {});
  await shutdownDbos();
  await prisma.$disconnect().catch(() => {});
});

describe("lane isolation", () => {
  it("E-DB0-commit: this lane runs on its own DBOS system schema, so the Compose worker cannot see its work", async () => {
    expect(SYSTEM_SCHEMA).not.toBe("dbos");
    await assertLaneRuntimeIsolated({
      systemDatabaseUrl: env.DBOS_DATABASE_URL,
      schema: SYSTEM_SCHEMA,
    });
  });
});

describe("commitVersionWorkflow — happy path", () => {
  it("commits the edited manifest: branch head advances by one commit, sources regenerated, version updated", async () => {
    const fixture = await provisionFixtureRepo("commit-happy");
    const seededHead = await seedWorkingBranch(fixture.fullName);
    const { projectId, jobId, payload } = await seedCommitProjectJob(fixture);

    const handle = await client.enqueue<CommitVersionResult>(
      {
        workflowName: WORKFLOW_NAMES.commitVersion,
        queueName: WORKFLOW_QUEUE.commitVersion,
        workflowID: jobId,
      },
      payload,
    );
    // The CLIENT half of the isolation is real: this enqueue landed in the lane's
    // schema and is absent from the shared one the Compose worker polls. Folded into
    // the FIRST enqueue this spec ALREADY makes — never a synthetic enqueue of a real
    // workflow, which would do real GitHub/S3/provider work for no new information.
    //
    // Asserted BEFORE getResult(), and that ordering is the whole point. With the
    // client half dropped the row lands in the shared schema, the containerised worker
    // executes this very workflow and drives the SAME app-DB rows, and every assertion
    // below still passes — the spec would go green having proven the CONTAINER works
    // rather than this process. That is the green lie the guard exists to stop, and it
    // is invisible without a positive check at the enqueue itself.
    await assertWorkflowIsolated({
      systemDatabaseUrl: env.DBOS_DATABASE_URL,
      schema: SYSTEM_SCHEMA,
      workflowID: jobId,
    });
    const result = (await handle.getResult()) as CommitVersionResult;

    expect(result.workflowId).toBe(jobId);
    expect(result.committed).toBe(true);
    expect(result.version.branchName).toBe(BRANCH);
    expect(result.version.headCommitSha).toMatch(/^[0-9a-f]{40}$/);

    // The origin advanced to the recorded head by EXACTLY one commit (no double-commit).
    const newHead = branchHead(fixture.fullName);
    expect(newHead).toBe(result.version.headCommitSha);
    expect(newHead).not.toBe(seededHead);
    expect(commitsBetween(fixture.fullName, seededHead, newHead)).toBe(1);

    // The regenerated scene source for the manifest is present on the branch.
    expect(branchHasSceneSource(fixture.fullName, "Shelter.tsx")).toBe(true);

    // Exactly-once, DURABILITY axis (D9): the mint step ran once, attributed to THIS
    // workflow. The stub's global `installationTokensIssued` counter could not attribute
    // a call to a workflow at all. The NON-DUPLICATION axis for this workflow is the
    // one-commit-on-the-real-branch assertion above — commitVersion opens/merges no PR,
    // so there is deliberately no `listPulls` half here.
    expect(await countStepExecutions(client, jobId, "mintInstallationToken")).toBe(1);

    // PLAN ROW 48 — no plaintext installation token in any DBOS checkpoint. The probe
    // reads the LANE schema (a default-`dbos` query from inside a lane finds zero rows
    // and passes vacuously — brief §9 S8) and proves the mint step's checkpoint is a
    // real ciphertext of a real token, not merely the absence of one.
    await assertCheckpointedTokensSealed({
      systemDatabaseUrl: env.DBOS_DATABASE_URL,
      schema: SYSTEM_SCHEMA,
      workflowID: jobId,
      encryptionKey: TEST_SECRETS_ENCRYPTION_KEY,
    });

    // The working ProjectVersion (0.0.1) is updated IN PLACE — still exactly one version.
    const versions = await prisma.projectVersion.findMany({ where: { projectId } });
    expect(versions).toHaveLength(1);
    const working = versions[0];
    expect(working.semver).toBe(SEMVER);
    expect(working.branchName).toBe(BRANCH);
    expect(working.state).toBe("working");
    expect(working.headCommitSha).toBe(newHead);
    expect(working.commitMessage).toBe("Persist the shelter composition");
    const changed = working.changedFiles as string[];
    expect(changed.length).toBeGreaterThan(0);
    expect(changed.some((f) => f.endsWith("Shelter.tsx"))).toBe(true);

    // The Project row is untouched (commit stays on the same working branch).
    const project = await prisma.project.findUniqueOrThrow({ where: { id: projectId } });
    expect(project.currentBranch).toBe(BRANCH);

    // Job succeeded with every stage done.
    const job = await prisma.projectJob.findUniqueOrThrow({ where: { id: jobId } });
    expect(job.status).toBe("succeeded");
    const stages = job.stages as Array<{ state: string }>;
    expect(stages).toHaveLength(5);
    expect(stages.every((s) => s.state === "done")).toBe(true);
  }, 120_000);
});

describe("commitVersionWorkflow — crash / replay", () => {
  it("cancels after commitAndPush, deletes the workspace, then resumes WITHOUT double-committing", async () => {
    const fixture = await provisionFixtureRepo("commit-replay");
    const seededHead = await seedWorkingBranch(fixture.fullName);
    const { projectId, jobId, payload } = await seedCommitProjectJob(fixture);

    // Park at the boundary just before updateVersionRecord (after commitAndPush has
    // pushed + checkpointed) so the cancel lands at a step boundary.
    let release!: () => void;
    const reached = new Promise<void>((resolve) => {
      __setCommitBoundaryHook(async (label) => {
        if (label === "updateVersionRecord") {
          resolve();
          await new Promise<void>((r) => {
            release = r;
          });
        }
      });
    });

    const handle = await client.enqueue<CommitVersionResult>(
      {
        workflowName: WORKFLOW_NAMES.commitVersion,
        queueName: WORKFLOW_QUEUE.commitVersion,
        workflowID: jobId,
      },
      payload,
    );
    const settled = handle.getResult().then(
      () => "ok",
      () => "interrupted",
    );

    await reached;
    // The commit is already pushed at this boundary; cancel preempts updateVersionRecord.
    await DBOS.cancelWorkflow(jobId);
    // Simulate a fresh worker with no local FS.
    rmSync(join(tmpdir(), "supagloo-commit", jobId), { recursive: true, force: true });
    release();
    await settled;

    __setCommitBoundaryHook(undefined);
    await waitForStatus(jobId, ["CANCELLED", "ERROR"]);
    const resumeHandle = await DBOS.resumeWorkflow<CommitVersionResult>(jobId);
    const result = (await resumeHandle.getResult()) as CommitVersionResult;

    expect(result.workflowId).toBe(jobId);

    // Exactly ONE commit landed on the branch across both attempts (no double-commit:
    // commitAndPush was checkpointed on attempt 1 and skipped on resume).
    const newHead = branchHead(fixture.fullName);
    expect(commitsBetween(fixture.fullName, seededHead, newHead)).toBe(1);

    // Exactly-once across the resume: the completed mint step was NOT re-run. Counted in
    // the DBOS system DB, so an internal `retriesAllowed` retry cannot inflate it either
    // (one StepInfo row per functionID).
    expect(await countStepExecutions(client, jobId, "mintInstallationToken")).toBe(1);

    // The working version is updated once; still exactly one version.
    const versions = await prisma.projectVersion.findMany({ where: { projectId } });
    expect(versions).toHaveLength(1);
    expect(versions[0].headCommitSha).toBe(newHead);
    const job = await prisma.projectJob.findUniqueOrThrow({ where: { id: jobId } });
    expect(job.status).toBe("succeeded");
  }, 150_000);
});
