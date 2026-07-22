import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DBOS, DBOSClient } from "@dbos-inc/dbos-sdk";
import { createPrismaClient } from "@supagloo/database-lib";
import { loadEnv, type Env } from "../../src/config/env";
import { launchDbos, shutdownDbos } from "../../src/dbos/runtime";
import { WORKFLOW_NAMES, WORKFLOW_QUEUE } from "../../src/dbos/registry";
import { initialImportStages } from "../../src/workflows/import-project/stages";
import {
  __setImportBoundaryHook,
  type ImportProjectPayload,
  type ImportProjectResult,
} from "../../src/workflows/import-project";

// End-to-end proof of importProjectWorkflow against the REAL provider-stub harness: the
// GitHub REST stub (localhost:4801) mints the installation token, and the local git
// smart-HTTP server (localhost:4805) serves a REAL clone of an existing repo. The DBOS
// runtime is launched IN-PROCESS (consuming the uncommitted db-lib via the file: dep —
// the containerized worker can't, per the in-flight-dblib-e2e constraint). No mocks.
//
// The git-server's admin route only seeds a single README on the default branch, so the
// VALID fixture (remotion.config.ts + supagloo.project.json + multiple vN.N.N branches)
// is constructed IN-TEST with the host `git` CLI — the stub is NOT edited.
//
// Three proofs: (1) import a valid Supagloo repo → resolves the highest version by REAL
// semver, records finalized; (2) import a non-Supagloo repo → fails fast with the
// "NOT A SUPAGLOO PROJECT" stage state, single execution; (3) crash/replay — cancel
// before parseManifest, delete the workspace (fresh worker), resume → completes once.

const GITHUB_STUB = process.env.GITHUB_STUB_URL ?? "http://localhost:4801";
const GIT_SERVER = process.env.GIT_SERVER_URL ?? "http://localhost:4805";
const INSTALLATION_ID = "42";

// The reused Compose git-server persists repos across runs, and the import fixture
// commits are NOT byte-deterministic (unlike scaffold's), so re-pushing fixed version
// branches would be a non-fast-forward. A fresh, unique repo name per test keeps every
// run hermetic.
const uniqueRepo = (base: string): string => `${base}-${randomUUID().slice(0, 8)}`;

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

const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});

const env: Env = loadEnv({
  DATABASE_URL:
    process.env.DATABASE_URL ?? "postgres://supagloo:supagloo@localhost:5432/supagloo",
  DBOS_DATABASE_URL:
    process.env.DBOS_DATABASE_URL ??
    "postgres://supagloo:supagloo@localhost:5432/supagloo_dbos",
  NODE_ENV: "test",
  GITHUB_API_BASE_URL: GITHUB_STUB,
  GITHUB_GIT_BASE_URL: GIT_SERVER,
  GITHUB_APP_ID: "123456",
  GITHUB_APP_PRIVATE_KEY: privateKey,
  // Task #29 made SECRETS_ENCRYPTION_KEY required at boot (unused by this workflow).
  SECRETS_ENCRYPTION_KEY: "0".repeat(64),
});

const prisma = createPrismaClient({ connectionString: env.DATABASE_URL });
let client: DBOSClient;

async function resetGithubStub(): Promise<void> {
  await fetch(`${GITHUB_STUB}/__stub/reset`, { method: "POST" });
}

async function githubState(): Promise<Record<string, number>> {
  const res = await fetch(`${GITHUB_STUB}/__stub/calls`);
  const body = (await res.json()) as { state: Record<string, number> };
  return body.state;
}

async function provisionRepo(fullName: string): Promise<void> {
  const res = await fetch(`${GIT_SERVER}/__admin/repos`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: fullName, seed: true, defaultBranch: "main" }),
  });
  if (!res.ok && res.status !== 409) {
    throw new Error(`provisionRepo(${fullName}) failed: ${res.status}`);
  }
}

/** Build a REAL Supagloo project on the origin: remotion.config.ts + manifest on main,
 *  plus three `vN.N.N` branches (so version resolution is exercised). */
