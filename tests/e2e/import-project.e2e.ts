import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DBOS, DBOSClient } from "@dbos-inc/dbos-sdk";
import { createPrismaClient } from "@supagloo/database-lib";
import { loadEnv, type Env } from "../../src/config/env";
import { launchDbos, shutdownDbos } from "../../src/dbos/runtime";
import {
  assertLaneRuntimeIsolated,
  assertWorkflowIsolated,
  laneSystemSchema,
  resetLaneSchema,
} from "../../src/testing/dbos-lane-isolation";
import { WORKFLOW_NAMES, WORKFLOW_QUEUE } from "../../src/dbos/registry";
import { initialImportStages } from "../../src/workflows/import-project/stages";
import {
  __setImportBoundaryHook,
  type ImportProjectPayload,
  type ImportProjectResult,
} from "../../src/workflows/import-project";
import {
  authenticatedRemoteUrl,
  gitFixtureExec,
  provisionFixtureRepo,
  resolveGithubE2eContext,
  resolveGithubE2eSecrets,
  type FixtureRepo,
} from "../../src/testing/github-e2e";
import { countStepExecutions } from "../../src/testing/step-introspection";

// End-to-end proof of importProjectWorkflow against **REAL GitHub**: api.github.com mints
// the installation token (real App PEM, runtime-DISCOVERED installation) and github.com
// serves a REAL authenticated clone of an existing repo. The DBOS runtime is launched
// IN-PROCESS (consuming the uncommitted db-lib via the file: dep — the containerized
// worker can't, per the in-flight-dblib-e2e constraint). No mocks.
//
// Task 62 (design-delta §11) deleted the github-stub (:4801) + git-server (:4805). Each
// test provisions its own per-run PRIVATE repo
// (the shared e2e prefix + `import-<case>` + the run id, `auto_init: true` — the harness
// DEFAULT, which every lane but `scaffold-project.e2e.ts`'s row-63 commit-less case uses),
// never torn down
// in-suite — reclaim with root's interactive `npm run cleanup:github-e2e`, which archives
// rather than deletes. A fresh fixture repo carries only GitHub's `auto_init` README (which
// is exactly what the "not a Supagloo project" case needs), so the VALID fixture
// (remotion.config.ts + supagloo.project.json + multiple vN.N.N branches) is constructed
// IN-TEST with the host `git` CLI.
//
// Three proofs: (1) import a valid Supagloo repo → resolves the highest version by REAL
// semver, records finalized; (2) import a non-Supagloo repo → fails fast with the
// "NOT A SUPAGLOO PROJECT" stage state, single execution; (3) crash/replay — cancel
// before parseManifest, delete the workspace (fresh worker), resume → completes once.

// Per-run repo names are inherent to `provisionFixtureRepo` (D6/D7), which is what keeps
// every run hermetic: the import fixture commits are NOT byte-deterministic (unlike
// scaffold's), so re-pushing fixed version branches into a reused repo would be a
// non-fast-forward.

const HERMETIC_GIT = {
  GIT_TERMINAL_PROMPT: "0",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_AUTHOR_NAME: "Import Fixture",
  GIT_AUTHOR_EMAIL: "fixture@supagloo.test",
  GIT_COMMITTER_NAME: "Import Fixture",
  GIT_COMMITTER_EMAIL: "fixture@supagloo.test",
};

