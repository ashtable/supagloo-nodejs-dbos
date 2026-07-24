import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { DBOS, DBOSClient } from "@dbos-inc/dbos-sdk";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  type S3Client,
} from "@aws-sdk/client-s3";
import { buildAssetKey, createPrismaClient } from "@supagloo/database-lib";
import { loadEnv, type Env } from "../../src/config/env";
import { launchDbos, shutdownDbos } from "../../src/dbos/runtime";
import { WORKFLOW_NAMES, WORKFLOW_QUEUE } from "../../src/dbos/registry";
import { makeInternalS3Client } from "../../src/files/s3-client";
import {
  resolveGenerationSeedCreds,
  seedOpenRouterConnection,
  type GenerationSeedCreds,
} from "../../src/testing/seed-connections";
import {
  resolveVideoModel,
  type ResolvedVideoModel,
} from "../../src/testing/e2e-models";
import { countStepExecutions } from "../../src/testing/step-introspection";
import { isProviderJobIdStable } from "../../src/testing/provider-job-id-stability";
import { __setGenerateVideoBoundaryHook } from "../../src/workflows/generate-video";
import type {
  GenerateVideoPayload,
  GenerateVideoResult,
} from "../../src/workflows/generate-video";

// End-to-end proof of generateVideoClipWorkflow against the REAL OpenRouter video-job host +
// the REAL Compose MinIO (design-delta §7 workflow 8, §10.2/§10.3/§10.7/§10.9). DBOS is
// launched IN-PROCESS; the workflow resolves a live video model, submits the async job,
// durably-sleeps between real polls through pending → completed, downloads the content bytes,
// and PUTs a real object into MinIO under projects/{projectId}/assets/{generationId}. We read
// the object back from the HOST to prove the bytes landed.
//
// Real-provider seeding (§10.3): OpenRouter connection seeded via `seedOpenRouterConnection`
// with the real OPENROUTER_E2E_TEST_API_KEY; model id resolved via discovery (§10.9). The
// exactly-once-submit fact is proven structurally via the DBOS system-DB step count
// (`submitVideoJob` executed once) — replacing the stub's videoJobsCreated counter (§10.7).
// The asset assertion is "non-empty bytes in MinIO" (no FAKE_MP4 magic-byte literal), and the
// provider job id is asserted to be a non-empty string (no `vid_` stub-prefix literal).
//
// The separate CRASH/REPLAY proof (park at the first poll boundary → cancel → resume →
// exactly-once submit across recovery) is DEFERRED to task 34-E7, which reworks it against the
// real host using the shared system-DB step-introspection helper introduced here. It is a
// visible `it.todo` below rather than a silently-broken stub-dependent block.
//
// Real video generation is minutes-long: the poll interval + attempt ceiling + test timeout
// are set for a REAL job (not the sub-second stub cadence), and the input is minimized
// (durationSeconds: 1) per the §10.9 cost mitigation.

const S3_PUBLIC = process.env.S3_PUBLIC_ENDPOINT ?? "http://localhost:9000";
const S3_BUCKET = process.env.S3_BUCKET ?? "supagloo-dev";
const ENCRYPTION_KEY = "0".repeat(64);

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
  OPENROUTER_BASE_URL: process.env.OPENROUTER_BASE_URL,
  SECRETS_ENCRYPTION_KEY: ENCRYPTION_KEY,
  // S3: the in-process worker uploads against the HOST-reachable public endpoint.
  S3_ENDPOINT: S3_PUBLIC,
  S3_PUBLIC_ENDPOINT: S3_PUBLIC,
  S3_BUCKET,
  S3_ACCESS_KEY: process.env.S3_ACCESS_KEY ?? "supagloo",
  S3_SECRET_KEY: process.env.S3_SECRET_KEY ?? "supagloo-dev",
  S3_REGION: process.env.S3_REGION ?? "us-east-1",
  // Real video jobs take minutes — poll every ~10s up to a ~10-minute ceiling (overridable).
  VIDEO_POLL_INTERVAL_SECONDS: process.env.VIDEO_POLL_INTERVAL_SECONDS ?? "10",
  VIDEO_MAX_POLL_ATTEMPTS: process.env.VIDEO_MAX_POLL_ATTEMPTS ?? "60",
});

