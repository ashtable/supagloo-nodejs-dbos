import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { DBOSClient } from "@dbos-inc/dbos-sdk";
import { createPrismaClient } from "@supagloo/database-lib";
import { loadEnv, type Env } from "../../src/config/env";
import { launchDbos, shutdownDbos } from "../../src/dbos/runtime";
import { WORKFLOW_NAMES, WORKFLOW_QUEUE } from "../../src/dbos/registry";
import type { NoopProofResult } from "../../src/workflows/noop-proof";

// End-to-end proof of the DBOS enqueue → execute → app-DB-write mechanism AND the
// idempotency guarantee that the whole architecture rests on (design-delta §5.1:
// the API enqueues with workflowID = domain-record id, "making enqueue
// idempotent"). Everything is real: the DBOS runtime is launched in-process, the
// enqueue goes through a real DBOSClient against the system db `supagloo_dbos`, and
// the workflow writes a row to the app db `supagloo` via db-lib's Prisma client.
// No mocks. Non-UI → no Stagehand.

const env: Env = loadEnv({
  DATABASE_URL:
    process.env.DATABASE_URL ??
    "postgres://supagloo:supagloo@localhost:5432/supagloo",
  DBOS_DATABASE_URL:
    process.env.DBOS_DATABASE_URL ??
    "postgres://supagloo:supagloo@localhost:5432/supagloo_dbos",
  NODE_ENV: "test",
  // launchDbos() now injects the git-ops GitHub config from env (Task #17), so these
  // are required to boot even though the noop workflow never touches GitHub.
  GITHUB_APP_ID: "123456",
  GITHUB_APP_PRIVATE_KEY:
    "-----BEGIN RSA PRIVATE KEY-----\nnoop\n-----END RSA PRIVATE KEY-----",
  // Task #29 made SECRETS_ENCRYPTION_KEY required at boot; the noop workflow never
  // decrypts anything but launchDbos() validates env, so provide a dummy 64-hex key.
  SECRETS_ENCRYPTION_KEY: "0".repeat(64),
  // Task #32 made the S3 (writer) vars required at boot (unused by this workflow).
  S3_ENDPOINT: "http://minio:9000",
  S3_BUCKET: "supagloo-dev",
  S3_ACCESS_KEY: "supagloo",
  S3_SECRET_KEY: "supagloo-dev",
});

const prisma = createPrismaClient({ connectionString: env.DATABASE_URL });
let client: DBOSClient;

async function countRows(workflowId: string): Promise<number> {
  const rows = await prisma.$queryRaw<Array<{ count: number }>>`
    SELECT count(*)::int AS count FROM noop_proof WHERE workflow_id = ${workflowId}
  `;
  return rows[0]?.count ?? 0;
}

async function enqueueNoop(
  workflowId: string,
  note: string,
): Promise<NoopProofResult> {
  const handle = await client.enqueue(
    {
      workflowName: WORKFLOW_NAMES.noopProof,
      queueName: WORKFLOW_QUEUE.noopProof,
      workflowID: workflowId,
    },
    { note },
  );
  return (await handle.getResult()) as NoopProofResult;
}

beforeAll(async () => {
  await launchDbos(env);
  client = await DBOSClient.create({
    systemDatabaseUrl: env.DBOS_DATABASE_URL,
  });
}, 120_000);

afterAll(async () => {
  await client?.destroy().catch(() => {});
  await shutdownDbos();
  await prisma.$disconnect().catch(() => {});
});

describe("noop proof workflow (enqueue → execute → app-DB write)", () => {
  it("enqueues via DBOSClient, completes, and writes exactly one app-DB row; re-enqueue with the same workflowID runs exactly once", async () => {
    const workflowId = `noop-proof-${randomUUID()}`;
    const note = "first-run";

    // First enqueue → runs → writes one row.
    const result = await enqueueNoop(workflowId, note);
    expect(result.workflowId).toBe(workflowId);
    expect(result.recordedNote).toBe(note);
    expect(await countRows(workflowId)).toBe(1);

    // Re-enqueue with the SAME workflowID = the idempotency key. DBOS must NOT
    // re-execute: the plain INSERT means a second execution would have produced a
    // second row. Exactly-once ⇒ the count is still 1 and the result is stable.
    const replay = await enqueueNoop(workflowId, "second-run-ignored");
    expect(replay.workflowId).toBe(workflowId);
    // The original result is what's returned (the re-enqueue attaches to the
    // already-completed workflow), so the note is still the first run's.
    expect(replay.recordedNote).toBe(note);
    expect(await countRows(workflowId)).toBe(1);
  });

  it("runs once per distinct workflowID (writes a separate row for a new id)", async () => {
    const idA = `noop-proof-${randomUUID()}`;
    const idB = `noop-proof-${randomUUID()}`;

    await enqueueNoop(idA, "a");
    await enqueueNoop(idB, "b");

    expect(await countRows(idA)).toBe(1);
    expect(await countRows(idB)).toBe(1);
    expect(idA).not.toBe(idB);
  });
});
