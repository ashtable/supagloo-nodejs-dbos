import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import {
  GITHUB_E2E_ENV_VARS,
  resolveGithubE2eSecrets,
} from "../../src/testing/github-e2e";

// Reuse-or-spawn e2e infra for the DBOS suites. The e2es launch the DBOS runtime
// IN-PROCESS (real launch + real queue dispatch) and enqueue via a real DBOSClient.
// Dependencies from the root Compose stack:
//   - `postgres`      hosts BOTH logical databases (app `supagloo` + `supagloo_dbos`)
//                     — all the noop + scaffold workflows write here.
//   - `minio`         the generation + render workflows upload real objects here.
//
// Task 62: the `github-stub` (:4801) and `git-server` (:4805) fixtures are DELETED. Every
// GitHub-touching spec in this lane now reaches REAL github.com / api.github.com, using
// the App credentials from the root `.env`, a runtime-DISCOVERED installation id (never
// the fabricated `42`), and per-run throwaway fixture repos named
// the shared e2e prefix + `<slug>-<runid>`. Accepted, unmitigated consequence
// (design-delta §11.9): this lane no longer runs offline.
//
// GITHUB CREDENTIALS ARE CHECKED HERE BUT GATED PER SPEC, NOT PER LANE.
//
// This lane holds six specs that make ZERO GitHub calls — `noop-workflow`, the four
// `generate-*` specs and `providers` — and only five that touch GitHub
// (scaffold / commit / publish / import / render). A throw here would make a missing
// `GITHUB_E2E_PAT_TOKEN` block all eleven, which is exactly the over-coupling that
// task 34-E8 recorded as a mistake to avoid: it is why the LIVE PROVIDER secrets
// (`OPENROUTER_E2E_TEST_API_KEY`, the Gloo pair, `YOUVERSION_APP_KEY`) are gated inside
// the four `generate-*` specs and deliberately NOT here. GitHub is the same class of
// thing, so it follows the same rule — and it keeps this repo consistent with the api's
// global-setup, which made the identical call in this task.
//
// So: we still resolve the credentials early, because being told before Compose is
// touched is genuinely more useful, but a miss is a WARNING here and a THROW at the
// point of use. That loses nothing — the five GitHub specs call
// `resolveGithubE2eContext()` in their own `beforeAll`, which throws naming the exact
// variable, the root `.env` and `.env.example`. Nothing is ever silently SKIPPED, which
// is the thing plan row 56 item 2 actually forbids (vitest collapses a skipped file's
// console output; a warning from globalSetup runs in the main process and is shown).
// The installation-id/owner discovery fail-fasts live in the shared root harness.
//
// If a healthy stack is already running (developer ran it), reuse it untouched;
// otherwise bring up just these services and tear down on exit.

const DBOS_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const ROOT_REPO =
  process.env.SUPAGLOO_ROOT_DIR ?? resolve(DBOS_ROOT, "..", "supagloo");

const APP_URL =
  process.env.DATABASE_URL ??
  "postgres://supagloo:supagloo@localhost:5432/supagloo";
const SYSTEM_URL =
  process.env.DBOS_DATABASE_URL ??
  "postgres://supagloo:supagloo@localhost:5432/supagloo_dbos";
// Task 34-E8 (design-delta §10.7): the openrouter/gloo/youversion stubs are DELETED.
// The provider-call layer (providers.e2e) + the generate-*.e2e workflows now reach the
// LIVE hosts (OPENROUTER_BASE_URL / GLOO_BASE_URL / YOUVERSION_BASE_URL default to the
// real providers via the env schema), and fail fast on missing secrets via their own
// `resolveGenerationSeedCreds()` — so this global-setup neither brings up nor probes
// those stubs, and needs no provider secret to bring up infra. Task 62 does the same for
// GitHub: there is no GitHub service to bring up or probe any more, only the credential
// gate below.
// Task #32 generateImageWorkflow: the in-process worker uploads generated assets to the
// Compose MinIO, reachable from the host at the PUBLIC endpoint (localhost:9000).
const S3_PUBLIC_ENDPOINT =
  process.env.S3_PUBLIC_ENDPOINT ?? "http://localhost:9000";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function composeFiles(): string[] {
  const files = ["docker-compose.yml"];
  if (existsSync(resolve(ROOT_REPO, "docker-compose.override.yml"))) {
    files.push("docker-compose.override.yml");
  }
  // The test-enablement overlay (NODE_ENV=development + SUPAGLOO_ENABLE_TEST_SEED=1 +
  // the host-reachable S3_* values) is NOT auto-merged by Compose — pass it explicitly.
  // Since task 62 it carries no stub services and no GitHub overrides at all.
  files.push("docker-compose.test.yml");
  return files;
}