// Generous ceiling for a real end-to-end video generation (submit + poll + download + upload).
const VIDEO_TEST_TIMEOUT_MS = 600_000;

const prisma = createPrismaClient({ connectionString: env.DATABASE_URL });
let client: DBOSClient;
let s3: S3Client;
let creds: GenerationSeedCreds;
let videoModel: ResolvedVideoModel;

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
  await seedOpenRouterConnection({
    prisma,
    userId: user.id,
    apiKey: creds.openrouterKey,
    encryptionKey: ENCRYPTION_KEY,
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
      model: videoModel.id,
      status: "queued",
      // Prompt + the model's SMALLEST supported duration only (§10.9 cost mitigation). No
      // aspectRatio: it is not a universal video-submit param on real OpenRouter (e.g. grok
      // reports supported_aspect_ratios: null), and an unsupported param risks a 400.
      input: {
        prompt: "a dove descends over still water",
        durationSeconds: videoModel.minDurationSeconds,
      },
    },
  });
  return { genId, projectId: project.id, payload: { generationId: genId } };
}

async function readObject(key: string): Promise<Buffer> {
  const res = await s3.send(new GetObjectCommand({ Bucket: S3_BUCKET, Key: key }));
  const bytes = await res.Body!.transformToByteArray();
  return Buffer.from(bytes);
}

// Per-file crash/replay helper (the established convention — no shared module; mirrors
// generate-script.e2e.ts): poll the DBOS system DB until the cancelled workflow settles, so the
// resume in the test lands after the interruption is durably recorded.
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
  creds = resolveGenerationSeedCreds();
  await launchDbos(env);
  client = await DBOSClient.create({ systemDatabaseUrl: env.DBOS_DATABASE_URL });
  s3 = makeInternalS3Client({
    endpoint: S3_PUBLIC,
    region: env.S3_REGION,
    bucket: S3_BUCKET,
    accessKey: env.S3_ACCESS_KEY,
    secretKey: env.S3_SECRET_KEY,
  });
  videoModel = await resolveVideoModel(env);
}, 120_000);

afterAll(async () => {
  __setGenerateVideoBoundaryHook(undefined);
  s3?.destroy();
  await client?.destroy().catch(() => {});
  await shutdownDbos();
  await prisma.$disconnect().catch(() => {});
});

describe("generateVideoClipWorkflow — lands a real mp4 in MinIO", () => {
  it(
    "submits, polls to completion, downloads + uploads the clip, records providerJobId + resultAssetKey",
    async () => {
      const { genId, projectId, payload } = await seedVideoGeneration();

      const handle = await client.enqueue<GenerateVideoResult>(
        {
          workflowName: WORKFLOW_NAMES.generateVideo,
          queueName: WORKFLOW_QUEUE.generateVideo,
          workflowID: genId,
        },
        payload,
      );
      const result = (await handle.getResult()) as GenerateVideoResult;
      expect(result.generationId).toBe(genId);
      expect(typeof result.providerJobId).toBe("string");
      expect(result.providerJobId.length).toBeGreaterThan(0);

      const expectedKey = buildAssetKey(projectId, genId);
      const row = await prisma.aiGeneration.findUniqueOrThrow({ where: { id: genId } });
      expect(row.status).toBe("succeeded");
      expect(row.completedAt).toBeInstanceOf(Date);
      // providerJobId was persisted (replay-safety column, design §2.8) — non-empty, no stub prefix.
      expect(row.providerJobId).toBe(result.providerJobId);
      expect(row.resultAssetKey).toBe(expectedKey);
      expect(row.resultJson).toMatchObject({ kind: "video", providerJobId: row.providerJobId });

      // Exactly one video job was submitted (happy path) — proven structurally via the DBOS
      // system-DB step count (replaces the stub's videoJobsCreated counter, §10.7).
      expect(await countStepExecutions(client, genId, "submitVideoJob")).toBe(1);

      // A REAL mp4 object exists in MinIO at the asset key, with non-empty provider bytes.
      const bytes = await readObject(expectedKey);
      expect(bytes.length).toBeGreaterThan(0);

      await s3
        .send(new DeleteObjectCommand({ Bucket: S3_BUCKET, Key: expectedKey }))
        .catch(() => {});
    },
    VIDEO_TEST_TIMEOUT_MS,
  );
});

