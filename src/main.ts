import { loadEnv } from "./config/env";
import { launchDbos, shutdownDbos } from "./dbos/runtime";
import { WORKER_FAILED_LOG, WORKER_READY_LOG } from "./dbos/worker-log";
import { redactForLog, registerLogSecrets } from "./logging/redact";

/**
 * Process entry point for the DBOS worker. The `dbos` Compose service runs this
 * via `node dist/main.js`. It validates the environment (fail-fast), launches the
 * DBOS runtime (which registers the static queues and starts polling them), and
 * then stays alive: `DBOS.launch()` opens the system-db connection pool + queue
 * dispatch pollers, which keep the event loop running until the process is
 * signaled. Work arrives externally — the API enqueues via `DBOSClient`.
 *
 * Plan row 43: this is also the ONE place log redaction is armed. `registerLogSecrets`
 * runs immediately after `loadEnv` — before anything can fail with a secret in hand — and
 * every `console.error` payload below goes through `redactForLog`. See `logging/redact.ts`
 * for what shape-matching alone cannot catch and why the configured values are registered.
 */
async function main(): Promise<void> {
  const env = loadEnv();
  // The secrets with no recognisable SHAPE — a redactor cannot pattern-match an S3 secret
  // key or a YouVersion app key, so the validated values are registered by exact match.
  // `SECRETS_ENCRYPTION_KEY` and the App private key are shape-matched as well; registering
  // them too costs nothing and closes the gap if a key format ever changes.
  registerLogSecrets([
    env.SECRETS_ENCRYPTION_KEY,
    env.GITHUB_APP_PRIVATE_KEY,
    env.S3_SECRET_KEY,
    env.S3_ACCESS_KEY,
    env.YOUVERSION_APP_KEY,
  ]);
  await launchDbos(env);
  // The nextjs render-lane globalSetup scrapes this exact line out of
  // `docker compose logs dbos` to prove the containerised worker booted (task 62 D23),
  // so it is a pinned constant rather than an inline literal — see ./dbos/worker-log.
  // eslint-disable-next-line no-console
  console.log(WORKER_READY_LOG);
}

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    void shutdownDbos()
      .catch((err) => {
        console.error("[supagloo-dbos] error during shutdown:", redactForLog(err));
      })
      .finally(() => process.exit(0));
  });
}

void main().catch((err) => {
  // `WORKER_FAILED_LOG` stays argument 0, byte-identical and unprefixed: the nextjs render
  // lane treats its presence in the `docker compose logs --no-color dbos` tail as a HARD
  // failure, so reformatting it breaks another repo's lane invisibly. Only the PAYLOAD is
  // redacted — and the payload is exactly where a bad `GITHUB_APP_PRIVATE_KEY` or a DSN
  // password would otherwise be printed at boot, in full, into a shared log stream.
  console.error(WORKER_FAILED_LOG, redactForLog(err));
  process.exit(1);
});
