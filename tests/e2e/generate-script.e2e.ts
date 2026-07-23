import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { DBOS, DBOSClient } from "@dbos-inc/dbos-sdk";
import {
  createPrismaClient,
  GeneratedStoryboardSchema,
} from "@supagloo/database-lib";
import { loadEnv, type Env } from "../../src/config/env";
import { launchDbos, shutdownDbos } from "../../src/dbos/runtime";
import { WORKFLOW_NAMES, WORKFLOW_QUEUE } from "../../src/dbos/registry";
import {
  resolveGenerationSeedCreds,
  seedOpenRouterConnection,
  type GenerationSeedCreds,
} from "../../src/testing/seed-connections";
import { resolveTextModel } from "../../src/testing/e2e-models";
import { countStepExecutions } from "../../src/testing/step-introspection";
import {
  __setGenerateScriptBoundaryHook,
  type GenerateScriptPayload,
  type GenerateScriptResult,
} from "../../src/workflows/generate-script";

// End-to-end CRASH/REPLAY proof of generateScriptWorkflow against the REAL OpenRouter host
// (design-delta §7 workflow 5, §10.2/§10.3/§10.5/§10.7/§10.9). DBOS is launched IN-PROCESS; the
// workflow resolves a live text model, runs a real `generateObject` storyboard round-trip,
// then this test parks at the persistResult boundary, cancels, and resumes — asserting the
// checkpointed LLM step(s) REPLAY on resume WITHOUT a second real HTTP call (the §10.5 pattern).
//
// Real-provider seeding (§10.3): the OpenRouter connection is seeded via
// `seedOpenRouterConnection` with the real OPENROUTER_E2E_TEST_API_KEY (no fabricated
// ciphertext); the model id is resolved via discovery (§10.9 — never hardcoded).
//
// The proof is now HOST-INTROSPECTION-FREE (§10.7): instead of the openrouter-stub's
// chatCompletions counter, we count the LLM step's recorded executions in the DBOS system DB
// (`countStepExecutions`, prefix-matching so repair attempts all count) and assert the count is
// UNCHANGED across the resume, plus the persisted result is schema-valid. The generation is a
// pure brief→storyboard round-trip (NO scripture), so YouVersion is not exercised at all — its
// real-hosting is out of this task's OpenRouter/Gloo scope.
//
// The deterministic-FAILURE cases that once lived here (503-then-200 retry, malformed→valid
// repair) were reclassified to injected-fetch UNIT tests in task 34-E1 (§10.6); they cannot and
// should not be scripted against a real host.

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
  // Task #32 made the S3 (writer) vars required at boot (unused by this workflow).
  S3_ENDPOINT: "http://minio:9000",
  S3_BUCKET: "supagloo-dev",
  S3_ACCESS_KEY: "supagloo",
  S3_SECRET_KEY: "supagloo-dev",
});

const prisma = createPrismaClient({ connectionString: env.DATABASE_URL });
let client: DBOSClient;
let creds: GenerationSeedCreds;
let textModel: string;

async function seedStoryboardGeneration(): Promise<{
  genId: string;
  payload: GenerateScriptPayload;
}> {
  const suffix = randomUUID().slice(0, 8);
  const user = await prisma.user.create({
    data: {
      youversionUserId: `yv-gen-${suffix}`,
      displayName: "Gen E2E",
      email: `${suffix}@supagloo.test`,
      avatarInitials: "GE",
    },
  });
  await seedOpenRouterConnection({
    prisma,
    userId: user.id,
    apiKey: creds.openrouterKey,
    encryptionKey: ENCRYPTION_KEY,
  });
  const genId = `gen-${suffix}`;
  await prisma.aiGeneration.create({
    data: {
      id: genId,
      userId: user.id,
      kind: "storyboard",
      provider: "openrouter",
      model: textModel,
      status: "queued",
      // Brief-only (NO scripture) — a pure LLM round-trip; skips fetchScripturePassage entirely.
      input: {
        brief: "Break a short reverent reflection on hope into a vertical video storyboard.",
      },
    },
  });
  return { genId, payload: { generationId: genId } };
}

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
  textModel = await resolveTextModel(env);
}, 120_000);

afterAll(async () => {
  __setGenerateScriptBoundaryHook(undefined);
  await client?.destroy().catch(() => {});
  await shutdownDbos();
  await prisma.$disconnect().catch(() => {});
});

describe("generateScriptWorkflow — crash / replay after the successful LLM call", () => {
  it("cancels at persistResult, resumes, and does NOT re-call the LLM (checkpointed steps replay)", async () => {
    const { genId, payload } = await seedStoryboardGeneration();

    // Park at the boundary just before persistResult — the real LLM round-trip (incl. any
    // natural repair attempts) has already run + checkpointed, so the cancel lands after the
    // last LLM call.
    let release!: () => void;
    const reached = new Promise<void>((resolve) => {
      __setGenerateScriptBoundaryHook(async (label) => {
        if (label === "persistResult") {
          resolve();
          await new Promise<void>((r) => {
            release = r;
          });
        }
      });
    });

    const handle = await client.enqueue<GenerateScriptResult>(
      {
        workflowName: WORKFLOW_NAMES.generateScript,
        queueName: WORKFLOW_QUEUE.generateScript,
        workflowID: genId,
      },
      payload,
    );
    const settled = handle.getResult().then(
      () => "ok",
      () => "interrupted",
    );

    await reached;
    // The LLM call(s) already happened + checkpointed at this boundary. Capture the count.
    const llmStepsBefore = await countStepExecutions(client, genId, "callLlmStructured");
    expect(llmStepsBefore).toBeGreaterThanOrEqual(1);

    await DBOS.cancelWorkflow(genId);
    release();
    await settled;

    __setGenerateScriptBoundaryHook(undefined);
    await waitForStatus(genId, ["CANCELLED", "ERROR"]);
    const resumeHandle = await DBOS.resumeWorkflow<GenerateScriptResult>(genId);
    await resumeHandle.getResult();

    // The crux (§10.5): the LLM step count is UNCHANGED across the resume — the checkpointed
    // callLlmStructured step(s) replayed with no extra real HTTP call.
    const llmStepsAfter = await countStepExecutions(client, genId, "callLlmStructured");
    expect(llmStepsAfter).toBe(llmStepsBefore);

    // The persisted result is schema-valid (Zod-parse resultJson) — no stub literal asserted.
    const row = await prisma.aiGeneration.findUniqueOrThrow({ where: { id: genId } });
    expect(row.status).toBe("succeeded");
    const parsed = GeneratedStoryboardSchema.safeParse(row.resultJson);
    expect(parsed.success).toBe(true);
  }, 150_000);
});
