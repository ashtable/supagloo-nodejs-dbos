import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
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

// End-to-end proof of publishVersionWorkflow against the REAL provider-stub harness: the
// GitHub REST stub (:4801) mints the installation token, opens + merges the PR, and creates
// the release tag; the local git smart-HTTP server (:4805) serves a REAL clone/push. DBOS is
// launched IN-PROCESS (consuming the uncommitted db-lib via the file: dep). No mocks.
//
// A realistic WORKING BRANCH (a full Remotion scaffold on `main` + a `v0.0.1` branch) is
// built IN-TEST with the host git CLI + task-16 writeRemotionScaffold — the git-server admin
// route only seeds a README. Publish then merges v0.0.1 → main, tags v0.0.1, and cuts v0.0.2.
//
// Two proofs: (1) happy path — the PR is opened/merged, the release tag + next branch (v0.0.2)
// exist, and the ProjectVersion states flip (working 0.0.1 → published, new working 0.0.2);
// (2) crash/replay MID-MERGE — cancel at the mergePullRequestAndTag boundary (after
// openPullRequest checkpointed), delete the workspace (fresh worker), resume → completes with
// NO duplicate PR (pullsOpened stays 1).

const GITHUB_STUB = process.env.GITHUB_STUB_URL ?? "http://localhost:4801";
const GIT_SERVER = process.env.GIT_SERVER_URL ?? "http://localhost:4805";
const INSTALLATION_ID = "42";
const BRANCH = "v0.0.1";
const SEMVER = "0.0.1";
const NEXT_BRANCH = "v0.0.2";
const NEXT_SEMVER = "0.0.2";

const uniqueRepo = (base: string): string => `${base}-${randomUUID().slice(0, 8)}`;

const HERMETIC_GIT = {
  GIT_TERMINAL_PROMPT: "0",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_AUTHOR_NAME: "Publish Fixture",
  GIT_AUTHOR_EMAIL: "fixture@supagloo.test",
  GIT_COMMITTER_NAME: "Publish Fixture",
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

function gitFixture(args: string[], cwd?: string): string {
  return execFileSync("git", args, {
    cwd,
    env: { ...process.env, ...HERMETIC_GIT },
  }).toString();
}

/** Build a REAL working branch on the origin: a full scaffold (empty manifest) on main +
 *  a `v0.0.1` branch. */
async function seedWorkingBranch(fullName: string): Promise<void> {
  const work = mkdtempSync(join(tmpdir(), "publish-fixture-"));
  try {
    gitFixture(["clone", `${GIT_SERVER}/${fullName}.git`, work]);
    await writeRemotionScaffold(emptyManifest, work);
    gitFixture(["add", "-A"], work);
    gitFixture(["commit", "-m", "supagloo scaffold"], work);
    gitFixture(["push", "origin", "main"], work);
    gitFixture(["branch", BRANCH], work);
    gitFixture(["push", "origin", BRANCH], work);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/** The origin's head SHA for `branch` (via ls-remote), or "" if the ref is absent. */
function branchHead(fullName: string, branch: string): string {
  const out = execFileSync(
    "git",
    ["ls-remote", "--heads", `${GIT_SERVER}/${fullName}.git`, `refs/heads/${branch}`],
    { env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } },
  ).toString();
  return out.split(/\s+/)[0] ?? "";
}

async function seedPublishProjectJob(repoName: string): Promise<{
  projectId: string;
  jobId: string;
  payload: PublishVersionPayload;
}> {
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
      repoOwner: "acme",
      repoName,
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
    installationId: INSTALLATION_ID,
    repoOwner: "acme",
    repoName,
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
    await resetGithubStub();
    const repo = uniqueRepo("publish-happy");
    await provisionRepo(`acme/${repo}`);
    await seedWorkingBranch(`acme/${repo}`);
    const { projectId, jobId, payload } = await seedPublishProjectJob(repo);

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
    const nextHead = branchHead(`acme/${repo}`, NEXT_BRANCH);
    expect(nextHead).toMatch(/^[0-9a-f]{40}$/);
    expect(nextHead).toBe(result.next.headCommitSha);

    // The GitHub REST side effects happened: token minted, PR opened + merged, tag created.
    const state = await githubState();
    expect(state.installationTokensIssued).toBeGreaterThanOrEqual(1);
    expect(state.pullsOpened).toBeGreaterThanOrEqual(1);
    expect(state.pullsMerged).toBeGreaterThanOrEqual(1);
    expect(state.refsCreated).toBeGreaterThanOrEqual(1);

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
    await resetGithubStub();
    const repo = uniqueRepo("publish-replay");
    await provisionRepo(`acme/${repo}`);
    await seedWorkingBranch(`acme/${repo}`);
    const { projectId, jobId, payload } = await seedPublishProjectJob(repo);

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

    // The crux: the PR was opened exactly ONCE across both attempts. openPullRequest was
    // checkpointed on attempt 1 and skipped on resume — no duplicate PR.
    const state = await githubState();
    expect(state.pullsOpened).toBe(1);
    expect(state.pullsMerged).toBe(1);
    expect(state.refsCreated).toBe(1);
    // Exactly-once: one token minted (the completed mint step was not re-run on resume).
    expect(state.installationTokensIssued).toBe(1);

    // The publish completed: next branch exists, versions flipped, project advanced.
    expect(branchHead(`acme/${repo}`, NEXT_BRANCH)).toMatch(/^[0-9a-f]{40}$/);
    const versions = await prisma.projectVersion.findMany({ where: { projectId } });
    expect(versions.find((v) => v.semver === SEMVER)!.state).toBe("published");
    expect(versions.find((v) => v.semver === NEXT_SEMVER)!.state).toBe("working");
    const project = await prisma.project.findUniqueOrThrow({ where: { id: projectId } });
    expect(project.currentBranch).toBe(NEXT_BRANCH);
    const job = await prisma.projectJob.findUniqueOrThrow({ where: { id: jobId } });
    expect(job.status).toBe("succeeded");
  }, 150_000);
});
