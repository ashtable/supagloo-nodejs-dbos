import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { DBOS, DBOSClient, type WorkflowHandle } from "@dbos-inc/dbos-sdk";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  type S3Client,
} from "@aws-sdk/client-s3";
import {
  buildAssetKey,
  createPrismaClient,
  encryptSecret,
} from "@supagloo/database-lib";
import { loadEnv, type Env } from "../../src/config/env";
import { launchDbos, shutdownDbos } from "../../src/dbos/runtime";
import { WORKFLOW_NAMES, WORKFLOW_QUEUE } from "../../src/dbos/registry";
import { makeInternalS3Client } from "../../src/files/s3-client";
import {
  __setGenerateVideoBoundaryHook,
  type GenerateVideoPayload,
  type GenerateVideoResult,
} from "../../src/workflows/generate-video";

// End-to-end proof of generateVideoClipWorkflow against the REAL openrouter-stub async video-job
// state machine + the REAL Compose MinIO (design-delta §7 workflow 8). DBOS is launched IN-PROCESS;
// the stub serves POST /api/v1/videos (202 pending, idempotent on the Idempotency-Key), the poll
// route driving pending → in_progress → completed, and the content/download routes serving fake MP4
// bytes. The workflow submits, durably-sleeps between polls (interval dropped to 50ms via env), then
// downloads + PUTs a real MP4 into MinIO under projects/{projectId}/assets/{generationId}. We read
// the object back from the HOST to prove the bytes landed.
//
// Two proofs: (1) happy path — clip completes into MinIO, one submit; (2) CRASH/REPLAY (the design's
// flagship recovery case) — park the workflow at the FIRST poll boundary (after submit committed
// providerJobId), cancel, resume → it completes exactly once and the stub's videoJobsCreated counter
// STAYS 1 (the submit step is memoized on replay, never re-issued).
//
// The in-process worker reaches MinIO via S3_ENDPOINT=localhost:9000 (host-reachable). Infra ensured
// by tests/e2e/global-setup.ts.

const OPENROUTER_STUB = process.env.OPENROUTER_STUB_URL ?? "http://localhost:4802";
const S3_PUBLIC = process.env.S3_PUBLIC_ENDPOINT ?? "http://localhost:9000";
const S3_BUCKET = process.env.S3_BUCKET ?? "supagloo-dev";
const ENCRYPTION_KEY = "0".repeat(64);

// MP4 magic (ftyp box) the stub serves as FAKE_MP4.
const FAKE_MP4 = Buffer.from([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70]);

const env: Env = loadEnv({
  DATABASE_URL:
    process.env.DATABASE_URL ?? "postgres://supagloo:supagloo@localhost:5432/supagloo",
  DBOS_DATABASE_URL:
    process.env.DBOS_DATABASE_URL ??
    "postgres://supagloo:supagloo@localhost:5432/supagloo_dbos",
  NODE_ENV: "test",
  // git-ops App vars are required at boot (unused by this workflow).
  GITHUB_APP_ID: "123456",
  GITHUB_APP_PRIVATE_KEY:
    "-----BEGIN RSA PRIVATE KEY-----\nx\n-----END RSA PRIVATE KEY-----",
  OPENROUTER_BASE_URL: OPENROUTER_STUB,
  SECRETS_ENCRYPTION_KEY: ENCRYPTION_KEY,
  // S3: the in-process worker uploads against the HOST-reachable public endpoint.
  S3_ENDPOINT: S3_PUBLIC,
  S3_PUBLIC_ENDPOINT: S3_PUBLIC,
  S3_BUCKET,
  S3_ACCESS_KEY: process.env.S3_ACCESS_KEY ?? "supagloo",
  S3_SECRET_KEY: process.env.S3_SECRET_KEY ?? "supagloo-dev",
  S3_REGION: process.env.S3_REGION ?? "us-east-1",
  // Tiny durable-sleep interval so the poll loop runs fast (prod default is 30s).
  VIDEO_POLL_INTERVAL_SECONDS: "0.05",
});