function seedSupaglooRepo(fullName: string, branches: string[]): void {
  const work = mkdtempSync(join(tmpdir(), "import-fixture-"));
  const g = (args: string[]) =>
    execFileSync("git", args, { cwd: work, env: { ...process.env, ...HERMETIC_GIT } });
  try {
    execFileSync("git", ["clone", `${GIT_SERVER}/${fullName}.git`, work], {
      env: { ...process.env, ...HERMETIC_GIT },
    });
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

async function seedImportProjectJob(repoName: string): Promise<{
  projectId: string;
  jobId: string;
  payload: ImportProjectPayload;
}> {
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
      repoOwner: "acme",
      repoName,
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
    installationId: INSTALLATION_ID,
    repoOwner: "acme",
    repoName,
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
  await launchDbos(env);
  client = await DBOSClient.create({ systemDatabaseUrl: env.DBOS_DATABASE_URL });
}, 120_000);

afterAll(async () => {
  __setImportBoundaryHook(undefined);
  await client?.destroy().catch(() => {});
  await shutdownDbos();
  await prisma.$disconnect().catch(() => {});
});

describe("importProjectWorkflow — happy path", () => {
  it("imports a valid Supagloo repo: resolves the highest vN.N.N, finalizes records", async () => {
    await resetGithubStub();
    const repo = uniqueRepo("import-valid");
    await provisionRepo(`acme/${repo}`);
    // Lexically v0.2.3 > v0.10.0; the resolver must pick v0.10.0 (numeric semver).
    seedSupaglooRepo(`acme/${repo}`, ["v0.1.0", "v0.2.3", "v0.10.0"]);
    const { projectId, jobId, payload } = await seedImportProjectJob(repo);

    const handle = await client.enqueue<ImportProjectResult>(
      {
        workflowName: WORKFLOW_NAMES.importProject,
        queueName: WORKFLOW_QUEUE.importProject,
        workflowID: jobId,
      },
      payload,
    );
    const result = (await handle.getResult()) as ImportProjectResult;

    expect(result.workflowId).toBe(jobId);
    expect(result.version.branchName).toBe("v0.10.0");
    expect(result.version.semver).toBe("0.10.0");
    expect(result.version.headCommitSha).toMatch(/^[0-9a-f]{40}$/);

    // Token minted at least once; import performs no PR open/merge.
    const state = await githubState();
    expect(state.installationTokensIssued).toBeGreaterThanOrEqual(1);

    // Project advanced to the resolved version branch.
    const project = await prisma.project.findUniqueOrThrow({ where: { id: projectId } });
    expect(project.currentBranch).toBe("v0.10.0");
    expect(project.repoOwner).toBe("acme");
    expect(project.repoName).toBe(repo);

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
    await resetGithubStub();
    // Provisioned + seeded with only a README on main — no remotion.config.ts, no
    // version branch: NOT a Supagloo project.
    const repo = uniqueRepo("import-invalid");
    await provisionRepo(`acme/${repo}`);
    const { projectId, jobId, payload } = await seedImportProjectJob(repo);

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
    // (step-level non-retry is pinned deterministically by retry.test.ts).
    const state = await githubState();
    expect(state.installationTokensIssued).toBe(1);
  }, 90_000);
});

describe("importProjectWorkflow — crash / replay", () => {
  it("cancels before parseManifest, deletes the workspace, then resumes to completion once", async () => {
    await resetGithubStub();
    const repo = uniqueRepo("import-replay");
    await provisionRepo(`acme/${repo}`);
    seedSupaglooRepo(`acme/${repo}`, ["v0.0.1", "v0.3.0"]);
    const { projectId, jobId, payload } = await seedImportProjectJob(repo);

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

    // Exactly-once: one token minted (completed mint step not re-run), one version.
    const state = await githubState();
    expect(state.installationTokensIssued).toBe(1);
    const job = await prisma.projectJob.findUniqueOrThrow({ where: { id: jobId } });
    expect(job.status).toBe("succeeded");
    const versions = await prisma.projectVersion.findMany({ where: { projectId } });
    expect(versions.map((v) => v.semver)).toEqual(["0.3.0"]);
  }, 120_000);
});
