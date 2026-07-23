import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { DBOSClient } from "@dbos-inc/dbos-sdk";
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
import { resolveImageModel } from "../../src/testing/e2e-models";
import { countStepExecutions } from "../../src/testing/step-introspection";
import type {
  GenerateImagePayload,
  GenerateImageResult,
} from "../../src/workflows/generate-image";

// End-to-end proof of generateImageWorkflow against the REAL OpenRouter host + the REAL
// Compose MinIO (design-delta §7 workflow 6, §10.2/§10.3/§10.7/§10.9). DBOS is launched
// IN-PROCESS; the workflow resolves a live image model, calls real OpenRouter, downloads the
// bytes, and PUTs a real object into MinIO under projects/{projectId}/assets/{generationId}.
// We read the object back from the HOST to prove the bytes landed.
//
// Real-provider seeding (§10.3): the OpenRouter connection is seeded via
// `seedOpenRouterConnection` with the real OPENROUTER_E2E_TEST_API_KEY (no fabricated
// ciphertext). The model id is resolved at run time via discovery (§10.9 — never hardcoded).
// No stub URL, no /__stub introspection, no fabricated magic-byte literals: the "exactly one
// provider call" fact is now proven structurally via the DBOS system-DB step count, and the
// asset assertion is "non-empty bytes in MinIO".
//
// The in-process worker reaches MinIO via S3_ENDPOINT=localhost:9000 (host-reachable). Infra
// ensured by tests/e2e/global-setup.ts. Requires the real e2e secrets in the environment
// (e.g. `set -a; . ./.env; set +a`).

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
  // Real OpenRouter host by default (env.ts default), honoring a sourced override.
  OPENROUTER_BASE_URL: process.env.OPENROUTER_BASE_URL,
  SECRETS_ENCRYPTION_KEY: ENCRYPTION_KEY,
  // S3: the in-process worker uploads against the HOST-reachable public endpoint.
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
let creds: GenerationSeedCreds;
let imageModel: string;

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
  await seedOpenRouterConnection({
    prisma,
    userId: user.id,
    apiKey: creds.openrouterKey,
    encryptionKey: ENCRYPTION_KEY,
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
      model: imageModel,
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
  // Fail fast + loud if the real secrets are absent (§10.8) — never a silent skip.
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
  // Resolve a live image model id via discovery (§10.9 — never hardcoded).
  imageModel = await resolveImageModel(env);
}, 120_000);

afterAll(async () => {
  s3?.destroy();
  await client?.destroy().catch(() => {});
  await shutdownDbos();
  await prisma.$disconnect().catch(() => {});
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

    // The image model was called exactly once (happy path, no retry) — proven structurally
    // via the DBOS system-DB step count (replaces the stub's imageRequests counter, §10.7).
    expect(await countStepExecutions(client, genId, "callImageModel")).toBe(1);

    // A REAL object exists in MinIO at the asset key, with non-empty provider bytes (no
    // fabricated magic-byte literal — real provider output format is not asserted).
    const bytes = await readObject(expectedKey);
    expect(bytes.length).toBeGreaterThan(0);

    await s3
      .send(new DeleteObjectCommand({ Bucket: S3_BUCKET, Key: expectedKey }))
      .catch(() => {});
  }, 120_000);
});