const VALID_MANIFEST = {
  manifestVersion: 1,
  composition: { width: 1080, height: 1920, fps: 30, aspectRatio: "9:16" },
  scenes: [],
  narratorVoice: { description: "Calm, measured narrator" },
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
const SYSTEM_SCHEMA = laneSystemSchema("dbos_import");

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

/** Build a REAL Supagloo project on the origin: remotion.config.ts + manifest on main,
 *  plus three `vN.N.N` branches (so version resolution is exercised). */
function seedSupaglooRepo(fullName: string, branches: string[]): void {
  const work = mkdtempSync(join(tmpdir(), "import-fixture-"));
  // ALWAYS through the redacting seam: `authRemote()` embeds a live installation token in
  // an argv element, and `execFileSync` synthesises its rejection message from argv
  // (`Command failed: git clone <url>`), so a raw call prints the credential into the
  // vitest failure report. `gitFixtureExec` scrubs URL userinfo out of the message,
  // stdout and stderr, and supplies the hermetic git env itself.
  const g = (args: string[]) => gitFixtureExec(args, { cwd: work, env: HERMETIC_GIT });
  try {
    gitFixtureExec(["clone", authRemote(fullName), work], { env: HERMETIC_GIT });
    writeFileSync(
      join(work, "remotion.config.ts"),
      "// Supagloo-generated Remotion config — DO NOT EDIT.\n",
    );
    writeFileSync(
      join(work, "supagloo.project.json"),
      `${JSON.stringify(VALID_MANIFEST, null, 2)}\n`,
    );
    g(["add", "-A"]);
    g(["commit", "-m", "supagloo scaffold"]);
    g(["push", "origin", "main"]);
    for (const branch of branches) {
      g(["branch", branch]);
      g(["push", "origin", branch]);
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

async function seedImportProjectJob(fixture: FixtureRepo): Promise<{
  projectId: string;
  jobId: string;
  payload: ImportProjectPayload;
}> {
  const github = await resolveGithubE2eContext();
  const suffix = randomUUID().slice(0, 8);
  const user = await prisma.user.create({
    data: {
      youversionUserId: `yv-imp-${suffix}`,
      displayName: "Import E2E",
      email: `${suffix}@supagloo.test`,
      avatarInitials: "IE",
    },
  });
  const ownerId = user.id;
  const project = await prisma.project.create({
    data: {
      slug: `import-${suffix}`,
      ownerId,
      name: "Import E2E",
      repoOwner: fixture.owner,
      repoName: fixture.repo,
      repoVisibility: "private",
      createdFrom: "import",
      currentBranch: "main",
    },
  });
  const jobId = `import-${project.id}-${suffix}`;
  await prisma.projectJob.create({
    data: {
      id: jobId,
      projectId: project.id,
      userId: ownerId,
      kind: "import_verify",
      status: "queued",
      stages: initialImportStages(),
    },
  });
  const payload: ImportProjectPayload = {
    projectId: project.id,
    userId: ownerId,
    ownerId,
    // DISCOVERED at runtime (D5) — never the fabricated `"42"` real GitHub 404s on.
    installationId: github.installationId,
    repoOwner: fixture.owner,
    repoName: fixture.repo,
    repoVisibility: "private",
    slug: project.slug,
    name: project.name,
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
  __setImportBoundaryHook(undefined);
  await client?.destroy().catch(() => {});
  await shutdownDbos();
  await prisma.$disconnect().catch(() => {});
});

describe("lane isolation", () => {
  it("E-DB0-import: this lane runs on its own DBOS system schema, so the Compose worker cannot see its work", async () => {
    expect(SYSTEM_SCHEMA).not.toBe("dbos");
    await assertLaneRuntimeIsolated({
      systemDatabaseUrl: env.DBOS_DATABASE_URL,
      schema: SYSTEM_SCHEMA,
    });
  });
});

describe("importProjectWorkflow — happy path", () => {
  it("imports a valid Supagloo repo: resolves the highest vN.N.N, finalizes records", async () => {
    const fixture = await provisionFixtureRepo("import-valid");
    // Lexically v0.2.3 > v0.10.0; the resolver must pick v0.10.0 (numeric semver).
    seedSupaglooRepo(fixture.fullName, ["v0.1.0", "v0.2.3", "v0.10.0"]);
    const { projectId, jobId, payload } = await seedImportProjectJob(fixture);

    const handle = await client.enqueue<ImportProjectResult>(
      {
        workflowName: WORKFLOW_NAMES.importProject,
        queueName: WORKFLOW_QUEUE.importProject,
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
    const result = (await handle.getResult()) as ImportProjectResult;

    expect(result.workflowId).toBe(jobId);
    expect(result.version.branchName).toBe("v0.10.0");
    expect(result.version.semver).toBe("0.10.0");
    expect(result.version.headCommitSha).toMatch(/^[0-9a-f]{40}$/);

    // Exactly-once, DURABILITY axis only (D9). `importProjectWorkflow` is READ-ONLY on
    // GitHub — `import-project/workspace.ts` checks out and never pushes, opens no PR and
    // creates no ref — so there is deliberately NO real-host artifact half here. The
    // missing second axis is a property of the workflow, not an oversight.
    expect(await countStepExecutions(client, jobId, "mintInstallationToken")).toBe(1);

    // Project advanced to the resolved version branch.
    const project = await prisma.project.findUniqueOrThrow({ where: { id: projectId } });
    expect(project.currentBranch).toBe("v0.10.0");
    expect(project.repoOwner).toBe(fixture.owner);
    expect(project.repoName).toBe(fixture.repo);

    // Exactly ONE ProjectVersion (the resolved latest), working.
    const versions = await prisma.projectVersion.findMany({ where: { projectId } });
    expect(versions).toHaveLength(1);
    expect(versions[0].semver).toBe("0.10.0");
    expect(versions[0].branchName).toBe("v0.10.0");
    expect(versions[0].state).toBe("working");
    expect(versions[0].headCommitSha).toBeTruthy();

    // Job succeeded with every stage done.
    const job = await prisma.projectJob.findUniqueOrThrow({ where: { id: jobId } });
    expect(job.status).toBe("succeeded");
    const stages = job.stages as Array<{ state: string }>;
    expect(stages).toHaveLength(6);
    expect(stages.every((s) => s.state === "done")).toBe(true);
  }, 90_000);
});

describe("importProjectWorkflow — non-Supagloo repo fails fast", () => {
  it("fails with the NOT A SUPAGLOO PROJECT stage state, no retries burned", async () => {
    // Left exactly as `auto_init` created it — a single README on main, no
    // remotion.config.ts, no version branch: NOT a Supagloo project. (Real GitHub's
    // auto-init README plays the role the git-server's `seed: true` used to.)
    const fixture = await provisionFixtureRepo("import-invalid");
    const { projectId, jobId, payload } = await seedImportProjectJob(fixture);

    const handle = await client.enqueue<ImportProjectResult>(
      {
        workflowName: WORKFLOW_NAMES.importProject,
        queueName: WORKFLOW_QUEUE.importProject,
        workflowID: jobId,
      },
      payload,
    );
    const outcome = await handle.getResult().then(
      () => "ok",
      () => "failed",
    );
    expect(outcome).toBe("failed");

    // Job terminated failed with the verify stage marked failed + the typed message.
    const job = await prisma.projectJob.findUniqueOrThrow({ where: { id: jobId } });
    expect(job.status).toBe("failed");
    expect(job.error ?? "").toContain("NOT A SUPAGLOO PROJECT");
    const stages = job.stages as Array<{ key: string; state: string }>;
    expect(stages.find((s) => s.key === "verifySupaglooProject")?.state).toBe("failed");

    // No version was created for the rejected repo.
    const versions = await prisma.projectVersion.findMany({ where: { projectId } });
    expect(versions).toHaveLength(0);

    // Single execution — the non-retryable verify failure did not re-run the workflow
    // (step-level non-retry is pinned deterministically by retry.test.ts). Counted in the
    // DBOS system DB and attributed to THIS workflow, which the stub's global counter
    // could not do.
    expect(await countStepExecutions(client, jobId, "mintInstallationToken")).toBe(1);
  }, 90_000);
});

describe("importProjectWorkflow — crash / replay", () => {
  it("cancels before parseManifest, deletes the workspace, then resumes to completion once", async () => {
    const fixture = await provisionFixtureRepo("import-replay");
    seedSupaglooRepo(fixture.fullName, ["v0.0.1", "v0.3.0"]);
    const { projectId, jobId, payload } = await seedImportProjectJob(fixture);

    // Park at the boundary just before parseManifest (after resolveLatestVersionBranch
    // has checkpointed) so the cancel lands at a step boundary.
    let release!: () => void;
    const reached = new Promise<void>((resolve) => {
      __setImportBoundaryHook(async (label) => {
        if (label === "parseManifest") {
          resolve();
          await new Promise<void>((r) => {
            release = r;
          });
        }
      });
    });

    const handle = await client.enqueue<ImportProjectResult>(
      {
        workflowName: WORKFLOW_NAMES.importProject,
        queueName: WORKFLOW_QUEUE.importProject,
        workflowID: jobId,
      },
      payload,
    );
    const settled = handle.getResult().then(
      () => "ok",
      () => "interrupted",
    );

    await reached;
    await DBOS.cancelWorkflow(jobId);
    // Simulate a fresh worker with no local FS: the resumed run must re-clone.
    rmSync(join(tmpdir(), "supagloo-import", jobId), { recursive: true, force: true });
    release();
    await settled;

    __setImportBoundaryHook(undefined);
    await waitForStatus(jobId, ["CANCELLED", "ERROR"]);
    const resumeHandle = await DBOS.resumeWorkflow<ImportProjectResult>(jobId);
    const result = (await resumeHandle.getResult()) as ImportProjectResult;

    expect(result.workflowId).toBe(jobId);
    expect(result.version.branchName).toBe("v0.3.0");

    // Exactly-once across the resume: the completed mint step was NOT re-run, one version.
    // Durability axis only — import pushes nothing (see the happy-path note above).
    expect(await countStepExecutions(client, jobId, "mintInstallationToken")).toBe(1);
    const job = await prisma.projectJob.findUniqueOrThrow({ where: { id: jobId } });
    expect(job.status).toBe("succeeded");
    const versions = await prisma.projectVersion.findMany({ where: { projectId } });
    expect(versions.map((v) => v.semver)).toEqual(["0.3.0"]);
  }, 120_000);
});
