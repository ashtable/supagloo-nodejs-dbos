import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DBOS, DBOSClient } from "@dbos-inc/dbos-sdk";
import { createPrismaClient } from "@supagloo/database-lib";
import { loadEnv, type Env } from "../../src/config/env";
import { launchDbos, shutdownDbos } from "../../src/dbos/runtime";
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

// End-to-end proof of commitVersionWorkflow against the REAL provider-stub harness: the
// GitHub REST stub (:4801) mints the installation token, and the local git smart-HTTP
// server (:4805) serves a REAL clone/commit/push of the project's working branch. The
// DBOS runtime is launched IN-PROCESS (consuming the uncommitted db-lib via the file:
// dep). No mocks.
//
// The git-server admin route only seeds a README, so a realistic WORKING BRANCH (a full
// Remotion scaffold on a `v0.0.1` branch) is built IN-TEST with the host `git` CLI +
// task-16 writeRemotionScaffold. Commit then persists the 2-scene shelterManifest.
//
// Two proofs: (1) happy path — the working branch head ADVANCES by EXACTLY ONE commit,
// the regenerated scene sources are present, the working ProjectVersion is updated in
// place; (2) crash/replay — cancel after commitAndPush (before updateVersionRecord),
// delete the workspace (fresh worker), resume → completes with NO double-commit.

const GITHUB_STUB = process.env.GITHUB_STUB_URL ?? "http://localhost:4801";
const GIT_SERVER = process.env.GIT_SERVER_URL ?? "http://localhost:4805";
const INSTALLATION_ID = "42";
const BRANCH = "v0.0.1";
const SEMVER = "0.0.1";

const uniqueRepo = (base: string): string => `${base}-${randomUUID().slice(0, 8)}`;

const HERMETIC_GIT = {
  GIT_TERMINAL_PROMPT: "0",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_AUTHOR_NAME: "Commit Fixture",
  GIT_AUTHOR_EMAIL: "fixture@supagloo.test",
  GIT_COMMITTER_NAME: "Commit Fixture",
  GIT_COMMITTER_EMAIL: "fixture@supagloo.test",
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

function gitFixture(args: string[], cwd?: string): string {
  return execFileSync("git", args, {
    cwd,
    env: { ...process.env, ...HERMETIC_GIT },
  }).toString();
}

/** Build a REAL working branch on the origin: a full scaffold (empty manifest) on main +
 *  a `v0.0.1` branch. Returns the branch's seeded head SHA. */
async function seedWorkingBranch(fullName: string): Promise<string> {
  const work = mkdtempSync(join(tmpdir(), "commit-fixture-"));
  try {
    gitFixture(["clone", `${GIT_SERVER}/${fullName}.git`, work]);
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
  const out = execFileSync(
    "git",
    ["ls-remote", "--heads", `${GIT_SERVER}/${fullName}.git`, `refs/heads/${BRANCH}`],
    { env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } },
  ).toString();
  return out.split(/\s+/)[0];
}

/** Count of commits in `from..to`, resolved from a fresh full clone of the working branch. */
function commitsBetween(fullName: string, from: string, to: string): number {
  const verify = mkdtempSync(join(tmpdir(), "commit-verify-"));
  try {
    gitFixture(["clone", "--branch", BRANCH, `${GIT_SERVER}/${fullName}.git`, verify]);
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
    gitFixture(["clone", "--branch", BRANCH, `${GIT_SERVER}/${fullName}.git`, verify]);
    return existsSync(join(verify, "src/scenes", sceneFile));
  } finally {
    rmSync(verify, { recursive: true, force: true });
  }
}

async function seedCommitProjectJob(repoName: string): Promise<{
  projectId: string;
  jobId: string;
  payload: CommitVersionPayload;
}> {
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
      repoOwner: "acme",
      repoName,
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
    installationId: INSTALLATION_ID,
    repoOwner: "acme",
    repoName,
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
  await launchDbos(env);
  client = await DBOSClient.create({ systemDatabaseUrl: env.DBOS_DATABASE_URL });
}, 120_000);

afterAll(async () => {
  __setCommitBoundaryHook(undefined);
  await client?.destroy().catch(() => {});
  await shutdownDbos();
  await prisma.$disconnect().catch(() => {});
});

describe("commitVersionWorkflow — happy path", () => {
  it("commits the edited manifest: branch head advances by one commit, sources regenerated, version updated", async () => {
    await resetGithubStub();
    const repo = uniqueRepo("commit-happy");
    await provisionRepo(`acme/${repo}`);
    const seededHead = await seedWorkingBranch(`acme/${repo}`);
    const { projectId, jobId, payload } = await seedCommitProjectJob(repo);

    const handle = await client.enqueue<CommitVersionResult>(
      {
        workflowName: WORKFLOW_NAMES.commitVersion,
        queueName: WORKFLOW_QUEUE.commitVersion,
        workflowID: jobId,
      },
      payload,
    );
    const result = (await handle.getResult()) as CommitVersionResult;

    expect(result.workflowId).toBe(jobId);
    expect(result.committed).toBe(true);
    expect(result.version.branchName).toBe(BRANCH);
    expect(result.version.headCommitSha).toMatch(/^[0-9a-f]{40}$/);

    // The origin advanced to the recorded head by EXACTLY one commit (no double-commit).
    const newHead = branchHead(`acme/${repo}`);
    expect(newHead).toBe(result.version.headCommitSha);
    expect(newHead).not.toBe(seededHead);
    expect(commitsBetween(`acme/${repo}`, seededHead, newHead)).toBe(1);

    // The regenerated scene source for the manifest is present on the branch.
    expect(branchHasSceneSource(`acme/${repo}`, "Shelter.tsx")).toBe(true);

    // Token minted; commit performs no PR open/merge.
    const state = await githubState();
    expect(state.installationTokensIssued).toBeGreaterThanOrEqual(1);

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
    await resetGithubStub();
    const repo = uniqueRepo("commit-replay");
    await provisionRepo(`acme/${repo}`);
    const seededHead = await seedWorkingBranch(`acme/${repo}`);
    const { projectId, jobId, payload } = await seedCommitProjectJob(repo);

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
    const newHead = branchHead(`acme/${repo}`);
    expect(commitsBetween(`acme/${repo}`, seededHead, newHead)).toBe(1);

    // Exactly-once: one token minted (the completed mint step was not re-run on resume).
    const state = await githubState();
    expect(state.installationTokensIssued).toBe(1);

    // The working version is updated once; still exactly one version.
    const versions = await prisma.projectVersion.findMany({ where: { projectId } });
    expect(versions).toHaveLength(1);
    expect(versions[0].headCommitSha).toBe(newHead);
    const job = await prisma.projectJob.findUniqueOrThrow({ where: { id: jobId } });
    expect(job.status).toBe("succeeded");
  }, 150_000);
});
