import { DBOS } from "@dbos-inc/dbos-sdk";
import { createPrismaClient, type PrismaClient } from "@supagloo/database-lib";
import { DBOS_APP_NAME, type Env } from "../config/env";
import { QUEUE_CONFIG } from "./registry";
import { clearAppDb, ensureNoopProofTable, setAppDb } from "../db/app-db";
import {
  clearScaffoldConfig,
  setScaffoldConfig,
} from "../workflows/scaffold-project/config";
import {
  clearProviderConfig,
  setProviderConfig,
} from "../providers/config";
import { clearS3Config, setS3Config } from "../files/s3-config";
import { makeInternalS3Client } from "../files/s3-client";
// Importing the workflow modules performs their STATIC registration
// (DBOS.registerWorkflow at module load) — this MUST happen before DBOS.launch().
import "../workflows/noop-proof";
import "../workflows/scaffold-project";
import "../workflows/import-project";
import "../workflows/commit-version";
import "../workflows/publish-version";
import "../workflows/generate-script";
import "../workflows/generate-image";

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

  // Inject the provider-call config (task #29): outbound LLM/media base URLs + the
  // secrets key the credential-load step decrypts with. Same injection discipline as
  // the app db + scaffold config — step helpers read getProviderConfig(), never env.
  setProviderConfig({
    openrouterBaseUrl: env.OPENROUTER_BASE_URL,
    glooBaseUrl: env.GLOO_BASE_URL,
    // Task #30: the YouVersion Data Exchange host fetchScripturePassage reads (real host in
    // prod, the youversion-stub in test); the optional real-API app key.
    youversionBaseUrl: env.YOUVERSION_BASE_URL,
    youversionAppKey: env.YOUVERSION_APP_KEY,
    secretsEncryptionKey: env.SECRETS_ENCRYPTION_KEY,
  });

  // Inject the S3 config (task #32): the internal-role client the asset-uploading workflows
  // PUT generated assets with (design §4/§8). Built ONCE here from the validated env — the
  // upload step reads getS3Config(), never process.env. Cleared (+ client destroyed) on shutdown.
  setS3Config({
    client: makeInternalS3Client({
      endpoint: env.S3_ENDPOINT,
      region: env.S3_REGION,
      bucket: env.S3_BUCKET,
      accessKey: env.S3_ACCESS_KEY,
      secretKey: env.S3_SECRET_KEY,
    }),
    bucket: env.S3_BUCKET,
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
  clearProviderConfig();
  clearS3Config();
  if (appDb) {
    await appDb.$disconnect().catch(() => {});
    appDb = undefined;
  }
}
