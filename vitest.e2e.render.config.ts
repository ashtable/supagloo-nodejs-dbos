import { defineConfig } from "vitest/config";

// SLOW e2e lane — the render workflow (task #36).
//
// This is by far the heaviest spec in the repo: it does a REAL `npm install` of a
// Remotion project from the public registry, a REAL webpack bundle, and a REAL
// `@remotion/renderer` H.264 encode driven by a REAL headless Chromium — plus (for the
// synthesis spec) a live OpenRouter TTS call. Minutes, not seconds.
//
// It gets its own config for the same reason `vitest.e2e.bundle.config.ts` does: so the
// ordinary DB e2e lane (`vitest.e2e.config.ts`, 60s timeouts) stays fast and is not held
// hostage to Chromium. `plan.md` row 36 calls this suite "tagged slow"; the tag here is
// the dedicated `*.render.e2e.ts` filename + this config + the `test:e2e:render` script.
//
// It DOES need the Compose infra (Postgres app+system DBs, MinIO, github-stub,
// git-server), so unlike the bundle config it keeps the shared globalSetup.
export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/e2e/**/*.render.e2e.ts"],
    // npm install + webpack + Chromium download + encode. Deliberately generous;
    // real tuning is task 45 (design-delta §9-Q8).
    testTimeout: 1_200_000,
    hookTimeout: 600_000,
    fileParallelism: false,
    globalSetup: ["tests/e2e/global-setup.ts"],
  },
});
