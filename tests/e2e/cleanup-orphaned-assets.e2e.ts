import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { DBOSClient } from "@dbos-inc/dbos-sdk";
import {
  GetObjectCommand,
  PutObjectCommand,
  type S3Client,
} from "@aws-sdk/client-s3";
import {
  buildAssetKey,
  buildRenderOutputKey,
  buildRenderThumbnailKey,
  createPrismaClient,
} from "@supagloo/database-lib";
import { loadEnv } from "../../src/config/env";
import { TEST_SECRETS_ENCRYPTION_KEY } from "../../src/testing/secrets-fixture";
import { launchDbos, shutdownDbos } from "../../src/dbos/runtime";
import {
  assertLaneRuntimeIsolated,
  assertWorkflowIsolated,
  laneSystemSchema,
  resetLaneSchema,
} from "../../src/testing/dbos-lane-isolation";
import { WORKFLOW_NAMES, WORKFLOW_QUEUE } from "../../src/dbos/registry";
import { makeInternalS3Client } from "../../src/files/s3-client";
import { countStepExecutions } from "../../src/testing/step-introspection";
import type { CleanupOrphanedAssetsResult } from "../../src/workflows/cleanup-orphaned-assets";

/**
 * Plan row 42 — `cleanupOrphanedAssetsWorkflow`, end to end against the real Compose
 * Postgres and the real MinIO bucket. The row's E2E column, verbatim: "seed orphaned MinIO
 * objects + job rows and expired + live Session rows, trigger the workflow directly:
 * exactly the target objects deleted and only expired sessions purged, live assets and
 * live sessions untouched."
 *
 * WHY THIS IS THE ONE ROW IN ITS RUN GRANTED A NEW LANE. A new e2e spec costs a lane
 * schema, and the standing rule for this run is to fold new assertions into existing specs.
 * This row is the exception: it SEEDS AND DELETES objects in the shared `supagloo-dev`
 * bucket, and those deletions must not be interleaved with another spec's assertions about
 * its own objects in the same file. Lane: `dbos_e2e_dbos_cleanup` — the FIFTEENTH. (The
 * root repo's `docs/current-design.md` §5.4 item 9 enumeration and lane-drift test must be
 * updated to match; that handoff is recorded in
 * `scratch/task-42-cleanup-orphaned-assets.md`.)
 *
 * WHAT THIS SPEC DELIBERATELY DOES NOT DO. It does not shorten the retention window. The
 * seeded orphans are dated ~400 hours in the past instead, so the sweep runs with the REAL
 * shipped default (168 h) and the test proves the shipped configuration rather than a
 * test-only one. That also bounds the blast radius on shared state: nothing another lane
 * created seconds ago can be in scope, by days.
 *
 * SHARED-STATE HONESTY. The workflow is global by design — it sweeps the whole app
 * database, exactly as the Compose container's nightly run does. Two consequences are
 * accepted rather than engineered around: (1) genuinely week-old failed/canceled render
 * objects belonging to earlier runs will also be deleted, which is the point of the row;
 * (2) `Session` rows are purged on `expiresAt` with no window at all, so any already-EXPIRED
 * session in the dev database goes. Live sessions are never touched, which is the property
 * that matters and which this spec asserts directly.
 */

const SYSTEM_SCHEMA = laneSystemSchema("dbos_cleanup");

// The in-process worker reaches MinIO on the HOST-reachable endpoint (the containerised
// worker uses `minio:9000`; from a vitest process on the host that name does not resolve).
const S3_PUBLIC = process.env.S3_PUBLIC_ENDPOINT ?? "http://localhost:9000";
const S3_BUCKET = process.env.S3_BUCKET ?? "supagloo-dev";

