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
import {
  resolveGenerationSeedCreds,
  seedGlooConnection,
  type GenerationSeedCreds,
} from "../../src/testing/seed-connections";
import { resolveGlooImageModel } from "../../src/testing/e2e-models";
import { mintGlooToken } from "../../src/providers/gloo";
import { countStepExecutions } from "../../src/testing/step-introspection";
import type {
  GenerateImagePayload,
  GenerateImageResult,
} from "../../src/workflows/generate-image";

/**
 * E-GI1/E-GI2 — `generateImageWorkflow` on the **GLOO** path, against the real host
 * (genesis-1 decision D1).
 *
 * ── Why this spec exists ────────────────────────────────────────────────────────────
 * `design-delta` §9-Q2 said "Gloo has no media modalities" and the compatibility matrix
 * encoded that as `image: ["openrouter"]`. For images it is false: Gloo's catalogue
 * carries 11 image-capable models and a real 1024x768 PNG was generated from one. The
 * reason four milestones went by without noticing is the ROUTING — image models are
 * unreachable through the chat/completions surface every other Gloo call in this system
 * uses, which answers `400 … Use the POST /v2/responses endpoint instead`.
 *
 * So the claim under test is precisely the one a unit test cannot make: that a
 * `{kind:"image", provider:"gloo"}` row, taken end to end through the real workflow,
 * really does put image bytes in MinIO — via a surface nothing in this codebase had ever
 * called before.
 *
 * ── What E-GI2 can and CANNOT prove ────────────────────────────────────────────────
 * It proves that sending `tradition` on the image path does not break it. It does NOT
 * prove the alignment was honoured, and cannot: Gloo answers 200 for unrecognised
 * `tradition` values and silently degrades to neutral, so no observable on this surface
 * distinguishes "honoured" from "ignored". (On the CHAT surface it is measurable, via
 * injected prompt-token count — that is how the vocabulary was established in the first
 * place.) Saying so here is the honest alternative to an assertion that would pass either
 * way.
 *
 * dbos e2e lanes are by filename suffix, so this file joins `vitest.e2e.config.ts` with
 * no registration edit. Requires the real e2e secrets (`set -a; . ./.env; set +a`).
 */

const S3_PUBLIC = process.env.S3_PUBLIC_ENDPOINT ?? "http://localhost:9000";
const S3_BUCKET = process.env.S3_BUCKET ?? "supagloo-dev";
const ENCRYPTION_KEY = TEST_SECRETS_ENCRYPTION_KEY;

/** This lane's private DBOS system schema — the same isolation the sibling image spec
 *  uses, so the Compose worker can neither steal this work nor be mistaken for it. */
const SYSTEM_SCHEMA = laneSystemSchema("dbos_image_gloo");

