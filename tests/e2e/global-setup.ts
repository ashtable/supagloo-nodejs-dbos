import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";

// Reuse-or-spawn e2e infra for the DBOS suites. The e2es launch the DBOS runtime
// IN-PROCESS (real launch + real queue dispatch) and enqueue via a real DBOSClient.
// Dependencies from the root Compose stack:
//   - `postgres`      hosts BOTH logical databases (app `supagloo` + `supagloo_dbos`)
//                     — all the noop + scaffold workflows write here.
//   - `github-stub`   (docker-compose.test.yml, host :4801) — the scaffold workflow
//                     mints installation tokens + opens/merges the base PR here.
//   - `git-server`    (docker-compose.test.yml, host :4805) — real clone/push target.
//
// The noop suite only needs Postgres; the scaffold suite needs all three. We bring
// up the superset. If a healthy stack is already running (developer ran it), reuse
// it untouched; otherwise bring up just these services (with --build so the stub
// images carry the routes this suite uses) and tear down on exit.

const DBOS_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const ROOT_REPO =
  process.env.SUPAGLOO_ROOT_DIR ?? resolve(DBOS_ROOT, "..", "supagloo");

const APP_URL =
  process.env.DATABASE_URL ??
  "postgres://supagloo:supagloo@localhost:5432/supagloo";
const SYSTEM_URL =
  process.env.DBOS_DATABASE_URL ??
  "postgres://supagloo:supagloo@localhost:5432/supagloo_dbos";
const GITHUB_STUB = process.env.GITHUB_STUB_URL ?? "http://localhost:4801";
const GIT_SERVER = process.env.GIT_SERVER_URL ?? "http://localhost:4805";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function composeFiles(): string[] {
  const files = ["docker-compose.yml"];
  if (existsSync(resolve(ROOT_REPO, "docker-compose.override.yml"))) {
    files.push("docker-compose.override.yml");
  }
  // The provider stubs (github-stub, git-server) live in the test-only overlay,
  // which Compose does NOT auto-merge — pass it explicitly.
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

async function githubStubReady(): Promise<boolean> {
  try {
    const health = await fetch(`${GITHUB_STUB}/__stub/health`, {
      signal: AbortSignal.timeout(3000),
    });
    if (!health.ok) return false;
    // A current github-stub (Task #11) 401s the installation-repos route without an
    // installation token; a stale image (pre-#11) 404s it. Distinguish so a
    // reused-but-stale stack is rebuilt rather than silently failing this suite.
    const probe = await fetch(`${GITHUB_STUB}/installation/repositories`, {
      signal: AbortSignal.timeout(3000),
    });
    return probe.status === 401;
  } catch {
    return false;
  }
}

async function gitServerReady(): Promise<boolean> {
  try {
    // The git-server's /__stub/health is a DEEP probe (spawns a real git-http-backend
    // CGI round-trip), so res.ok means the CGI is warm — not just the listener up.
    const health = await fetch(`${GIT_SERVER}/__stub/health`, {
      signal: AbortSignal.timeout(5000),
    });
    return health.ok;
  } catch {
    return false;
  }
}

async function allReady(): Promise<boolean> {
  return (
    (await bothDbsReachable()) &&
    (await githubStubReady()) &&
    (await gitServerReady())
  );
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
  if (await allReady()) {
    // Reuse a healthy running stack (Postgres + stubs) — leave it as-is.
    return;
  }

  if (!existsSync(resolve(ROOT_REPO, "docker-compose.yml"))) {
    throw new Error(
      `DBOS e2e needs the root Compose Postgres (databases supagloo + ` +
        `supagloo_dbos) plus the github-stub + git-server, but neither a running ` +
        `stack nor the root Compose repo was found at ${ROOT_REPO}. Bring up the ` +
        `stack or set SUPAGLOO_ROOT_DIR.`,
    );
  }

  compose(["up", "-d", "--build", "postgres", "github-stub", "git-server"]);

  if (!(await waitFor(bothDbsReachable, 90_000))) {
    compose(["down"]);
    throw new Error(
      "Postgres (with both supagloo + supagloo_dbos databases) did not become " +
        "reachable within 90s",
    );
  }
  if (!(await waitFor(githubStubReady, 60_000))) {
    compose(["down"]);
    throw new Error("github-stub (with installation-repos route) not ready within 60s");
  }
  if (!(await waitFor(gitServerReady, 60_000))) {
    compose(["down"]);
    throw new Error("git-server not ready within 60s");
  }

  return async () => {
    compose(["down"]);
  };
}
