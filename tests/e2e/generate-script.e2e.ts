import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { DBOS, DBOSClient } from "@dbos-inc/dbos-sdk";
import { createPrismaClient, encryptSecret } from "@supagloo/database-lib";
import { loadEnv, type Env } from "../../src/config/env";
import { launchDbos, shutdownDbos } from "../../src/dbos/runtime";
import { WORKFLOW_NAMES, WORKFLOW_QUEUE } from "../../src/dbos/registry";
import {
  __setGenerateScriptBoundaryHook,
  type GenerateScriptPayload,
  type GenerateScriptResult,
} from "../../src/workflows/generate-script";

// End-to-end proof of generateScriptWorkflow against the REAL provider-stub harness:
// openrouter-stub (:4802) serves the structured chat-completions, youversion-stub (:4804)
// serves the "Get a Bible collection" + passage fetch. DBOS is launched IN-PROCESS
// (consuming the uncommitted db-lib via the file: dep). No mocks.
//
// The openrouter-stub's chat responses are PROGRAMMED per test via POST /__admin/chat-script
// so we can drive the exact design-delta §6d sequences deterministically:
//   A) 503-then-200 — a provider-level step retry (LLM_STRUCTURED_RETRY), not a repair.
//   B) malformed-then-valid — a schema-validation failure ⇒ a bounded REPAIR, not a step retry.
//   C) crash/replay after a successful repair — the checkpointed LLM steps replay WITHOUT a
//      second HTTP call (asserted via the stub's chatCompletions counter staying flat).

const OPENROUTER_STUB = process.env.OPENROUTER_STUB_URL ?? "http://localhost:4802";
const YOUVERSION_STUB = process.env.YOUVERSION_STUB_URL ?? "http://localhost:4804";
const ENCRYPTION_KEY = "0".repeat(64);

// A storyboard that satisfies GeneratedStoryboardSchema (the "good" LLM response body).
const GOOD_STORYBOARD = {
  scenes: [
    {
      name: "wilderness · dawn",
      scriptText: "For God so loved the world",
      reference: "John 3:16",
      translation: "KJV",
      visualPrompt: "sweeping desert at first light, cinematic wide establishing shot",
      suggestedDurationSeconds: 5,
    },
  ],
  narratorVoice: { description: "warm, reverent baritone, unhurried" },
  musicStyle: "swelling strings",
};

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
  YOUVERSION_BASE_URL: YOUVERSION_STUB,
  SECRETS_ENCRYPTION_KEY: ENCRYPTION_KEY,
  // Task #32 made the S3 (writer) vars required at boot (unused by this workflow).
  S3_ENDPOINT: "http://minio:9000",
  S3_BUCKET: "supagloo-dev",
  S3_ACCESS_KEY: "supagloo",
  S3_SECRET_KEY: "supagloo-dev",
});

const prisma = createPrismaClient({ connectionString: env.DATABASE_URL });
let client: DBOSClient;

async function resetOpenRouter(): Promise<void> {
  await fetch(`${OPENROUTER_STUB}/__stub/reset`, { method: "POST" });
}
async function resetYouVersion(): Promise<void> {
  await fetch(`${YOUVERSION_STUB}/__stub/reset`, { method: "POST" });
}

/** Program the openrouter-stub's next N chat responses (shifted one per chat call). */
async function scriptChatResponses(
  responses: Array<{ status: number; body?: unknown }>,
): Promise<void> {
  const res = await fetch(`${OPENROUTER_STUB}/__admin/chat-script`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ responses }),
  });
  if (!res.ok) {
    throw new Error(
      `openrouter-stub /__admin/chat-script not available (status ${res.status}) — ` +
        "the stub image is stale; rebuild the provider-stub image",
    );
  }
}

async function stubState(baseUrl: string): Promise<Record<string, number>> {
  const res = await fetch(`${baseUrl}/__stub/calls`);
  return ((await res.json()) as { state: Record<string, number> }).state;
}

