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
import { resolveAudioModel } from "../../src/testing/e2e-models";
import { countStepExecutions } from "../../src/testing/step-introspection";
import type {
  GenerateAudioPayload,
  GenerateAudioResult,
} from "../../src/workflows/generate-audio";

// End-to-end proof of generateAudioWorkflow against the REAL OpenRouter host + the REAL
// Compose MinIO (design-delta §7 workflow 7, §10.2/§10.3/§10.7/§10.9). DBOS is launched
// IN-PROCESS; the workflow resolves a live audio model, calls real OpenRouter's speech
// endpoint (raw byte stream), buffers the bytes, and PUTs a real object into MinIO under
// projects/{projectId}/assets/{generationId}. narration + music share the SAME endpoint
// (decision D2). We read the object back from the HOST to prove the bytes landed.
//
// Real-provider seeding (§10.3): OpenRouter connection seeded via `seedOpenRouterConnection`
// with the real OPENROUTER_E2E_TEST_API_KEY (no fabricated ciphertext); model id resolved via
// discovery (§10.9). No stub URL / no /__stub introspection / no fabricated magic-byte literal:
// "exactly one provider call" is proven via the DBOS system-DB step count, and the asset
// assertion is "non-empty bytes in MinIO".
//
// The in-process worker reaches MinIO via S3_ENDPOINT=localhost:9000 (host-reachable). Infra
// ensured by tests/e2e/global-setup.ts. Requires the real e2e secrets in the environment.

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
});

const prisma = createPrismaClient({ connectionString: env.DATABASE_URL });
let client: DBOSClient;
let s3: S3Client;
let creds: GenerationSeedCreds;

const NARRATION_INPUT = {
  voice: { description: "warm, weathered baritone", label: "JEJ-STYLE" },
  scenes: [
    { sceneId: "s1", scriptText: "I lift up my eyes to the hills." },
    { sceneId: "s2", scriptText: "From whence cometh my help?" },
  ],
};
// Minimal duration keeps live cost/latency down (§10.9 minimal-media mitigation).
const MUSIC_INPUT = { style: "Swelling cinematic strings", durationSeconds: 1 };

async function seedAudioGeneration(
  kind: "narration" | "music",
): Promise<{ genId: string; projectId: string; payload: GenerateAudioPayload }> {
  const suffix = randomUUID().slice(0, 8);
  const user = await prisma.user.create({
    data: {
      youversionUserId: `yv-aud-${suffix}`,
      displayName: "Audio E2E",
      email: `${suffix}@supagloo.test`,
      avatarInitials: "AE",
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
      slug: `aud-${suffix}`,
      ownerId: user.id,
      name: `Audio Project ${suffix}`,
      repoOwner: "ashtable",
      repoName: `aud-${suffix}`,
      repoVisibility: "private",
      createdFrom: "blank",
      currentBranch: "v0.0.1",
    },
  });
  const genId = `gen-aud-${kind}-${suffix}`;
  await prisma.aiGeneration.create({
    data: {
      id: genId,
      userId: user.id,
      projectId: project.id,
      kind,
      provider: "openrouter",
      // Kind-specific live model: narration → cheapest TTS, music → cheapest Lyria (§10.9).
      model: await resolveAudioModel(env, kind),
      status: "queued",
      input: kind === "narration" ? NARRATION_INPUT : MUSIC_INPUT,
    },
  });
  return { genId, projectId: project.id, payload: { generationId: genId } };
}

async function readObject(key: string): Promise<Buffer> {
  const res = await s3.send(new GetObjectCommand({ Bucket: S3_BUCKET, Key: key }));
  const bytes = await res.Body!.transformToByteArray();
  return Buffer.from(bytes);
}

async function runAudio(
  genId: string,
  payload: GenerateAudioPayload,
): Promise<GenerateAudioResult> {
  const handle = await client.enqueue<GenerateAudioResult>(
    {
      workflowName: WORKFLOW_NAMES.generateAudio,
      queueName: WORKFLOW_QUEUE.generateAudio,
      workflowID: genId,
    },
    payload,
  );
  return (await handle.getResult()) as GenerateAudioResult;
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
}, 120_000);

afterAll(async () => {
  s3?.destroy();
  await client?.destroy().catch(() => {});
  await shutdownDbos();
  await prisma.$disconnect().catch(() => {});
});

describe("generateAudioWorkflow — lands a real wav in MinIO", () => {
  it("narration: synthesizes the combined script, uploads audio to projects/{id}/assets/{genId}, records resultAssetKey", async () => {
    const { genId, projectId, payload } = await seedAudioGeneration("narration");

    const result = await runAudio(genId, payload);
    expect(result.generationId).toBe(genId);
    expect(result.kind).toBe("narration");

    const expectedKey = buildAssetKey(projectId, genId);
    const row = await prisma.aiGeneration.findUniqueOrThrow({ where: { id: genId } });
    expect(row.status).toBe("succeeded");
    expect(row.completedAt).toBeInstanceOf(Date);
    expect(row.resultAssetKey).toBe(expectedKey);
    // Decision D6: metadata is captured into resultJson (the provider request id, if any, is
    // provider-specific — its presence/format is not asserted against a real host).
    expect(row.resultJson).toMatchObject({ kind: "narration" });

    // The speech endpoint was called exactly once (happy path, no retry) — proven via the
    // DBOS system-DB step count (replaces the stub's speechRequests counter, §10.7).
    expect(await countStepExecutions(client, genId, "synthesizeAndUploadAudio")).toBe(1);

    // A REAL object exists in MinIO at the asset key with non-empty provider bytes.
    const bytes = await readObject(expectedKey);
    expect(bytes.length).toBeGreaterThan(0);

    await s3
      .send(new DeleteObjectCommand({ Bucket: S3_BUCKET, Key: expectedKey }))
      .catch(() => {});
  }, 120_000);

  it("music: same step shape via the same speech endpoint — audio lands in MinIO", async () => {
    const { genId, projectId, payload } = await seedAudioGeneration("music");

    const result = await runAudio(genId, payload);
    expect(result.kind).toBe("music");

    const expectedKey = buildAssetKey(projectId, genId);
    const row = await prisma.aiGeneration.findUniqueOrThrow({ where: { id: genId } });
    expect(row.status).toBe("succeeded");
    expect(row.resultAssetKey).toBe(expectedKey);
    expect(row.resultJson).toMatchObject({ kind: "music" });

    expect(await countStepExecutions(client, genId, "synthesizeAndUploadAudio")).toBe(1);

    const bytes = await readObject(expectedKey);
    expect(bytes.length).toBeGreaterThan(0);

    await s3
      .send(new DeleteObjectCommand({ Bucket: S3_BUCKET, Key: expectedKey }))
      .catch(() => {});
  }, 120_000);
});