const env = loadEnv({
  ...process.env,
  DATABASE_URL:
    process.env.DATABASE_URL ?? "postgres://supagloo:supagloo@localhost:5432/supagloo",
  DBOS_DATABASE_URL:
    process.env.DBOS_DATABASE_URL ??
    "postgres://supagloo:supagloo@localhost:5432/supagloo_dbos",
  DBOS_SYSTEM_DATABASE_SCHEMA: SYSTEM_SCHEMA,
  NODE_ENV: "test",
  // Required at boot but unused by this workflow — it touches no GitHub and decrypts
  // nothing. Real values are not needed; well-formed ones are.
  GITHUB_APP_ID: process.env.GITHUB_APP_ID ?? "123456",
  GITHUB_APP_PRIVATE_KEY:
    process.env.GITHUB_APP_PRIVATE_KEY ??
    "-----BEGIN RSA PRIVATE KEY-----\nunused\n-----END RSA PRIVATE KEY-----",
  SECRETS_ENCRYPTION_KEY: TEST_SECRETS_ENCRYPTION_KEY,
  S3_ENDPOINT: S3_PUBLIC,
  S3_BUCKET,
  S3_ACCESS_KEY: process.env.S3_ACCESS_KEY ?? "supagloo",
  S3_SECRET_KEY: process.env.S3_SECRET_KEY ?? "supagloo-dev",
});

const prisma = createPrismaClient({ connectionString: env.DATABASE_URL });
let client: DBOSClient;
let s3: S3Client;

const HOUR = 3_600_000;
/** Comfortably past the shipped 168-hour default, without being absurd. */
const ANCIENT = new Date(Date.now() - 400 * HOUR);
const RECENT = new Date(Date.now() - 1 * HOUR);

const runId = randomUUID().slice(0, 8);

interface Seeded {
  userId: string;
  projectId: string;
  versionId: string;
  failedId: string;
  canceledId: string;
  succeededId: string;
  freshId: string;
  generationId: string;
  expiredSessionId: string;
  liveSessionId: string;
}

async function putObject(key: string): Promise<void> {
  await s3.send(
    new PutObjectCommand({
      Bucket: S3_BUCKET,
      Key: key,
      Body: Buffer.from(`cleanup-e2e ${runId} ${key}`),
    }),
  );
}

async function objectExists(key: string): Promise<boolean> {
  try {
    const res = await s3.send(new GetObjectCommand({ Bucket: S3_BUCKET, Key: key }));
    await res.Body!.transformToByteArray();
    return true;
  } catch {
    return false;
  }
}

