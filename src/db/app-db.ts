import type { PrismaClient } from "@supagloo/database-lib";

/**
 * The worker's APP-database access (the `supagloo` db, via db-lib's Prisma
 * client) — deliberately separate from the DBOS SYSTEM database (`supagloo_dbos`).
 * The client is injected at launch (`runtime.ts` → `setAppDb`) so workflow steps
 * never read process.env or construct their own connection.
 *
 * The `noop_proof` table is a self-managed proof-of-mechanism artifact: dbos has
 * no `migrate` service (only the API runs `prisma migrate deploy`) and we may not
 * add it to db-lib's Prisma schema, so the worker creates it idempotently at boot
 * via raw SQL. It is NOT part of the Prisma schema.
 */

let appDb: PrismaClient | undefined;

export function setAppDb(client: PrismaClient): void {
  appDb = client;
}

export function getAppDb(): PrismaClient {
  if (!appDb) {
    throw new Error(
      "app-db not initialized — launchDbos() must run setAppDb() before workflows execute",
    );
  }
  return appDb;
}

export function clearAppDb(): void {
  appDb = undefined;
}

/** Idempotently create the self-managed proof table in the app db. */
export async function ensureNoopProofTable(client: PrismaClient): Promise<void> {
  await client.$executeRawUnsafe(
    `CREATE TABLE IF NOT EXISTS noop_proof (
       id BIGSERIAL PRIMARY KEY,
       workflow_id TEXT NOT NULL,
       note TEXT,
       recorded_at TIMESTAMPTZ NOT NULL DEFAULT now()
     )`,
  );
}

/**
 * Append one proof row for a workflow run. Deliberately a plain INSERT (not an
 * upsert): if a workflow were ever to execute twice, this would produce two rows —
 * so the e2e's "exactly one row per workflowID" assertion is a real exactly-once
 * proof, backed by DBOS's workflowID idempotency.
 */
export async function recordNoopProof(
  workflowId: string,
  note: string | null,
): Promise<void> {
  await getAppDb()
    .$executeRaw`INSERT INTO noop_proof (workflow_id, note) VALUES (${workflowId}, ${note})`;
}
