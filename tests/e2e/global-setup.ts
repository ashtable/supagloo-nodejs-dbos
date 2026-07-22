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
// Task #29 provider-call layer: the openrouter-stub (:4802) + gloo-stub (:4803)
// serve the discovery/generateObject/token-mint/media round-trips the providers
// e2e drives. Same host ports as docker-compose.test.yml (memory provider-stub-harness).
const OPENROUTER_STUB = process.env.OPENROUTER_STUB_URL ?? "http://localhost:4802";
const GLOO_STUB = process.env.GLOO_STUB_URL ?? "http://localhost:4803";
// Task #30 generateScriptWorkflow: the youversion-stub (:4804) serves "Get a Bible
// collection" + passage fetch for fetchScripturePassage. Same host port as
// docker-compose.test.yml.
const YOUVERSION_STUB = process.env.YOUVERSION_STUB_URL ?? "http://localhost:4804";
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

async function stubHealthy(baseUrl: string): Promise<boolean> {
  try {
    const res = await fetch(`${baseUrl}/__stub/health`, {
      signal: AbortSignal.timeout(3000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

// Staleness probes (task #29): a reused-but-stale stub image (built before this
// task's stub edits) is healthy but serves the OLD contract, so gate on the NEW
// behavior — otherwise the providers e2e silently runs against a stale stub. Mirrors
// the githubStubReady staleness check.
async function openRouterStubReady(): Promise<boolean> {
  if (!(await stubHealthy(OPENROUTER_STUB))) return false;
  try {
    // The NEW /api/v1/models filters by output_modalities → exactly the text model;
    // a stale image returns the full unfiltered catalogue.
    const res = await fetch(
      `${OPENROUTER_STUB}/api/v1/models?output_modalities=text`,
      { signal: AbortSignal.timeout(3000) },
    );
    if (!res.ok) return false;
    const ids = ((await res.json()) as { data: Array<{ id: string }> }).data.map(
      (m) => m.id,
    );
    if (!(ids.length === 1 && ids[0] === "stub/text-model")) return false;
    // Task #30 staleness probe: the programmable chat-script admin route must exist (a
    // pre-#30 image 404s it). Programming an EMPTY script is a harmless no-op reset.
    const admin = await fetch(`${OPENROUTER_STUB}/__admin/chat-script`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ responses: [] }),
      signal: AbortSignal.timeout(3000),
    });
    if (!admin.ok) return false;
    // Task #32 staleness probe: the image-generation route must exist (a pre-#32 image 404s
    // it), so a reused-but-stale stub is rebuilt rather than silently failing the image e2e.
    const image = await fetch(`${OPENROUTER_STUB}/api/v1/images/generations`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "stub/image-model", prompt: "probe" }),
      signal: AbortSignal.timeout(3000),
    });
    if (!image.ok) return false;
    // Task #33 staleness probe: the programmable speech-script admin route must exist (a pre-#33
    // image 404s it), so a reused-but-stale stub is rebuilt rather than silently failing the
    // generate-audio retry e2e. Programming an EMPTY script is a harmless no-op reset.
    const speechAdmin = await fetch(`${OPENROUTER_STUB}/__admin/speech-script`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ responses: [] }),
      signal: AbortSignal.timeout(3000),
    });
    return speechAdmin.ok;
  } catch {
    return false;
  }
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

// Task #30: the youversion-stub serves the Bible collection (kjv/bsb) + passage fetch.
async function youversionStubReady(): Promise<boolean> {
  if (!(await stubHealthy(YOUVERSION_STUB))) return false;
  try {
    const res = await fetch(`${YOUVERSION_STUB}/data-exchange/v1/bibles`, {
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return false;
    const ids = ((await res.json()) as { data: Array<{ id: string }> }).data.map(
      (b) => b.id,
    );
    return ids.includes("kjv") && ids.includes("bsb");
  } catch {
    return false;
  }
}

async function glooStubReady(): Promise<boolean> {
  if (!(await stubHealthy(GLOO_STUB))) return false;
  try {
    // The NEW stub serves the REAL slash path /ai/v2/chat/completions (401 without a
    // bearer); a stale image only has the hyphenated path and 404s the slash one.
    const res = await fetch(`${GLOO_STUB}/ai/v2/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
      signal: AbortSignal.timeout(3000),
    });
    return res.status === 401;
  } catch {
    return false;
  }
}

async function allReady(): Promise<boolean> {
  return (
    (await bothDbsReachable()) &&
    (await githubStubReady()) &&
    (await gitServerReady()) &&
    (await openRouterStubReady()) &&
    (await glooStubReady()) &&
    (await youversionStubReady()) &&
    (await minioReady())
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

  compose([
    "up",
    "-d",
    "--build",
    "postgres",
    "github-stub",
    "git-server",
    "openrouter-stub",
    "gloo-stub",
    "youversion-stub",
    "minio",
    "minio-init",
  ]);

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
  if (!(await waitFor(openRouterStubReady, 60_000))) {
    compose(["down"]);
    throw new Error("openrouter-stub not ready within 60s");
  }
  if (!(await waitFor(glooStubReady, 60_000))) {
    compose(["down"]);
    throw new Error("gloo-stub not ready within 60s");
  }
  if (!(await waitFor(youversionStubReady, 60_000))) {
    compose(["down"]);
    throw new Error("youversion-stub (with the Bible collection route) not ready within 60s");
  }
  if (!(await waitFor(minioReady, 60_000))) {
    compose(["down"]);
    throw new Error("minio (health/live) not ready within 60s");
  }

  return async () => {
    compose(["down"]);
  };
}
