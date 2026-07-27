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

// ISOLATION, NOT A PRECONDITION. This spec launches the REAL DBOS runtime in-process and
// registers the REAL static workflow names on the REAL shared queues — exactly what the
// root Compose `dbos` container does. Nothing used to distinguish them: `executor_id` is
// "local" for both (and is a recovery filter, never a dequeue filter), the in-process
// worker's auto-computed application version MATCHES the container's, and the dequeue
// predicate accepts `application_version IS NULL`. So the container could dequeue this
// spec's work — and, worse, could be the executor that resumes a workflow the crash/replay
// specs just killed, leaving the exactly-once proof measuring the wrong process.
//
// Requiring the container to be stopped is not an option: that precondition is
// unsatisfiable across a full sweep (root's own e2e lane and nextjs's render lane both
// bring `dbos` UP and deliberately leave it up). Instead the in-process runtime AND the
// DBOSClient share a per-lane DBOS system SCHEMA inside the same `supagloo_dbos` database
// (SDK `systemDatabaseSchemaName`), so the two executors cannot see each other's rows in
// EITHER direction. The container may be up or down; both pass. Queue and workflow names
// are unchanged and deliberately still the real ones — static registration is a hard
// constraint of src/dbos/registry.ts and the real names are what this spec proves.

/** This lane's private DBOS system schema inside `supagloo_dbos` (see the header note). */
const SYSTEM_SCHEMA = laneSystemSchema("dbos_image");

const env: Env = loadEnv({
  DATABASE_URL:
    process.env.DATABASE_URL ?? "postgres://supagloo:supagloo@localhost:5432/supagloo",
  DBOS_DATABASE_URL:
    process.env.DBOS_DATABASE_URL ??
    "postgres://supagloo:supagloo@localhost:5432/supagloo_dbos",
  // The lane half of the isolation seam: launchDbos() forwards this to
  // DBOS.setConfig({ systemDatabaseSchemaName }). Unset in Compose; explicit here.
  DBOS_SYSTEM_DATABASE_SCHEMA: SYSTEM_SCHEMA,
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
  // Self-heal a crashed previous run BEFORE launch, so no stale PENDING row is adopted
  // by DBOS's recovery sweep (same executor_id "local", same auto-computed app version).
  await resetLaneSchema({
    systemDatabaseUrl: env.DBOS_DATABASE_URL,
    schema: SYSTEM_SCHEMA,
  });
  await launchDbos(env);
  // Fail FAST and LOUD if the config did not take. Never a warn, never a skip.
  await assertLaneRuntimeIsolated({
    systemDatabaseUrl: env.DBOS_DATABASE_URL,
    schema: SYSTEM_SCHEMA,
  });
  client = await DBOSClient.create({
    systemDatabaseUrl: env.DBOS_DATABASE_URL,
    systemDatabaseSchemaName: SYSTEM_SCHEMA, // ← the client half
  });
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

describe("lane isolation", () => {
  it("E-DB0-image: this lane runs on its own DBOS system schema, so the Compose worker cannot see its work", async () => {
    expect(SYSTEM_SCHEMA).not.toBe("dbos");
    await assertLaneRuntimeIsolated({
      systemDatabaseUrl: env.DBOS_DATABASE_URL,
      schema: SYSTEM_SCHEMA,
    });
  });
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
    // The CLIENT half of the isolation is real: this enqueue landed in the lane's
    // schema and is absent from the shared one the Compose worker polls. Folded into
    // the FIRST enqueue this spec ALREADY makes — never a synthetic enqueue of a real
    // workflow, which would do real GitHub/S3/provider work for no new information.
    //
    // Asserted BEFORE getResult(), and that ordering is the whole point. With the
    // client half dropped the row lands in the shared schema, the containerised worker
    // executes this very workflow and drives the SAME app-DB rows, and every assertion
    // below still passes — the spec would go green having proven the CONTAINER works
    // rather than this process. That is the green lie the guard exists to stop, and it
    // is invisible without a positive check at the enqueue itself.
    await assertWorkflowIsolated({
      systemDatabaseUrl: env.DBOS_DATABASE_URL,
      schema: SYSTEM_SCHEMA,
      workflowID: genId,
    });
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
