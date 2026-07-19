import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";

// Reuse-or-spawn e2e infra for the DBOS noop-workflow suite. The e2e launches the
// DBOS runtime IN-PROCESS (real launch + real queue dispatch) and enqueues via a
// real DBOSClient. Its only external dependency is the root Compose Postgres, which
// via the pg-init script (Task #3) hosts BOTH logical databases:
//   - `supagloo`      (app db — the noop workflow writes its `noop_proof` row here)
//   - `supagloo_dbos` (DBOS system db — DBOS creates its own tables here on launch)
//
// No migrations/stubs/minio are needed: the noop makes no provider calls and
// self-creates its `noop_proof` table via raw SQL at worker boot. If a healthy
// Postgres with both DBs is already up (developer already ran the stack), reuse it
// untouched; otherwise bring up just `postgres` from the root Compose files.

const DBOS_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const ROOT_REPO =
  process.env.SUPAGLOO_ROOT_DIR ?? resolve(DBOS_ROOT, "..", "supagloo");

const APP_URL =
  process.env.DATABASE_URL ??
  "postgres://supagloo:supagloo@localhost:5432/supagloo";
const SYSTEM_URL =
  process.env.DBOS_DATABASE_URL ??
  "postgres://supagloo:supagloo@localhost:5432/supagloo_dbos";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function composeFiles(): string[] {
  const files = ["docker-compose.yml"];
  if (existsSync(resolve(ROOT_REPO, "docker-compose.override.yml"))) {
    files.push("docker-compose.override.yml");
  }
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

export default async function setup() {
  if (await bothDbsReachable()) {
    // Reuse a healthy running Postgres (both DBs present) — leave it as-is.
    return;
  }

  if (!existsSync(resolve(ROOT_REPO, "docker-compose.yml"))) {
    throw new Error(
      `DBOS e2e needs the root Compose Postgres (databases supagloo + ` +
        `supagloo_dbos), but neither a running Postgres nor the root Compose repo ` +
        `was found at ${ROOT_REPO}. Bring up the stack (root repo: docker compose ` +
        `up -d postgres) or set SUPAGLOO_ROOT_DIR.`,
    );
  }

  compose(["up", "-d", "postgres"]);

  if (!(await waitFor(bothDbsReachable, 90_000))) {
    compose(["down"]);
    throw new Error(
      "Postgres (with both supagloo + supagloo_dbos databases) did not become " +
        "reachable within 90s",
    );
  }

  return async () => {
    compose(["down"]);
  };
}