async function seedGeneration(kind: "storyboard" | "script"): Promise<{
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
  await prisma.openRouterConnection.create({
    data: {
      userId: user.id,
      apiKeyCiphertext: encryptSecret("sk-or-test-key", ENCRYPTION_KEY),
      keyLast4: "tkey",
      status: "connected",
    },
  });
  const genId = `gen-${suffix}`;
  await prisma.aiGeneration.create({
    data: {
      id: genId,
      userId: user.id,
      kind,
      provider: "openrouter",
      model: "stub/text-model",
      status: "queued",
      input: {
        brief: "Break this passage into a reverent vertical video.",
        scripture: { reference: "John 3:16", translation: "KJV", language: "eng" },
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
  await launchDbos(env);
  client = await DBOSClient.create({ systemDatabaseUrl: env.DBOS_DATABASE_URL });
}, 120_000);

afterAll(async () => {
  __setGenerateScriptBoundaryHook(undefined);
  await client?.destroy().catch(() => {});
  await shutdownDbos();
  await prisma.$disconnect().catch(() => {});
});

beforeEach(async () => {
  await resetOpenRouter();
  await resetYouVersion();
});

describe("generateScriptWorkflow — retry (503 → 200)", () => {
  it("retries the LLM step on a 503, succeeds on the 200, and fetches the passage once", async () => {
    await scriptChatResponses([
      { status: 503 },
      { status: 200, body: GOOD_STORYBOARD },
    ]);
    const { genId, payload } = await seedGeneration("storyboard");

    const handle = await client.enqueue<GenerateScriptResult>(
      {
        workflowName: WORKFLOW_NAMES.generateScript,
        queueName: WORKFLOW_QUEUE.generateScript,
        workflowID: genId,
      },
      payload,
    );
    const result = (await handle.getResult()) as GenerateScriptResult;
    expect(result.generationId).toBe(genId);

    const row = await prisma.aiGeneration.findUniqueOrThrow({ where: { id: genId } });
    expect(row.status).toBe("succeeded");
    expect(row.completedAt).toBeInstanceOf(Date);
    expect((row.resultJson as { scenes: unknown[] }).scenes.length).toBeGreaterThan(0);
    expect(row.tokenUsage).not.toBeNull();

    // The 503 burned a step RETRY (not a repair): exactly two chat calls.
    const or = await stubState(OPENROUTER_STUB);
    expect(or.chatCompletions).toBe(2);
    // The passage was resolved via the live collection + fetched exactly once.
    const yv = await stubState(YOUVERSION_STUB);
    expect(yv.collectionLookups).toBeGreaterThanOrEqual(1);
    expect(yv.passageFetches).toBe(1);
  }, 120_000);
});

describe("generateScriptWorkflow — repair (malformed → valid)", () => {
  it("re-prompts after a schema-validation failure and persists the repaired result", async () => {
    await scriptChatResponses([
      { status: 200, body: { stub: true } }, // valid JSON, fails GeneratedStoryboardSchema
      { status: 200, body: GOOD_STORYBOARD },
    ]);
    const { genId, payload } = await seedGeneration("storyboard");

    const handle = await client.enqueue<GenerateScriptResult>(
      {
        workflowName: WORKFLOW_NAMES.generateScript,
        queueName: WORKFLOW_QUEUE.generateScript,
        workflowID: genId,
      },
      payload,
    );
    await handle.getResult();

    const row = await prisma.aiGeneration.findUniqueOrThrow({ where: { id: genId } });
    expect(row.status).toBe("succeeded");
    expect((row.resultJson as { musicStyle?: string }).musicStyle).toBe("swelling strings");

    // A REPAIR, not a step retry: the malformed 200 + the repaired 200 = two chat calls.
    const or = await stubState(OPENROUTER_STUB);
    expect(or.chatCompletions).toBe(2);
  }, 120_000);
});

describe("generateScriptWorkflow — crash / replay after the successful LLM call", () => {
  it("cancels at persistResult, resumes, and does NOT re-call the LLM (checkpointed steps replay)", async () => {
    await scriptChatResponses([
      { status: 200, body: { stub: true } }, // first attempt invalid → repair
      { status: 200, body: GOOD_STORYBOARD }, // repair succeeds
    ]);
    const { genId, payload } = await seedGeneration("storyboard");

    // Park at the boundary just before persistResult — the LLM loop (incl. the repair) has
    // already run + checkpointed, so the cancel lands after the last LLM call.
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
    // The two LLM calls already happened + checkpointed at this boundary.
    const beforeCancel = await stubState(OPENROUTER_STUB);
    expect(beforeCancel.chatCompletions).toBe(2);

    await DBOS.cancelWorkflow(genId);
    release();
    await settled;

    __setGenerateScriptBoundaryHook(undefined);
    await waitForStatus(genId, ["CANCELLED", "ERROR"]);
    const resumeHandle = await DBOS.resumeWorkflow<GenerateScriptResult>(genId);
    await resumeHandle.getResult();

    // The crux: the LLM was called exactly TWICE across BOTH attempts — the checkpointed
    // callLlmStructured steps replayed on resume with no extra HTTP call.
    const afterResume = await stubState(OPENROUTER_STUB);
    expect(afterResume.chatCompletions).toBe(2);

    const row = await prisma.aiGeneration.findUniqueOrThrow({ where: { id: genId } });
    expect(row.status).toBe("succeeded");
    expect((row.resultJson as { scenes: unknown[] }).scenes.length).toBeGreaterThan(0);
  }, 150_000);
});
