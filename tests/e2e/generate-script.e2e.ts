import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { DBOS, DBOSClient } from "@dbos-inc/dbos-sdk";
import {
  createPrismaClient,
  GeneratedScriptSchema,
  GeneratedStoryboardSchema,
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
import {
  getProviderConfig,
  setProviderConfig,
} from "../../src/providers/config";
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
const SYSTEM_SCHEMA = laneSystemSchema("dbos_script");

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
  // Task 34-E5: the passage-kind case hits the LIVE YouVersion host — thread the real app key
  // through so launchDbos → setProviderConfig carries it. YOUVERSION_BASE_URL is deliberately
  // NOT passed, so it defaults to the real https://api.youversion.com (never the stub).
  YOUVERSION_APP_KEY: process.env.YOUVERSION_APP_KEY,
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

/**
 * Seed a passage-kind (`script`) generation whose input carries a `scripture` block, so the
 * workflow runs `fetchScripturePassage` against the LIVE YouVersion host (task 34-E5). Uses
 * BSB (in the live English collection) + a USFM reference (what the live API requires).
 */
async function seedScriptureGeneration(): Promise<{
  genId: string;
  userId: string;
  payload: GenerateScriptPayload;
}> {
  const suffix = randomUUID().slice(0, 8);
  const user = await prisma.user.create({
    data: {
      youversionUserId: `yv-scr-${suffix}`,
      displayName: "Scripture E2E",
      email: `scr-${suffix}@supagloo.test`,
      avatarInitials: "SE",
    },
  });
  await seedOpenRouterConnection({
    prisma,
    userId: user.id,
    apiKey: creds.openrouterKey,
    encryptionKey: ENCRYPTION_KEY,
  });
  const genId = `gen-scr-${suffix}`;
  await prisma.aiGeneration.create({
    data: {
      id: genId,
      userId: user.id,
      kind: "script",
      provider: "openrouter",
      model: textModel,
      status: "queued",
      input: {
        brief: "Write the single-scene narration for this verse of hope.",
        // Drives the optional fetchScripturePassage step against the live YouVersion host.
        scripture: { reference: "JHN.3.16", translation: "BSB", language: "eng" },
      },
    },
  });
  return { genId, userId: user.id, payload: { generationId: genId } };
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
  textModel = await resolveTextModel(env);
}, 120_000);

afterAll(async () => {
  __setGenerateScriptBoundaryHook(undefined);
  await client?.destroy().catch(() => {});
  await shutdownDbos();
  await prisma.$disconnect().catch(() => {});
});

describe("lane isolation", () => {
  it("E-DB0-script: this lane runs on its own DBOS system schema, so the Compose worker cannot see its work", async () => {
    expect(SYSTEM_SCHEMA).not.toBe("dbos");
    await assertLaneRuntimeIsolated({
      systemDatabaseUrl: env.DBOS_DATABASE_URL,
      schema: SYSTEM_SCHEMA,
    });
  });
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

// Task 34-E5 (design-delta §10.4a): the passage-fetch path, flipped to the LIVE YouVersion Data
// Exchange host (server-to-server x-yvp-app-key auth — no interactive login). Proves (1) a
// passage-kind generation runs to completion with verse text fetched live, and (2) a wrong app
// key fails DETERMINISTICALLY. YOUVERSION_BASE_URL defaults to the real host (never the stub).
describe("generateScriptWorkflow — passage fetch against the LIVE YouVersion host", () => {
  it("runs a passage-kind script generation to completion with verse text fetched live", async () => {
    const { genId, payload } = await seedScriptureGeneration();

    const handle = await client.enqueue<GenerateScriptResult>(
      {
        workflowName: WORKFLOW_NAMES.generateScript,
        queueName: WORKFLOW_QUEUE.generateScript,
        workflowID: genId,
      },
      payload,
    );
    await handle.getResult();

    // The live YouVersion passage fetch ran exactly once (a live 4xx would have thrown in the
    // step and failed the generation) — the honest, non-flaky proof the real host served a
    // passage. Then the LLM produced a schema-valid single-scene script.
    const passageSteps = await countStepExecutions(client, genId, "fetchScripturePassage");
    expect(passageSteps).toBe(1);

    const row = await prisma.aiGeneration.findUniqueOrThrow({ where: { id: genId } });
    expect(row.status).toBe("succeeded");
    expect(GeneratedScriptSchema.safeParse(row.resultJson).success).toBe(true);
  }, 150_000);

  it("fails deterministically when the YouVersion app key is missing/wrong", async () => {
    const { genId, payload } = await seedScriptureGeneration();

    // Simulate a misconfigured app key by overriding the process provider config (restored in
    // finally). The fetchScripturePassage step reads getProviderConfig() at execution time, so
    // the bad key lands on both the collection call (swallowed → KJV/BSB fallback) AND the
    // passage fetch, which the live host 401s → a permanent ProviderHttpError → fail-fast.
    const good = getProviderConfig();
    setProviderConfig({
      ...good,
      youversionAppKey: "deadbeef-not-a-real-yvp-app-key-000000000000",
    });
    try {
      const handle = await client.enqueue<GenerateScriptResult>(
        {
          workflowName: WORKFLOW_NAMES.generateScript,
          queueName: WORKFLOW_QUEUE.generateScript,
          workflowID: genId,
        },
        payload,
      );
      // The workflow throws (permanent) and marks the row failed BEFORE rethrowing.
      await expect(handle.getResult()).rejects.toBeDefined();

      const row = await prisma.aiGeneration.findUniqueOrThrow({ where: { id: genId } });
      expect(row.status).toBe("failed");
      // Deterministic: it failed at the YouVersion step, so the LLM step never ran.
      const llmSteps = await countStepExecutions(client, genId, "callLlmStructured");
      expect(llmSteps).toBe(0);
    } finally {
      setProviderConfig(good);
    }
  }, 60_000);
});