const prisma = createPrismaClient({ connectionString: env.DATABASE_URL });
let client: DBOSClient;
let s3: S3Client;

async function resetOpenRouter(): Promise<void> {
  await fetch(`${OPENROUTER_STUB}/__stub/reset`, { method: "POST" });
}

async function stubState(): Promise<Record<string, number>> {
  const res = await fetch(`${OPENROUTER_STUB}/__stub/calls`);
  return ((await res.json()) as { state: Record<string, number> }).state;
}

async function seedVideoGeneration(): Promise<{
  genId: string;
  projectId: string;
  payload: GenerateVideoPayload;
}> {
  const suffix = randomUUID().slice(0, 8);
  const user = await prisma.user.create({
    data: {
      youversionUserId: `yv-vid-${suffix}`,
      displayName: "Video E2E",
      email: `${suffix}@supagloo.test`,
      avatarInitials: "VE",
    },
  });
  await prisma.openRouterConnection.create({
    data: {
      userId: user.id,
      apiKeyCiphertext: encryptSecret("sk-or-test-key", ENCRYPTION_KEY),
      keyLast4: "tkey",
      status: "connected",
    },
  });
  const project = await prisma.project.create({
    data: {
      slug: `vid-${suffix}`,
      ownerId: user.id,
      name: `Video Project ${suffix}`,
      repoOwner: "ashtable",
      repoName: `vid-${suffix}`,
      repoVisibility: "private",
      createdFrom: "blank",
      currentBranch: "v0.0.1",
    },
  });
  const genId = `gen-vid-${suffix}`;
  await prisma.aiGeneration.create({
    data: {
      id: genId,
      userId: user.id,
      projectId: project.id,
      kind: "video",
      provider: "openrouter",
      model: "stub/video-model",
      status: "queued",
      input: { prompt: "a dove descends over still water", durationSeconds: 6, aspectRatio: "9:16" },
    },
  });
  return { genId, projectId: project.id, payload: { generationId: genId } };
}

async function readObject(key: string): Promise<Buffer> {
  const res = await s3.send(new GetObjectCommand({ Bucket: S3_BUCKET, Key: key }));
  const bytes = await res.Body!.transformToByteArray();
  return Buffer.from(bytes);
}

async function deleteObject(key: string): Promise<void> {
  await s3
    .send(new DeleteObjectCommand({ Bucket: S3_BUCKET, Key: key }))
    .catch(() => {});
}

async function enqueueVideo(
  genId: string,
  payload: GenerateVideoPayload,
): Promise<WorkflowHandle<GenerateVideoResult>> {
  return client.enqueue<GenerateVideoResult>(
    {
      workflowName: WORKFLOW_NAMES.generateVideo,
      queueName: WORKFLOW_QUEUE.generateVideo,
      workflowID: genId,
    },
    payload,
  );
}

async function waitForStatus(id: string, statuses: string[]): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const [wf] = await DBOS.listWorkflows({ workflowIDs: [id] });
    if (wf && statuses.includes(wf.status)) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`workflow ${id} did not reach ${statuses.join("/")} in time`);
}

beforeAll(async () => {
  await launchDbos(env);
  client = await DBOSClient.create({ systemDatabaseUrl: env.DBOS_DATABASE_URL });
  s3 = makeInternalS3Client({
    endpoint: S3_PUBLIC,
    region: env.S3_REGION,
    bucket: S3_BUCKET,
    accessKey: env.S3_ACCESS_KEY,
    secretKey: env.S3_SECRET_KEY,
  });
}, 120_000);

afterAll(async () => {
  __setGenerateVideoBoundaryHook(undefined);
  s3?.destroy();
  await client?.destroy().catch(() => {});
  await shutdownDbos();
  await prisma.$disconnect().catch(() => {});
});

beforeEach(async () => {
  __setGenerateVideoBoundaryHook(undefined);
  await resetOpenRouter();
});