async function seed(): Promise<Seeded> {
  const user = await prisma.user.create({
    data: {
      youversionUserId: `yv-cleanup-${runId}`,
      displayName: "Cleanup E2E",
      email: `cleanup-${runId}@supagloo.test`,
      avatarInitials: "CE",
    },
  });
  const project = await prisma.project.create({
    data: {
      slug: `cleanup-${runId}`,
      ownerId: user.id,
      name: `Cleanup ${runId}`,
      repoOwner: "ashtable",
      repoName: `cleanup-${runId}`,
      repoVisibility: "private",
      createdFrom: "blank",
      currentBranch: "v0.0.1",
    },
  });
  const version = await prisma.projectVersion.create({
    data: {
      projectId: project.id,
      semver: "0.0.1",
      branchName: "v0.0.1",
      state: "working",
      changedFiles: [],
    },
  });

  const ids = {
    failedId: `cleanup-failed-${runId}`,
    canceledId: `cleanup-canceled-${runId}`,
    succeededId: `cleanup-completed-${runId}`,
    freshId: `cleanup-fresh-${runId}`,
    generationId: `cleanup-gen-${runId}`,
  };

  const renderBase = {
    projectId: project.id,
    versionId: version.id,
    userId: user.id,
    width: 1080,
    height: 1920,
    fps: 30,
    aspectRatio: "9:16",
    codec: "h264",
    runInBackground: false,
  };

  await prisma.renderJob.createMany({
    data: [
      // (1) The plain orphan: failed, ancient, asset-key columns NULL — which is the whole
      //     reason selection cannot go by column and must go by the key family.
      {
        ...renderBase,
        id: ids.failedId,
        status: "failed",
        createdAt: ANCIENT,
        completedAt: ANCIENT,
        error: "seeded failure",
      },
      // (2) Canceled + ancient, but its thumbnail is referenced by the Project below.
      {
        ...renderBase,
        id: ids.canceledId,
        status: "canceled",
        createdAt: ANCIENT,
        completedAt: ANCIENT,
      },
      // (3) Succeeded + ancient. Never in scope, however old — its objects back the
      //     gallery's stream-url presign.
      {
        ...renderBase,
        id: ids.succeededId,
        // `RenderStatus`'s terminal success is `completed` (JobStatus, which AiGeneration
        // uses, spells it `succeeded` — the two enums are NOT the same).
        status: "completed",
        createdAt: ANCIENT,
        completedAt: ANCIENT,
        outputAssetKey: buildRenderOutputKey(ids.succeededId),
        thumbnailAssetKey: buildRenderThumbnailKey(ids.succeededId),
      },
      // (4) Failed but FRESH — inside the retention window, so untouched.
      {
        ...renderBase,
        id: ids.freshId,
        status: "failed",
        createdAt: RECENT,
        completedAt: RECENT,
      },
    ],
  });

  // The canceled render's thumbnail is now the project's card image (design-delta
  // §2.6:228). Status alone would delete it and blank a live project.
  await prisma.project.update({
    where: { id: project.id },
    data: { thumbnailAssetKey: buildRenderThumbnailKey(ids.canceledId) },
  });

  await prisma.aiGeneration.create({
    data: {
      id: ids.generationId,
      userId: user.id,
      projectId: project.id,
      kind: "image",
      provider: "openrouter",
      model: "seeded/for-cleanup",
      status: "failed",
      input: { prompt: "seeded" },
      createdAt: ANCIENT,
      completedAt: ANCIENT,
      error: "seeded failure",
    },
  });

  const expiredSession = await prisma.session.create({
    data: {
      userId: user.id,
      tokenHash: `cleanup-expired-${runId}`,
      // Sessions are SLIDING, so the only thing that may decide is expiresAt. This one is
      // ancient in every column.
      expiresAt: ANCIENT,
      createdAt: ANCIENT,
      lastUsedAt: ANCIENT,
    },
  });
  const liveSession = await prisma.session.create({
    data: {
      userId: user.id,
      tokenHash: `cleanup-live-${runId}`,
      // Ancient createdAt/lastUsedAt but a FUTURE expiresAt: the exact shape a purge keyed
      // on the wrong column would destroy, and an active user in production.
      expiresAt: new Date(Date.now() + 24 * HOUR),
      createdAt: ANCIENT,
      lastUsedAt: ANCIENT,
    },
  });

  // Objects for every render, plus the generation's asset.
  await Promise.all([
    putObject(buildRenderOutputKey(ids.failedId)),
    putObject(buildRenderThumbnailKey(ids.failedId)),
    putObject(buildRenderOutputKey(ids.canceledId)),
    putObject(buildRenderThumbnailKey(ids.canceledId)),
    putObject(buildRenderOutputKey(ids.succeededId)),
    putObject(buildRenderThumbnailKey(ids.succeededId)),
    putObject(buildRenderOutputKey(ids.freshId)),
    putObject(buildRenderThumbnailKey(ids.freshId)),
    putObject(buildAssetKey(project.id, ids.generationId)),
  ]);

  return {
    userId: user.id,
    projectId: project.id,
    versionId: version.id,
    ...ids,
    expiredSessionId: expiredSession.id,
    liveSessionId: liveSession.id,
  };
}

let seeded: Seeded;
let result: CleanupOrphanedAssetsResult;

beforeAll(async () => {
  await resetLaneSchema({
    systemDatabaseUrl: env.DBOS_DATABASE_URL,
    schema: SYSTEM_SCHEMA,
  });
  await launchDbos(env);
  await assertLaneRuntimeIsolated({
    systemDatabaseUrl: env.DBOS_DATABASE_URL,
    schema: SYSTEM_SCHEMA,
  });
  client = await DBOSClient.create({
    systemDatabaseUrl: env.DBOS_DATABASE_URL,
    systemDatabaseSchemaName: SYSTEM_SCHEMA,
  });
  s3 = makeInternalS3Client({
    endpoint: S3_PUBLIC,
    region: env.S3_REGION,
    bucket: S3_BUCKET,
    accessKey: env.S3_ACCESS_KEY,
    secretKey: env.S3_SECRET_KEY,
  });

  seeded = await seed();

  const workflowID = `cleanup-run-${runId}`;
  const handle = await client.enqueue<CleanupOrphanedAssetsResult>(
    {
      workflowName: WORKFLOW_NAMES.cleanupOrphanedAssets,
      queueName: WORKFLOW_QUEUE.cleanupOrphanedAssets,
      workflowID,
    },
    new Date(),
    new Date(),
  );
  // The CLIENT half of lane isolation, folded into the enqueue this spec already makes:
  // without it the row lands in the shared schema, the Compose container executes THIS
  // destructive workflow, and every assertion below would still pass — having proven the
  // container works rather than this process.
  await assertWorkflowIsolated({
    systemDatabaseUrl: env.DBOS_DATABASE_URL,
    schema: SYSTEM_SCHEMA,
    workflowID,
  });
  result = (await handle.getResult()) as CleanupOrphanedAssetsResult;

  // Every step ran exactly once — the sweep is not silently short-circuiting.
  for (const step of [
    "selectOrphanCandidates",
    "listOrphanObjects",
    "deleteOrphanObjects",
    "purgeExpiredSessions",
  ]) {
    expect(await countStepExecutions(client, workflowID, step)).toBe(1);
  }
}, 180_000);

