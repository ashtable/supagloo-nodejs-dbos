import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { generateKeyPairSync, randomUUID } from "node:crypto";
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

// End-to-end proof of scaffoldProjectWorkflow against the REAL provider-stub
// harness: the GitHub REST stub (localhost:4801) mints installation tokens + opens
// & merges the base PR, and the local git smart-HTTP server (localhost:4805) serves
// a REAL clone/commit/push/branch cycle. The DBOS runtime is launched IN-PROCESS
// (so it consumes the uncommitted db-lib via the file: dep — the containerized
// worker can't, per the in-flight-dblib-e2e constraint). The workflow shells out to
// the host `git` CLI. No mocks.
//
// Two proofs: (1) happy path enqueue → completion (branches, PR, DB rows);
// (2) crash/replay — cancel the workflow mid-run at the boundary before the base-PR
// push, delete the ephemeral workspace (simulating a fresh worker), then RESUME →
// it completes exactly once (stub call counts prove NO double-scaffolding).

const GITHUB_STUB = process.env.GITHUB_STUB_URL ?? "http://localhost:4801";
const GIT_SERVER = process.env.GIT_SERVER_URL ?? "http://localhost:4805";
const INSTALLATION_ID = "42";

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
  // Task #32 made the S3 (writer) vars required at boot (unused by this workflow).
  S3_ENDPOINT: "http://minio:9000",
  S3_BUCKET: "supagloo-dev",
  S3_ACCESS_KEY: "supagloo",
  S3_SECRET_KEY: "supagloo-dev",
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

/** Head refs on the origin, via a real `git ls-remote`. */
function remoteHeads(fullName: string): string[] {
  const out = execFileSync(
    "git",
    ["ls-remote", "--heads", `${GIT_SERVER}/${fullName}.git`],
    { env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } },
  ).toString();
  return out
    .split("\n")
    .filter(Boolean)
    .map((line) => line.split(/\s+/)[1]);
}

async function seedProjectJob(repoName: string): Promise<{
  projectId: string;
  jobId: string;
  payload: ScaffoldProjectPayload;
}> {
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
      repoOwner: "acme",
      repoName,
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
    installationId: INSTALLATION_ID,
    repoOwner: "acme",
    repoName,
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
    await resetGithubStub();
    await provisionRepo("acme/empty-one");
    const { projectId, jobId, payload } = await seedProjectJob("empty-one");

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

    // Real branches on the origin.
    const heads = remoteHeads("acme/empty-one");
    expect(heads).toContain("refs/heads/v0.0.0");
    expect(heads).toContain("refs/heads/v0.0.1");

    // Stub call counts: exactly one PR opened + merged.
    const state = await githubState();
    expect(state.installationTokensIssued).toBeGreaterThanOrEqual(1);
    expect(state.pullsOpened).toBe(1);
    expect(state.pullsMerged).toBe(1);

    // Project finalized.
    const project = await prisma.project.findUniqueOrThrow({ where: { id: projectId } });
    expect(project.currentBranch).toBe("v0.0.1");
    expect(project.repoOwner).toBe("acme");
    expect(project.repoName).toBe("empty-one");

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
    await resetGithubStub();
    await provisionRepo("acme/empty-two");
    const { projectId, jobId, payload } = await seedProjectJob("empty-two");

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

    // Nothing was pushed / no PR opened by the cancelled attempt.
    const preResume = await githubState();
    expect(preResume.pullsOpened ?? 0).toBe(0);

    // Recover: resume from the last completed step (commitBaseVersion).
    __setBoundaryHook(undefined);
    await waitForStatus(jobId, ["CANCELLED", "ERROR"]);
    const resumeHandle = await DBOS.resumeWorkflow<ScaffoldProjectResult>(jobId);
    const result = (await resumeHandle.getResult()) as ScaffoldProjectResult;

    expect(result.workflowId).toBe(jobId);
    const heads = remoteHeads("acme/empty-two");
    expect(heads).toContain("refs/heads/v0.0.0");
    expect(heads).toContain("refs/heads/v0.0.1");

    // Exactly-once side effects: one PR opened + merged, one token minted (the
    // completed mint step was NOT re-run on resume).
    const state = await githubState();
    expect(state.pullsOpened).toBe(1);
    expect(state.pullsMerged).toBe(1);
    expect(state.installationTokensIssued).toBe(1);

    // Records finalized exactly once.
    const job = await prisma.projectJob.findUniqueOrThrow({ where: { id: jobId } });
    expect(job.status).toBe("succeeded");
    const versions = await prisma.projectVersion.findMany({ where: { projectId } });
    expect(versions.map((v) => v.semver).sort()).toEqual(["0.0.0", "0.0.1"]);
  }, 120_000);
});