const env: Env = loadEnv({
  DATABASE_URL:
    process.env.DATABASE_URL ?? "postgres://supagloo:supagloo@localhost:5432/supagloo",
  DBOS_DATABASE_URL:
    process.env.DBOS_DATABASE_URL ??
    "postgres://supagloo:supagloo@localhost:5432/supagloo_dbos",
  DBOS_SYSTEM_DATABASE_SCHEMA: SYSTEM_SCHEMA,
  NODE_ENV: "test",
  GITHUB_APP_ID: "123456",
  GITHUB_APP_PRIVATE_KEY:
    "-----BEGIN RSA PRIVATE KEY-----\nx\n-----END RSA PRIVATE KEY-----",
  GLOO_BASE_URL: process.env.GLOO_BASE_URL,
  SECRETS_ENCRYPTION_KEY: ENCRYPTION_KEY,
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
let glooImageModel: string;

async function seedGlooImageGeneration(
  input: Record<string, unknown>,
): Promise<{ genId: string; projectId: string; payload: GenerateImagePayload }> {
  const suffix = randomUUID().slice(0, 8);
  const user = await prisma.user.create({
    data: {
      youversionUserId: `yv-gimg-${suffix}`,
      displayName: "Gloo Img E2E",
      email: `${suffix}@supagloo.test`,
      avatarInitials: "GI",
    },
  });
  // Verify-then-store against the LIVE host: the helper mints a real client-credentials
  // token first and refuses to write a row if it fails, so a credential problem surfaces
  // here rather than as an unattributable workflow failure two minutes later.
  await seedGlooConnection({
    prisma,
    userId: user.id,
    clientId: creds.glooClientId,
    clientSecret: creds.glooClientSecret,
    encryptionKey: ENCRYPTION_KEY,
    glooBaseUrl: env.GLOO_BASE_URL,
  });
  const project = await prisma.project.create({
    data: {
      slug: `gimg-${suffix}`,
      ownerId: user.id,
      name: `Gloo Img Project ${suffix}`,
      repoOwner: "ashtable",
      repoName: `gimg-${suffix}`,
      repoVisibility: "private",
      createdFrom: "blank",
      currentBranch: "v0.0.1",
    },
  });
  const genId = `gen-gimg-${suffix}`;
  await prisma.aiGeneration.create({
    data: {
      id: genId,
      userId: user.id,
      projectId: project.id,
      kind: "image",
      provider: "gloo",
      model: glooImageModel,
      status: "queued",
      // Cast at the Prisma boundary only: `input` is a Json column, and the generic
      // record shape the helper takes is not assignable to Prisma's InputJsonValue union.
      input: input as never,
    },
  });
  return { genId, projectId: project.id, payload: { generationId: genId } };
}

async function readObject(key: string): Promise<Buffer> {
  const res = await s3.send(new GetObjectCommand({ Bucket: S3_BUCKET, Key: key }));
  const bytes = await res.Body!.transformToByteArray();
  return Buffer.from(bytes);
}

/** Run one seeded generation to completion and return the asset bytes. */
async function runAndReadAsset(input: Record<string, unknown>): Promise<{
  genId: string;
  key: string;
  bytes: Buffer;
}> {
  const { genId, projectId, payload } = await seedGlooImageGeneration(input);

  const handle = await client.enqueue<GenerateImageResult>(
    {
      workflowName: WORKFLOW_NAMES.generateImage,
      queueName: WORKFLOW_QUEUE.generateImage,
      workflowID: genId,
    },
    payload,
  );
  // Asserted BEFORE getResult(): with the client half of the isolation dropped, the row
  // lands in the shared schema, the Compose worker executes this very workflow, drives the
  // same app-DB rows, and every assertion below still passes — proving the CONTAINER works
  // rather than this process.
  await assertWorkflowIsolated({
    systemDatabaseUrl: env.DBOS_DATABASE_URL,
    schema: SYSTEM_SCHEMA,
    workflowID: genId,
  });
  const result = (await handle.getResult()) as GenerateImageResult;
  expect(result.generationId).toBe(genId);

  const key = buildAssetKey(projectId, genId);
  return { genId, key, bytes: await readObject(key) };
}

beforeAll(async () => {
  // Fail fast + loud if the real secrets are absent (§10.8) — never a silent skip. A
  // gating suite that quietly skips its provider tests is a green lie, and this spec's
  // whole subject is a provider capability.
  creds = resolveGenerationSeedCreds();
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
  // Resolved at RUN TIME from Gloo's live catalogue (§10.9 — never hardcoded), filtered
  // on `output_modalities` rather than on a name heuristic.
  const token = await mintGlooToken({
    glooBaseUrl: env.GLOO_BASE_URL,
    clientId: creds.glooClientId,
    clientSecret: creds.glooClientSecret,
  });
  glooImageModel = await resolveGlooImageModel(
    { GLOO_BASE_URL: env.GLOO_BASE_URL },
    token.accessToken,
  );
  expect(glooImageModel.length).toBeGreaterThan(0);
}, 180_000);

afterAll(async () => {
  s3?.destroy();
  await client?.destroy().catch(() => {});
  await shutdownDbos();
  await prisma.$disconnect().catch(() => {});
});

describe("generateImageWorkflow — the Gloo path (genesis-1 D1)", () => {
  it("E-GI1: a gloo image row lands REAL image bytes in MinIO via POST /ai/v2/responses", async () => {
    const { genId, key, bytes } = await runAndReadAsset({
      prompt: "a serene sunrise over hills, cinematic wide shot",
    });

    const row = await prisma.aiGeneration.findUniqueOrThrow({ where: { id: genId } });
    expect(row.status).toBe("succeeded");
    expect(row.provider).toBe("gloo");
    expect(row.resultAssetKey).toBe(key);
    expect(row.completedAt).toBeInstanceOf(Date);

    // Exactly one provider call — no retry on the happy path. Proven structurally from
    // the DBOS system-DB step count rather than from any provider-side counter.
    expect(await countStepExecutions(client, genId, "callImageModel")).toBe(1);

    // Not merely "non-empty": the whole point of D1 is that these bytes are a PICTURE.
    // The sibling OpenRouter spec deliberately asserts only non-emptiness because its
    // format is not the claim; here it is — the capability was believed not to exist.
    expect(bytes.length).toBeGreaterThan(1000);
    const isPng = bytes.subarray(0, 8).toString("hex") === "89504e470d0a1a0a";
    const isJpeg = bytes.subarray(0, 3).toString("hex") === "ffd8ff";
    const isWebp =
      bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
      bytes.subarray(8, 12).toString("ascii") === "WEBP";
    expect(
      isPng || isJpeg || isWebp,
      `expected an image signature, got ${bytes.subarray(0, 12).toString("hex")}`,
    ).toBe(true);

    await s3
      .send(new DeleteObjectCommand({ Bucket: S3_BUCKET, Key: key }))
      .catch(() => {});
  }, 300_000);

  it("E-GI2: a faith-aligned request still produces an image (tradition on the image path)", async () => {
    // What this proves: `tradition` on `/ai/v2/responses` does not break image generation.
    // What it CANNOT prove: that the alignment steered anything. Gloo returns 200 for a
    // bogus `tradition` and silently degrades to neutral, so nothing observable on this
    // surface distinguishes honoured from ignored. The vocabulary itself is pinned by
    // `providers/faith-alignment.test.ts`, and the wire value can only ever be one of the
    // four real ones because `parseImageRequest` drops anything else.
    const { genId, key, bytes } = await runAndReadAsset({
      prompt: "a quiet chapel interior at dawn, cinematic",
      faithAlignment: "catholic",
    });

    const row = await prisma.aiGeneration.findUniqueOrThrow({ where: { id: genId } });
    expect(row.status).toBe("succeeded");
    expect(bytes.length).toBeGreaterThan(1000);
    expect(await countStepExecutions(client, genId, "callImageModel")).toBe(1);

    await s3
      .send(new DeleteObjectCommand({ Bucket: S3_BUCKET, Key: key }))
      .catch(() => {});
  }, 300_000);
});