describe("generateVideoClipWorkflow — lands a real mp4 in MinIO", () => {
  it("submits, polls to completion, downloads + uploads the mp4, records providerJobId + resultAssetKey", async () => {
    const { genId, projectId, payload } = await seedVideoGeneration();

    const handle = await enqueueVideo(genId, payload);
    const result = (await handle.getResult()) as GenerateVideoResult;
    expect(result.generationId).toBe(genId);
    expect(result.providerJobId).toMatch(/^vid_/);

    const expectedKey = buildAssetKey(projectId, genId);
    const row = await prisma.aiGeneration.findUniqueOrThrow({ where: { id: genId } });
    expect(row.status).toBe("succeeded");
    expect(row.completedAt).toBeInstanceOf(Date);
    // providerJobId was persisted (replay-safety column, design §2.8).
    expect(row.providerJobId).toMatch(/^vid_/);
    expect(row.resultAssetKey).toBe(expectedKey);
    expect(row.resultJson).toMatchObject({ kind: "video", providerJobId: row.providerJobId });

    // Exactly one video job was created (happy path, no retry/re-submit).
    expect((await stubState()).videoJobsCreated).toBe(1);

    // A REAL mp4 object exists in MinIO at the asset key, with the stub's FAKE_MP4 bytes.
    const bytes = await readObject(expectedKey);
    expect(bytes.subarray(0, 8)).toEqual(FAKE_MP4);

    await deleteObject(expectedKey);
  }, 120_000);
});

describe("generateVideoClipWorkflow — crash / replay (the flagship recovery case)", () => {
  it("cancels between submit and completion, resumes to completion, and NEVER re-submits (videoJobsCreated stays 1)", async () => {
    const { genId, projectId, payload } = await seedVideoGeneration();

    // Park at the FIRST poll boundary — after submitVideoJob has checkpointed + persisted
    // providerJobId, before any poll reaches `completed`.
    let release!: () => void;
    let parked = false;
    const reached = new Promise<void>((resolve) => {
      __setGenerateVideoBoundaryHook(async (label) => {
        if (label === "pollVideoJob" && !parked) {
          parked = true;
          resolve();
          await new Promise<void>((r) => {
            release = r;
          });
        }
      });
    });

    const handle = await enqueueVideo(genId, payload);
    const settled = handle.getResult().then(
      () => "ok",
      () => "interrupted",
    );

    await reached;
    // The submit step already committed the provider job id before we reached the poll boundary.
    const parkedRow = await prisma.aiGeneration.findUniqueOrThrow({ where: { id: genId } });
    expect(parkedRow.providerJobId).toMatch(/^vid_/);
    const submittedJobId = parkedRow.providerJobId;
    expect((await stubState()).videoJobsCreated).toBe(1);

    // Cancel preempts at the NEXT DBOS call (the poll runStep never executes on this attempt).
    await DBOS.cancelWorkflow(genId);
    release();
    await settled; // the cancelled run has fully unwound

    // Recover: resume from the last completed step (submitVideoJob). The submit is MEMOIZED, so it
    // is NOT re-issued — videoJobsCreated must stay 1.
    __setGenerateVideoBoundaryHook(undefined);
    await waitForStatus(genId, ["CANCELLED", "ERROR"]);
    const resumeHandle = await DBOS.resumeWorkflow<GenerateVideoResult>(genId);
    const result = (await resumeHandle.getResult()) as GenerateVideoResult;
    expect(result.generationId).toBe(genId);
    // Same job id as before the crash — polling RESUMED the existing job, did not start a new one.
    expect(result.providerJobId).toBe(submittedJobId);

    const expectedKey = buildAssetKey(projectId, genId);
    const row = await prisma.aiGeneration.findUniqueOrThrow({ where: { id: genId } });
    expect(row.status).toBe("succeeded");
    expect(row.providerJobId).toBe(submittedJobId);
    expect(row.resultAssetKey).toBe(expectedKey);

    // THE flagship assertion: exactly-once submit across the crash/replay.
    expect((await stubState()).videoJobsCreated).toBe(1);

    // The mp4 still landed in MinIO.
    const bytes = await readObject(expectedKey);
    expect(bytes.subarray(0, 8)).toEqual(FAKE_MP4);

    await deleteObject(expectedKey);
  }, 120_000);
});