describe("generateVideoClipWorkflow — crash / replay (the flagship recovery case)", () => {
  // Reworked in 34-E7 (design-delta §10.5): the flagship recovery proof, HOST-INTROSPECTION-FREE.
  // Park at the FIRST pollVideoJob boundary (submit committed providerJobId, polling not yet
  // completed — the #34 crash window) → "kill the worker" (the in-process cancel idiom every
  // crash/replay e2e in this repo uses; NOT a child_process kill) → "restart" (DBOS recovery via
  // resumeWorkflow) → run to completion against REAL generation latency. Two assertions replace
  // the retired openrouter-stub videoJobsCreated counter (§10.7):
  //   (1) providerJobId STABILITY — the final row carries the SAME id captured pre-crash (the
  //       memoized submit step replayed, never re-issued), and the clip was downloaded from it; and
  //   (2) EXACTLY ONE recorded submitVideoJob step execution in the DBOS system DB for this
  //       workflowID, both before AND after recovery (`countStepExecutions`, §10.5).
  // ACCEPTED (not tested, task brief / §10.5): the sub-second window between the real submit HTTP
  // succeeding and the step checkpoint committing is unprovable without provider introspection; the
  // Idempotency-Key header is unverified defense-in-depth, not asserted on.
  it(
    "cancels between submit and completion, resumes with the SAME providerJobId, and NEVER re-submits",
    async () => {
      const { genId, projectId, payload } = await seedVideoGeneration();

      // Park at the FIRST pollVideoJob boundary. The `parked` guard makes only the first fire
      // block; all other labels (loadRequestAndCredentials, submitVideoJob, …) are no-ops. Because
      // the first fire blocks, the workflow never reaches a second poll in the pre-crash run.
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

      const handle = await client.enqueue<GenerateVideoResult>(
        {
          workflowName: WORKFLOW_NAMES.generateVideo,
          queueName: WORKFLOW_QUEUE.generateVideo,
          workflowID: genId,
        },
        payload,
      );
      const settled = handle.getResult().then(
        () => "ok",
        () => "interrupted",
      );

      await reached;
      // Submit has committed. Capture the pre-crash providerJobId + assert exactly one submit step.
      const preRow = await prisma.aiGeneration.findUniqueOrThrow({ where: { id: genId } });
      const capturedJobId = preRow.providerJobId;
      expect(typeof capturedJobId).toBe("string");
      expect((capturedJobId ?? "").length).toBeGreaterThan(0);
      expect(await countStepExecutions(client, genId, "submitVideoJob")).toBe(1);

      // Kill the worker (figurative, in-process): cancel, release the hook, await the interruption.
      await DBOS.cancelWorkflow(genId);
      release();
      const outcome = await settled;
      expect(outcome).toBe("interrupted");

      // Restart the worker → DBOS recovery. Clear the hook so the resumed run polls to completion.
      __setGenerateVideoBoundaryHook(undefined);
      await waitForStatus(genId, ["CANCELLED", "ERROR"]);
      const resumeHandle = await DBOS.resumeWorkflow<GenerateVideoResult>(genId);
      const result = (await resumeHandle.getResult()) as GenerateVideoResult;

      // §10.5 assertion 1 — providerJobId STABLE across the crash (the memoized submit replayed).
      const row = await prisma.aiGeneration.findUniqueOrThrow({ where: { id: genId } });
      expect(row.status).toBe("succeeded");
      expect(row.completedAt).toBeInstanceOf(Date);
      expect(row.providerJobId).toBe(capturedJobId);
      expect(isProviderJobIdStable(capturedJobId, row.providerJobId)).toBe(true);
      expect(result.providerJobId).toBe(capturedJobId);

      // §10.5 assertion 2 — STILL exactly one recorded submitVideoJob execution after recovery.
      expect(await countStepExecutions(client, genId, "submitVideoJob")).toBe(1);

      // The clip completed into MinIO, downloaded from THAT job (non-empty bytes at the asset key).
      const expectedKey = buildAssetKey(projectId, genId);
      expect(row.resultAssetKey).toBe(expectedKey);
      const bytes = await readObject(expectedKey);
      expect(bytes.length).toBeGreaterThan(0);

      await s3
        .send(new DeleteObjectCommand({ Bucket: S3_BUCKET, Key: expectedKey }))
        .catch(() => {});
    },
    VIDEO_TEST_TIMEOUT_MS,
  );
});