afterAll(async () => {
  s3?.destroy();
  await client?.destroy().catch(() => {});
  await shutdownDbos();
  await prisma.$disconnect().catch(() => {});
});

describe("lane isolation", () => {
  it("E-CL0: this lane runs on its own DBOS system schema, so the Compose worker cannot see its work", async () => {
    expect(SYSTEM_SCHEMA).not.toBe("dbos");
    await assertLaneRuntimeIsolated({
      systemDatabaseUrl: env.DBOS_DATABASE_URL,
      schema: SYSTEM_SCHEMA,
    });
  });
});

describe("cleanupOrphanedAssetsWorkflow — objects", () => {
  it("E-CL1: deletes BOTH objects of an ancient FAILED render", async () => {
    expect(await objectExists(buildRenderOutputKey(seeded.failedId))).toBe(false);
    expect(await objectExists(buildRenderThumbnailKey(seeded.failedId))).toBe(false);
    expect(result.deletedKeys).toContain(buildRenderOutputKey(seeded.failedId));
  });

  it("E-CL2: deletes an ancient CANCELED render's output but SPARES the thumbnail a live Project points at", async () => {
    expect(await objectExists(buildRenderOutputKey(seeded.canceledId))).toBe(false);
    // The referenced-key exclusion, proven on real rows and real objects.
    expect(await objectExists(buildRenderThumbnailKey(seeded.canceledId))).toBe(true);
    expect(result.deletedKeys).not.toContain(buildRenderThumbnailKey(seeded.canceledId));
  });

  it("E-CL3: never touches a COMPLETED render's objects, however ancient", async () => {
    expect(await objectExists(buildRenderOutputKey(seeded.succeededId))).toBe(true);
    expect(await objectExists(buildRenderThumbnailKey(seeded.succeededId))).toBe(true);
  });

  it("E-CL4: leaves a FAILED render that is still inside the retention window alone", async () => {
    // This is the property that keeps the container's nightly run off freshly-seeded
    // fixtures in every other lane.
    expect(await objectExists(buildRenderOutputKey(seeded.freshId))).toBe(true);
    expect(await objectExists(buildRenderThumbnailKey(seeded.freshId))).toBe(true);
  });

  it("E-CL5: deletes an ancient FAILED generation's project asset", async () => {
    const key = buildAssetKey(seeded.projectId, seeded.generationId);
    expect(await objectExists(key)).toBe(false);
    expect(result.deletedKeys).toContain(key);
  });

  it("E-CL6: reports what it planned and what it removed, and hits no per-key S3 errors", () => {
    expect(result.dryRun).toBe(false);
    expect(result.deleteErrors).toEqual([]);
    expect(result.deletedKeys.length).toBeGreaterThanOrEqual(4);
    // Everything it planned, it removed.
    expect([...result.plannedKeys].sort()).toEqual([...result.deletedKeys].sort());
  });
});

describe("cleanupOrphanedAssetsWorkflow — sessions", () => {
  it("E-CL7: purges the expired session", async () => {
    expect(
      await prisma.session.findUnique({ where: { id: seeded.expiredSessionId } }),
    ).toBeNull();
    expect(result.sessionsPurged).toBeGreaterThanOrEqual(1);
  });

  it("E-CL8: leaves the LIVE session alone, despite an ancient createdAt and lastUsedAt", async () => {
    // Sessions are sliding: an ancient createdAt describes an active user, not a stale
    // one. A purge keyed on createdAt or lastUsedAt would sign that user out.
    const live = await prisma.session.findUnique({
      where: { id: seeded.liveSessionId },
    });
    expect(live).not.toBeNull();
    expect(live!.expiresAt.getTime()).toBeGreaterThan(Date.now());
  });
});
