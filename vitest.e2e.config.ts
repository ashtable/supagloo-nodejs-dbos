import { defineConfig } from "vitest/config";

// E2E config: launches the REAL DBOS runtime in-process against the Compose
// Postgres (both the app db `supagloo` and the DBOS system db `supagloo_dbos`),
// then enqueues via a real DBOSClient. No browser. globalSetup reuse-or-spawns
// Postgres + MinIO from the root Compose stack.
//
// Task 62: the git-ops specs in this lane reach REAL github.com / api.github.com (the
// github-stub + git-server fixtures are deleted), so the lane needs the root `.env`
// GitHub App credentials + `GITHUB_E2E_PAT_TOKEN` and real network egress. `setupFiles`
// loads that root `.env` into each WORKER — globalSetup runs in the main process, so env
// set there would never reach a spec (D24).
export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/e2e/**/*.e2e.ts"],
    // The Remotion bundle e2e (*.bundle.e2e.ts) is DB-free and runs via its own
    // no-globalSetup config (vitest.e2e.bundle.config.ts) — keep it out of the
    // Postgres-backed DB e2e run so it never double-runs or spins Postgres.
    //
    // The render e2e (*.render.e2e.ts, task #36) IS DB-backed but is the SLOW lane —
    // real `npm install`, real webpack bundle, real Chromium H.264 encode, minutes per
    // spec. It runs via vitest.e2e.render.config.ts (20-minute timeouts) so this lane
    // keeps its 60s budget and stays fast.
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      "tests/e2e/**/*.bundle.e2e.ts",
      "tests/e2e/**/*.render.e2e.ts",
    ],
    testTimeout: 60_000,
    // Generous hook timeout: globalSetup may spin up Postgres (reuse-or-spawn)
    // and beforeAll launches DBOS (which migrates its own system-db schema).
    hookTimeout: 200_000,
    fileParallelism: false,
    globalSetup: ["tests/e2e/global-setup.ts"],
    setupFiles: ["tests/e2e/load-root-env.ts"],
  },
});
