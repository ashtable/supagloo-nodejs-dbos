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
  GenerateAudioPayload,
  GenerateAudioResult,
} from "../../src/workflows/generate-audio";

// End-to-end proof of generateAudioWorkflow against the REAL provider-stub harness + the REAL
// Compose MinIO (design-delta §7 workflow 7). DBOS is launched IN-PROCESS; the openrouter-stub
// (:4802) serves POST /api/v1/audio/speech as a RAW mp3 byte stream (+ X-Generation-Id header);
// the workflow buffers the bytes and PUTs a real object into MinIO under
// projects/{projectId}/assets/{generationId}. We read the object back from the HOST to prove the
// bytes landed intact. narration + music share the SAME endpoint (decision D2).
//
// The mid-stream 503-then-200 retry case that used to live here was reclassified to an
// injected-fetch UNIT test in task 34-E1 (design-delta §10.6) — simulated provider
// misbehavior is not end-to-end. See src/providers/media-client.test.ts (requestSpeech
// 503-then-200) + src/providers/errors.test.ts (MEDIA_RETRY).
//
// The in-process worker reaches MinIO via S3_ENDPOINT=localhost:9000 (host-reachable) — NOT the
// container-network minio:9000. Infra ensured by tests/e2e/global-setup.ts.

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

async function resetOpenRouter(): Promise<void> {
  await fetch(`${OPENROUTER_STUB}/__stub/reset`, { method: "POST" });
}

async function stubState(baseUrl: string): Promise<Record<string, number>> {
  const res = await fetch(`${baseUrl}/__stub/calls`);
  return ((await res.json()) as { state: Record<string, number> }).state;
}

const NARRATION_INPUT = {
  voice: { description: "warm, weathered baritone", label: "JEJ-STYLE" },
  scenes: [
    { sceneId: "s1", scriptText: "I lift up my eyes to the hills." },
    { sceneId: "s2", scriptText: "From whence cometh my help?" },
  ],
};
const MUSIC_INPUT = { style: "Swelling cinematic strings", durationSeconds: 30 };

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
      model: kind === "narration" ? "stub/speech-model" : "stub/music-model",
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

describe("generateAudioWorkflow — lands a real mp3 in MinIO", () => {
  it("narration: synthesizes the combined script, uploads mp3 to projects/{id}/assets/{genId}, records resultAssetKey + provider id", async () => {
    const { genId, projectId, payload } = await seedAudioGeneration("narration");

    const result = await runAudio(genId, payload);
    expect(result.generationId).toBe(genId);
    expect(result.kind).toBe("narration");

    const expectedKey = buildAssetKey(projectId, genId);
    const row = await prisma.aiGeneration.findUniqueOrThrow({ where: { id: genId } });
    expect(row.status).toBe("succeeded");
    expect(row.completedAt).toBeInstanceOf(Date);
    expect(row.resultAssetKey).toBe(expectedKey);
    // Decision D6: the provider X-Generation-Id is captured into resultJson metadata.
    expect(row.resultJson).toMatchObject({ kind: "narration" });
    expect((row.resultJson as { providerGenerationId?: string }).providerGenerationId).toMatch(
      /^gen_stub_/,
    );

    // The speech endpoint was called exactly once (happy path, no retry).
    const or = await stubState(OPENROUTER_STUB);
    expect(or.speechRequests).toBe(1);

    // A REAL object exists in MinIO at the asset key, with the stub's mp3 bytes.
    const bytes = await readObject(expectedKey);
    expect(bytes.length).toBeGreaterThan(0);
    // MP3 frame sync (0xFF 0xFB…) — the stub's FAKE_MP3 magic.
    expect(bytes.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xfb]));

    await s3
      .send(new DeleteObjectCommand({ Bucket: S3_BUCKET, Key: expectedKey }))
      .catch(() => {});
  }, 120_000);

  it("music: same step shape via the same speech endpoint — mp3 lands in MinIO", async () => {
    const { genId, projectId, payload } = await seedAudioGeneration("music");

    const result = await runAudio(genId, payload);
    expect(result.kind).toBe("music");

    const expectedKey = buildAssetKey(projectId, genId);
    const row = await prisma.aiGeneration.findUniqueOrThrow({ where: { id: genId } });
    expect(row.status).toBe("succeeded");
    expect(row.resultAssetKey).toBe(expectedKey);
    expect(row.resultJson).toMatchObject({ kind: "music" });

    const or = await stubState(OPENROUTER_STUB);
    expect(or.speechRequests).toBe(1);

    const bytes = await readObject(expectedKey);
    expect(bytes.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xfb]));

    await s3
      .send(new DeleteObjectCommand({ Bucket: S3_BUCKET, Key: expectedKey }))
      .catch(() => {});
  }, 120_000);
});
