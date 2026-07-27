import { loadEnv } from "./config/env";
import { launchDbos, shutdownDbos } from "./dbos/runtime";
import { WORKER_FAILED_LOG, WORKER_READY_LOG } from "./dbos/worker-log";
import {
  bootLogSecrets,
  redactForLog,
  redactForLogSafe,
  registerLogSecrets,
} from "./logging/redact";
// Plan row 42 / D42.1 — THE ONLY IMPORT OF THIS MODULE, ANYWHERE. Importing it arms the
// daily `cleanupOrphanedAssetsWorkflow` schedule (a module-load side effect). Because the
// fifteen e2e lanes launch the runtime via `dbos/runtime.ts#launchDbos` and never load
// this file, the schedule is inert in every lane BY CONSTRUCTION — which matters because
// that workflow deletes objects from the one shared MinIO bucket and rows from the shared
// app database. `src/dbos/scheduled-cleanup.fence.test.ts` holds the property.
import "./dbos/scheduled-cleanup";

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
  // WHICH values are registered lives in `logging/redact.ts#bootLogSecrets`, so it can be
  // unit-tested — importing this file launches the worker, so anything asserted only here is
  // asserted by reading source text. Step-11 item 19 added the two parsed DSN passwords:
  // layer 1's URL-userinfo redaction alone leaked the tail of a password containing `@`, and
  // can only ever match text shaped like a URL.
  registerLogSecrets(bootLogSecrets(env));
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
  // `redactForLogSafe` CANNOT throw (item 18 / R4344-6). That matters structurally, not
  // cosmetically: the argument is evaluated before `console.error` runs, so a throw inside the
  // serializer would suppress BOTH this line and the `process.exit(1)` below — the worker
  // would stay Up with a broken runtime and no signal, and the nextjs render lane would hang
  // waiting for a marker that never arrives.
  console.error(WORKER_FAILED_LOG, redactForLogSafe(err));
  process.exit(1);
});
