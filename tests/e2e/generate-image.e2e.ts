import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { DBOSClient } from "@dbos-inc/dbos-sdk";
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
import type {
  GenerateImagePayload,
  GenerateImageResult,
} from "../../src/workflows/generate-image";

// End-to-end proof of generateImageWorkflow against the REAL provider-stub harness +
// the REAL Compose MinIO (design-delta §7 workflow 6). DBOS is launched IN-PROCESS; the
// openrouter-stub (:4802) serves POST /api/v1/images/generations (→ a download URL) and
// the image bytes; the workflow downloads them and PUTs a real object into MinIO under
// projects/{projectId}/assets/{generationId}. We then read the object back from the HOST
// to prove the bytes landed. This is the FIRST real S3 write in the codebase.
//
// The in-process worker reaches MinIO via S3_ENDPOINT=localhost:9000 (host-reachable) —
// NOT the container-network minio:9000. Infra ensured by tests/e2e/global-setup.ts
// (reuse-or-spawn: postgres + stubs + minio/minio-init).

const OPENROUTER_STUB = process.env.OPENROUTER_STUB_URL ?? "http://localhost:4802";
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
  OPENROUTER_BASE_URL: OPENROUTER_STUB,
  SECRETS_ENCRYPTION_KEY: ENCRYPTION_KEY,
  // S3: the in-process worker uploads against the HOST-reachable public endpoint
  // (localhost:9000), not the container-network minio:9000.
  S3_ENDPOINT: S3_PUBLIC,
  S3_PUBLIC_ENDPOINT: S3_PUBLIC,
  S3_BUCKET,
  S3_ACCESS_KEY: process.env.S3_ACCESS_KEY ?? "supagloo",
  S3_SECRET_KEY: process.env.S3_SECRET_KEY ?? "supagloo-dev",
  S3_REGION: process.env.S3_REGION ?? "us-east-1",
});

const prisma = createPrismaClient({ connectionString: env.DATABASE_URL });
let client: DBOSClient;
let s3: S3Client;

async function resetOpenRouter(): Promise<void> {
  await fetch(`${OPENROUTER_STUB}/__stub/reset`, { method: "POST" });
}

async function stubState(baseUrl: string): Promise<Record<string, number>> {
  const res = await fetch(`${baseUrl}/__stub/calls`);
  return ((await res.json()) as { state: Record<string, number> }).state;
}

async function seedImageGeneration(): Promise<{
  genId: string;
  projectId: string;
  payload: GenerateImagePayload;
}> {
  const suffix = randomUUID().slice(0, 8);
  const user = await prisma.user.create({
    data: {
      youversionUserId: `yv-img-${suffix}`,
      displayName: "Img E2E",
      email: `${suffix}@supagloo.test`,
      avatarInitials: "IE",
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
      slug: `img-${suffix}`,
      ownerId: user.id,
      name: `Img Project ${suffix}`,
      repoOwner: "ashtable",
      repoName: `img-${suffix}`,
      repoVisibility: "private",
      createdFrom: "blank",
      currentBranch: "v0.0.1",
    },
  });
  const genId = `gen-img-${suffix}`;
  await prisma.aiGeneration.create({
    data: {
      id: genId,
      userId: user.id,
      projectId: project.id,
      kind: "image",
      provider: "openrouter",
      model: "stub/image-model",
      status: "queued",
      input: { prompt: "a serene sunrise over hills, cinematic wide shot" },
    },
  });
  return { genId, projectId: project.id, payload: { generationId: genId } };
}

async function readObject(key: string): Promise<Buffer> {
  const res = await s3.send(
    new GetObjectCommand({ Bucket: S3_BUCKET, Key: key }),
  );
  const bytes = await res.Body!.transformToByteArray();
  return Buffer.from(bytes);
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
  s3?.destroy();
  await client?.destroy().catch(() => {});
  await shutdownDbos();
  await prisma.$disconnect().catch(() => {});
});

beforeEach(async () => {
  await resetOpenRouter();
});

describe("generateImageWorkflow — lands a real object in MinIO", () => {
  it("calls the image model, uploads the bytes to projects/{id}/assets/{genId}, and records resultAssetKey", async () => {
    const { genId, projectId, payload } = await seedImageGeneration();

    const handle = await client.enqueue<GenerateImageResult>(
      {
        workflowName: WORKFLOW_NAMES.generateImage,
        queueName: WORKFLOW_QUEUE.generateImage,
        workflowID: genId,
      },
      payload,
    );
    const result = (await handle.getResult()) as GenerateImageResult;
    expect(result.generationId).toBe(genId);

    const expectedKey = buildAssetKey(projectId, genId);
    const row = await prisma.aiGeneration.findUniqueOrThrow({ where: { id: genId } });
    expect(row.status).toBe("succeeded");
    expect(row.completedAt).toBeInstanceOf(Date);
    expect(row.resultAssetKey).toBe(expectedKey);
    expect(row.resultJson).toBeNull();

    // The image model was called exactly once (no repair loop, happy path).
    const or = await stubState(OPENROUTER_STUB);
    expect(or.imageRequests).toBe(1);

    // A REAL object exists in MinIO at the asset key, with the stub's PNG bytes.
    const bytes = await readObject(expectedKey);
    expect(bytes.length).toBeGreaterThan(0);
    // PNG magic number.
    expect(bytes.subarray(0, 4)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]));

    await s3
      .send(new DeleteObjectCommand({ Bucket: S3_BUCKET, Key: expectedKey }))
      .catch(() => {});
  }, 120_000);
});
