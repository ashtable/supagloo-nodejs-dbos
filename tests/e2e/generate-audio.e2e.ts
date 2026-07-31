import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { DBOSClient } from "@dbos-inc/dbos-sdk";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  type S3Client,
} from "@aws-sdk/client-s3";
import {
  buildAssetKey,
  buildSceneNarrationAssetKey,
  createPrismaClient,
} from "@supagloo/database-lib";
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
const ENCRYPTION_KEY = TEST_SECRETS_ENCRYPTION_KEY;

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
const SYSTEM_SCHEMA = laneSystemSchema("dbos_audio");

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
  OPENROUTER_BASE_URL: process.env.OPENROUTER_BASE_URL,
  // dbos 6c8a89b (2026-07-30) made YOUVERSION_APP_KEY required at boot (unused by this
  // workflow — `generate-script.ts` is the only caller of the YouVersion provider and this
  // spec never enqueues it). Deliberately a PLACEHOLDER rather than
  // `process.env.YOUVERSION_APP_KEY`: a spec that reads no scripture must not need the
  // operator's real key to boot. Same literal as `src/config/env.test.ts`.
  YOUVERSION_APP_KEY: "yvp-app-key-value",
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
  return (await handle.getResult()) as GenerateAudioResult;
}

beforeAll(async () => {
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
}, 120_000);

afterAll(async () => {
  s3?.destroy();
  await client?.destroy().catch(() => {});
  await shutdownDbos();
  await prisma.$disconnect().catch(() => {});
});

describe("lane isolation", () => {
  it("E-DB0-audio: this lane runs on its own DBOS system schema, so the Compose worker cannot see its work", async () => {
    expect(SYSTEM_SCHEMA).not.toBe("dbos");
    await assertLaneRuntimeIsolated({
      systemDatabaseUrl: env.DBOS_DATABASE_URL,
      schema: SYSTEM_SCHEMA,
    });
  });
});

describe("generateAudioWorkflow — lands a real wav in MinIO", () => {
  it("narration: synthesizes ONE clip PER SCENE, uploads each to its own per-scene key, records scene 1's as resultAssetKey", async () => {
    // N scenes ⇒ N provider calls ⇒ N objects in MinIO. Narration used to concatenate every
    // scene's script into a single synthesis call, producing one whole-video track the
    // composition could only mount at frame 0 — no sync mechanism at all. Splitting per scene
    // is what lets each clip live inside its own <Sequence>, so "one asset per scene" is the
    // property this lane has to hold end-to-end.
    const { genId, projectId, payload } = await seedAudioGeneration("narration");

    const result = await runAudio(genId, payload);
    expect(result.generationId).toBe(genId);
    expect(result.kind).toBe("narration");

    const sceneIds = NARRATION_INPUT.scenes.map((s) => s.sceneId);
    const sceneKeys = sceneIds.map((id) =>
      buildSceneNarrationAssetKey(projectId, genId, id),
    );

    const row = await prisma.aiGeneration.findUniqueOrThrow({ where: { id: genId } });
    expect(row.status).toBe("succeeded");
    expect(row.completedAt).toBeInstanceOf(Date);
    // The one-resultAssetKey-per-row invariant is unchanged: scene 1's clip is the
    // representative key, and the rest travel in resultJson.
    expect(row.resultAssetKey).toBe(sceneKeys[0]);
    expect(row.resultJson).toMatchObject({ kind: "narration" });

    // ONE speech step per scene, named for the scene — proven via the DBOS system-DB step
    // count (replaces the stub's speechRequests counter, §10.7). Exactly 1 each ⇒ happy path,
    // no retry, and no scene silently sharing another's clip.
    for (const id of sceneIds) {
      expect(
        await countStepExecutions(client, genId, `synthesizeNarrationScene:${id}`),
        `step count for scene ${id}`,
      ).toBe(1);
    }
    // DISCRIMINATING CONTROL. The pre-change workflow ran exactly one
    // `synthesizeAndUploadAudio` for narration; music still does. Without this, a regression
    // back to a single combined track could leave every assertion above satisfiable by a
    // future shim, and the count above would not notice a SECOND, whole-video synthesis.
    expect(await countStepExecutions(client, genId, "synthesizeAndUploadAudio")).toBe(0);

    // resultJson carries the full per-scene map, in scene order, with MEASURED lengths.
    // The durations are what makes a scene stretch to fit its verse rather than clip it, so
    // a zero/absent duration here is a silent failure of the headline fix.
    const narration = (row.resultJson as { narration?: { scenes?: unknown[] } }).narration;
    expect(narration?.scenes).toHaveLength(sceneIds.length);
    const scenes = narration?.scenes as Array<{
      sceneId: string;
      assetKey: string;
      durationSeconds?: number;
    }>;
    scenes.forEach((scene, i) => {
      expect(scene.sceneId, `resultJson scene ${i}`).toBe(sceneIds[i]);
      expect(scene.assetKey, `resultJson scene ${i}`).toBe(sceneKeys[i]);
      expect(scene.durationSeconds, `measured duration for scene ${i}`).toBeGreaterThan(0);
    });

    // A REAL object exists in MinIO at EVERY per-scene key with non-empty provider bytes.
    for (const key of sceneKeys) {
      const bytes = await readObject(key);
      expect(bytes.length, `bytes at ${key}`).toBeGreaterThan(0);
    }

    for (const key of sceneKeys) {
      await s3
        .send(new DeleteObjectCommand({ Bucket: S3_BUCKET, Key: key }))
        .catch(() => {});
    }
  }, 180_000);

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
