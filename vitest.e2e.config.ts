import { defineConfig } from "vitest/config";

// E2E config: launches the REAL DBOS runtime in-process against the Compose
// Postgres (both the app db `supagloo` and the DBOS system db `supagloo_dbos`),
// then enqueues via a real DBOSClient. No browser. globalSetup reuse-or-spawns
// just Postgres from the root Compose stack.
export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/e2e/**/*.e2e.ts"],
    testTimeout: 60_000,
    // Generous hook timeout: globalSetup may spin up Postgres (reuse-or-spawn)
    // and beforeAll launches DBOS (which migrates its own system-db schema).
    hookTimeout: 200_000,
    fileParallelism: false,
    globalSetup: ["tests/e2e/global-setup.ts"],
  },
});