function compose(args: string[]): void {
  const fileArgs = composeFiles().flatMap((f) => ["-f", f]);
  execFileSync("docker", ["compose", ...fileArgs, ...args], {
    cwd: ROOT_REPO,
    stdio: "inherit",
  });
}

async function pgReachable(url: string): Promise<boolean> {
  const client = new Client({ connectionString: url });
  try {
    await client.connect();
    await client.query("SELECT 1");
    return true;
  } catch {
    return false;
  } finally {
    await client.end().catch(() => {});
  }
}

async function bothDbsReachable(): Promise<boolean> {
  return (await pgReachable(APP_URL)) && (await pgReachable(SYSTEM_URL));
}

// Task #32: the Compose MinIO must be up (the image workflow uploads a real object).
async function minioReady(): Promise<boolean> {
  try {
    const res = await fetch(`${S3_PUBLIC_ENDPOINT}/minio/health/live`, {
      signal: AbortSignal.timeout(3000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function allReady(): Promise<boolean> {
  return (await bothDbsReachable()) && (await minioReady());
}

async function waitFor(
  fn: () => Promise<boolean>,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fn()) return true;
    await sleep(2000);
  }
  return false;
}

/**
 * Task 62 / design-delta §10.8 — surface a missing real-GitHub credential EARLY, before
 * anything slow happens, without coupling the whole lane to it (see the header note).
 *
 * Load the root `.env` first so the common case (credentials present in the untracked
 * file, nothing exported) is silent. Then probe: a miss WARNS here and names the five
 * GitHub-touching specs, and the actual THROW happens in those specs' own `beforeAll`
 * via `resolveGithubE2eContext()`, which names the exact variable, the root `.env` and
 * `.env.example`. The six specs that make no GitHub call stay runnable with no PAT at
 * all — exactly as the live-provider secrets already behave in this file.
 */
const GITHUB_TOUCHING_SPECS =
  "scaffold-project, commit-version, publish-version, import-project, render.render";

function warnIfGithubE2eCredentialsMissing(): void {
  const envFile = resolve(ROOT_REPO, ".env");
  if (existsSync(envFile)) {
    try {
      process.loadEnvFile(envFile);
    } catch {
      // Unparseable root .env — the per-variable message below is the actionable one.
    }
  }
  try {
    resolveGithubE2eSecrets(process.env);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    // eslint-disable-next-line no-console
    console.warn(
      `[dbos e2e global-setup] Real-GitHub credentials are not fully configured, so the ` +
        `GitHub-touching specs (${GITHUB_TOUCHING_SPECS}) will FAIL in their beforeAll. ` +
        `The specs that make no GitHub call are unaffected and will run normally.\n` +
        `  All four vars (${GITHUB_E2E_ENV_VARS.join(", ")}) come from the untracked root ` +
        `.env.\n${detail}`,
    );
  }
}

export default async function setup() {
  warnIfGithubE2eCredentialsMissing();

  if (await allReady()) {
    // Reuse a healthy running stack (Postgres + MinIO) — leave it as-is.
    return;
  }

  if (!existsSync(resolve(ROOT_REPO, "docker-compose.yml"))) {
    throw new Error(
      `DBOS e2e needs the root Compose Postgres (databases supagloo + ` +
        `supagloo_dbos) plus MinIO, but neither a running stack nor the root Compose ` +
        `repo was found at ${ROOT_REPO}. Bring up the stack or set SUPAGLOO_ROOT_DIR. ` +
        `(GitHub is NOT part of the stack any more — this lane talks to real github.com ` +
        `using ${GITHUB_E2E_ENV_VARS.join(", ")} from the root .env.)`,
    );
  }

  compose(["up", "-d", "--build", "postgres", "minio", "minio-init"]);

  if (!(await waitFor(bothDbsReachable, 90_000))) {
    compose(["down"]);
    throw new Error(
      "Postgres (with both supagloo + supagloo_dbos databases) did not become " +
        "reachable within 90s",
    );
  }
  if (!(await waitFor(minioReady, 60_000))) {
    compose(["down"]);
    throw new Error("minio (health/live) not ready within 60s");
  }

  return async () => {
    compose(["down"]);
  };
}
