import { defineConfig } from "vitest/config";

// E2E config: launches the REAL DBOS runtime in-process against the Compose
// Postgres (both the app db `supagloo` and the DBOS system db `supagloo_dbos`),
// then enqueues via a real DBOSClient. No browser. globalSetup reuse-or-spawns
// just Postgres from the root Compose stack.
export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/e2e/**/*.e2e.ts"],
    // The Remotion bundle e2e (*.bundle.e2e.ts) is DB-free and runs via its own
    // no-globalSetup config (vitest.e2e.bundle.config.ts) — keep it out of the
    // Postgres-backed DB e2e run so it never double-runs or spins Postgres.
    exclude: ["**/node_modules/**", "**/dist/**", "tests/e2e/**/*.bundle.e2e.ts"],
    testTimeout: 60_000,
    // Generous hook timeout: globalSetup may spin up Postgres (reuse-or-spawn)
    // and beforeAll launches DBOS (which migrates its own system-db schema).
    hookTimeout: 200_000,
    fileParallelism: false,
    globalSetup: ["tests/e2e/global-setup.ts"],
  },
});
