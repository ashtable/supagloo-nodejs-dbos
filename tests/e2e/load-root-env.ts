import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Load the ROOT repo's untracked `.env` into every vitest WORKER (task 62 / D24).
 *
 * Why a `setupFiles` entry and not `globalSetup`: vitest runs `globalSetup` in the main
 * process and test files in worker processes, so anything `globalSetup` puts on
 * `process.env` never reaches a spec. The GitHub App credentials + the e2e PAT are read
 * by the specs themselves (through `src/testing/github-e2e.ts`), so they must be present
 * in the worker.
 *
 * `process.loadEnvFile` (Node ≥20.12; this repo runs Node 24) **does not override an
 * already-set variable**, so an explicit `GITHUB_APP_ID=… npm run test:e2e` still wins,
 * and a developer who already sourced the root `.env` sees no change.
 *
 * Deliberately SILENT and non-fatal when the file is absent: this module's job is
 * convenience, not policy. The actionable failure belongs to
 * `resolveGithubE2eSecrets()`, which names the exact missing variable, the root `.env`
 * and `.env.example` — a throw here would instead blame the file and would fire for the
 * provider specs that need no GitHub credential at all.
 *
 * Root's `.env` is the SINGLE credential source for every lane in this repo (the
 * provider e2e secrets — `OPENROUTER_E2E_TEST_API_KEY`, `GLOO_*`, `YOUVERSION_APP_KEY` —
 * live in the same file), so this also removes the `set -a; . ../supagloo/.env; set +a`
 * dance for the generation specs.
 */

const DBOS_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/** Identical seam to `tests/e2e/global-setup.ts` and `src/testing/github-e2e.ts`. */
export function rootEnvFilePath(env: NodeJS.ProcessEnv = process.env): string {
  const root = env.SUPAGLOO_ROOT_DIR ?? resolve(DBOS_ROOT, "..", "supagloo");
  return resolve(root, ".env");
}

const envFile = rootEnvFilePath();
if (existsSync(envFile)) {
  try {
    process.loadEnvFile(envFile);
  } catch {
    // A malformed/unreadable root .env must not take the whole lane down here; the
    // per-variable fail-fast downstream produces the actionable message.
  }
}
