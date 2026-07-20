import { DBOS } from "@dbos-inc/dbos-sdk";
import { createPrismaClient, type PrismaClient } from "@supagloo/database-lib";
import { DBOS_APP_NAME, type Env } from "../config/env";
import { QUEUE_CONFIG } from "./registry";
import { clearAppDb, ensureNoopProofTable, setAppDb } from "../db/app-db";
import {
  clearScaffoldConfig,
  setScaffoldConfig,
} from "../workflows/scaffold-project/config";
// Importing the workflow modules performs their STATIC registration
// (DBOS.registerWorkflow at module load) — this MUST happen before DBOS.launch().
import "../workflows/noop-proof";
import "../workflows/scaffold-project";

let appDb: PrismaClient | undefined;

/**
 * Launch the DBOS worker.
 *
 * Order matters and honors the SDK contract (verified @dbos-inc/dbos-sdk@4.23.6):
 *   1. connect the APP db (`supagloo`) + ensure the self-managed proof table;
 *   2. `DBOS.setConfig({ systemDatabaseUrl })` pointing at the SYSTEM db
 *      (`supagloo_dbos`) — a DIFFERENT database from the app db;
 *   3. workflows are already registered (module-load side effect of the import
 *      above), so `DBOS.launch()` sees the static workflow graph;
 *   4. persist the static queue table via `DBOS.registerQueue` — this SDK requires
 *      it AFTER launch (so an external DBOSClient can see the queue rows). The
 *      names/concurrency come straight from the frozen QUEUE_CONFIG; nothing is
 *      constructed dynamically.
 */
export async function launchDbos(env: Env): Promise<void> {
  appDb = createPrismaClient({ connectionString: env.DATABASE_URL });
  setAppDb(appDb);
  await ensureNoopProofTable(appDb);

  // Inject the app-level GitHub config the git-ops workflows read (mirrors setAppDb:
  // steps never touch process.env). App id/key sign App JWTs; base URLs are
  // env-overridable (real hosts in prod, stub URLs in test).
  setScaffoldConfig({
    githubApiBaseUrl: env.GITHUB_API_BASE_URL,
    githubGitBaseUrl: env.GITHUB_GIT_BASE_URL,
    githubAppId: env.GITHUB_APP_ID,
    githubAppPrivateKey: env.GITHUB_APP_PRIVATE_KEY,
  });

  DBOS.setConfig({
    name: DBOS_APP_NAME,
    systemDatabaseUrl: env.DBOS_DATABASE_URL,
  });
  await DBOS.launch();

  for (const [name, config] of Object.entries(QUEUE_CONFIG)) {
    await DBOS.registerQueue(name, config);
  }
}

/** Gracefully stop the worker and release both database connections. */
export async function shutdownDbos(): Promise<void> {
  await DBOS.shutdown();
  clearAppDb();
  clearScaffoldConfig();
  if (appDb) {
    await appDb.$disconnect().catch(() => {});
    appDb = undefined;
  }
}
