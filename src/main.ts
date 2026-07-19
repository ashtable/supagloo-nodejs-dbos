import { loadEnv } from "./config/env";
import { launchDbos, shutdownDbos } from "./dbos/runtime";

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
  // eslint-disable-next-line no-console
  console.log(
    "[supagloo-dbos] worker launched — static queues registered, polling for work",
  );
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
  console.error("[supagloo-dbos] failed to launch:", err);
  process.exit(1);
});
