import { defineConfig } from "vitest/config";

// Dedicated e2e config for the Remotion BUNDLE smoke test. Unlike the DB e2e
// (vitest.e2e.config.ts), this needs NO Postgres/DBOS/browser — it is a pure
// filesystem + @remotion/bundler (esbuild/webpack) static build. So it has NO
// globalSetup: coupling an fs+webpack test to the Postgres-spinning globalSetup
// would make it fail for unrelated infra reasons and slow it down. It still lives
// under tests/e2e/ and runs via Vitest for consistency.
export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/e2e/**/*.bundle.e2e.ts"],
    // Cold webpack builds are slow; give each bundle generous headroom.
    testTimeout: 240_000,
    hookTimeout: 240_000,
    fileParallelism: false,
  },
});
