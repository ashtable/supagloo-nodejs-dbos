import { loadEnv } from "./config/env";
import { launchDbos, shutdownDbos } from "./dbos/runtime";
import { WORKER_FAILED_LOG, WORKER_READY_LOG } from "./dbos/worker-log";

/**
 * Process entry point for the DBOS worker. The `dbos` Compose service runs this
 * via `node dist/main.js`. It validates the environment (fail-fast), launches the
 * DBOS runtime (which registers the static queues and starts polling them), and
 * then stays alive: `DBOS.launch()` opens the system-db connection pool + queue
 * dispatch pollers, which keep the event loop running until the process is
 * signaled. Work arrives externally — the API enqueues via `DBOSClient`.
 */
async function main(): Promise<void> {
  const env = loadEnv();
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
        console.error("[supagloo-dbos] error during shutdown:", err);
      })
      .finally(() => process.exit(0));
  });
}

void main().catch((err) => {
  console.error(WORKER_FAILED_LOG, err);
  process.exit(1);
});
