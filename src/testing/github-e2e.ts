import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  mintInstallationToken,
  signAppJwt,
  type PrismaClient,
} from "@supagloo/database-lib";

/**
 * The dbos adapter onto task 62's shared real-GitHub e2e harness (plan D3/D4/D5/D6).
 *
 * ## What replaced what
 *
 * Before task 62 the dbos git-ops e2e specs each injected `GITHUB_API_BASE_URL` /
 * `GITHUB_GIT_BASE_URL` pointing at the `github-stub` (:4801) and the `git-server`
 * (:4805), provisioned `acme/<name>` fixture repos through `POST /__admin/repos`, and
 * proved exactly-once side effects by reading the stub's `/__stub/calls` counters. All
 * of that is gone: the stubs are deleted, the specs reach **real github.com /
 * api.github.com**, fixture repos are per-run throwaways on the real account, and
 * exactly-once is proven along TWO independent axes — DBOS system-DB step counts
 * (`step-introspection.ts`) for durability, and real-host artifact reads for
 * non-duplication.
 *
 * Note (synthesis finding F1): the dbos *worker* was already real-by-default — nothing
 * in Compose ever pointed it at the stub, so it had been 404ing on the fabricated
 * installation `42` all along. The stub wiring lived ENTIRELY in the specs, which is
 * why this adapter's job is to hand specs discovered values instead of literals.
 *
 * ## Where the shared code lives, and why not here
 *
 * The e2e repo-name prefix and the network harness live in exactly ONE authored place
 * each, in the ROOT repo:
 *
 *   • `<root>/tests/support/e2e-github-naming.mjs` — the ONE prefix literal (D1; the
 *     literal itself is deliberately not repeated in this repo, so root's anti-drift guard
 *     finds it in exactly one authored file). The
 *     interactive cleanup script matches on it, so a second copy here could drift and
 *     silently orphan real repos on an account that also holds the user's real work.
 *   • `<root>/tests/support/e2e-github-api.mjs` — the ONE network harness (D3):
 *     installation discovery, fixture-repo creation, the readiness/visibility gates,
 *     ref/content seeding, the assertion readers, and the rate-limit backoff.
 *
 * dbos resolves the root checkout through the seam its own `tests/e2e/global-setup.ts`
 * already uses (`SUPAGLOO_ROOT_DIR` ?? sibling `../supagloo`) and DYNAMIC-IMPORTS those
 * zero-dependency ESM modules. dbos deliberately does NOT ask the api container to
 * create repos on its behalf — design-delta §10.3's rejected alternative; the dbos e2e
 * lane stays self-contained.
 *
 * What IS implemented locally, on purpose:
 *   • env-var validation (`resolveGithubE2eSecrets`) — not network, and the message must
 *     name the dbos lane's own remediation. ~20 lines, unit-testable, no root needed.
 *   • the discovered-value plumbing: token minting through the PRODUCT path
 *     (db-lib `mintInstallationToken`), connection-row seeding, remote-URL building.
 *   • a defence-in-depth re-check of the prefix hard gate at the point a repo name is
 *     adopted, so a drifting//broken root harness fails loudly here instead of leaving
 *     an unreclaimable repo behind.
 *
 * ## Credential split (D6, live-verified)
 *
 * The installation grants `contents:write` + `pull_requests:write` + `metadata:read`
 * and NOTHING else — in particular no `administration`. So:
 *   • `POST /user/repos` (create) → the **PAT** (`GITHUB_E2E_PAT_TOKEN`), user-scoped
 *   • branch/file seeding and every assertion READ → the **installation token**, minted
 *     by unchanged product code. A read that succeeds is itself a scoping proof; a PAT
 *     is a stronger credential than production ever holds and would green-light
 *     permissions the product does not have.
 *   • archiving → the PAT, and ONLY from the root cleanup script. There is deliberately
 *     no teardown/archive/delete helper in this file: the user mandated per-repo
 *     interactive confirmation, a red run almost always needs its repo for debugging,
 *     and automated mutation in an account holding real repos is unacceptable.
 *
 * TEST-ONLY infrastructure, excluded from the shipped `dist/` build
 * (`tsconfig.build.json` excludes `src/testing/**`), sitting beside
 * `seed-connections.ts` and `step-introspection.ts` for the same reason: the logic is
 * factored out of the specs so it unit-tests with an injected root harness + injected
 * env + injected `fetch`, keeping the unit lane egress-free (HARD RULE 5).
 */

// ---------------------------------------------------------------------------
// Constants + the module contracts we expect from the root harness
// ---------------------------------------------------------------------------

/** The seam for locating the root checkout — identical to `tests/e2e/global-setup.ts`. */
export const ROOT_DIR_VAR = "SUPAGLOO_ROOT_DIR";
/** Root-relative path of the ONE file allowed to contain the e2e repo prefix (D1). */
export const NAMING_MODULE_REL = "tests/support/e2e-github-naming.mjs";
/** Root-relative path of the ONE real-GitHub network harness (D3). */
export const GITHUB_API_MODULE_REL = "tests/support/e2e-github-api.mjs";

/** The classic PAT that creates (and, from the cleanup script, archives) fixture repos. */
export const GITHUB_E2E_PAT_VAR = "GITHUB_E2E_PAT_TOKEN";
/** Optional: pin the target account when the App has more than one installation (D5). */
export const GITHUB_E2E_OWNER_VAR = "SUPAGLOO_E2E_GITHUB_OWNER";

/**
 * Every environment variable the dbos real-GitHub e2e lane requires, in a stable
 * order — the single source of truth for the fail-fast, mirroring
 * `seed-connections.ts`'s `GENERATION_SEED_ENV_VARS` convention.
 */
export const GITHUB_E2E_ENV_VARS = [
  "GITHUB_APP_ID",
  "GITHUB_APP_SLUG",
  "GITHUB_APP_PRIVATE_KEY",
  GITHUB_E2E_PAT_VAR,
] as const;

/**
 * The remediation URL for "the App is installed nowhere" — the failure that cost plan
 * row 62 item (d) an entire debugging cycle by surfacing as an opaque 404 on
 * `POST /app/installations/42/access_tokens`.
 */
export const GITHUB_APP_INSTALL_URL =
  "https://github.com/apps/supagloo/installations/new";

/** Real GitHub REST host — dbos is real-by-default; there is no stub to point at. */
export const GITHUB_API_BASE_URL = "https://api.github.com";
/** Real git-over-HTTPS host. */
export const GITHUB_GIT_BASE_URL = "https://github.com";

export interface GithubE2eSecrets {
  appId: string;
  appSlug: string;
  /** The App PEM, in whatever form the env holds it — see the note in {@link resolveGithubE2eSecrets}. */
  privateKey: string;
  /** Classic PAT (`repo` + `delete_repo`), user-scoped. Host-side only, NEVER in a container. */
  pat: string;
}

/** The subset of `<root>/tests/support/e2e-github-naming.mjs` dbos consumes (D1). */
export interface RootNamingModule {
  E2E_REPO_PREFIX: string;
  E2E_RUN_ID: string;
  buildE2eRepoName(slug: string, runId: string): string;
  isE2eRepoName(name: string): boolean;
}

export interface DiscoveredInstallation {
  installationId?: string | number;
  /** Some shapes call it `id`; normalised by {@link resolveGithubE2eContext}. */
  id?: string | number;
  ownerLogin?: string;
  owner?: string;
  account?: { login?: string };
}

/**
 * What `createFixtureRepo` hands back. The root harness returns GitHub's RAW repo JSON
 * (`res.body` of `POST /user/repos`), so the authoritative fields are `name`, `full_name`
 * and `owner.login` — `owner` is an OBJECT, not a string. The convenience aliases are
 * accepted too so a future harness that pre-normalises does not break this adapter.
 */
export interface CreatedFixtureRepo {
  owner?: string | { login?: string };
  repo?: string;
  name?: string;
  fullName?: string;
  full_name?: string;
}

/** The subset of `<root>/tests/support/e2e-github-api.mjs` dbos consumes (D3). */
export interface RootGithubApiModule {
  discoverInstallation(args: {
    appId: string;
    appSlug?: string;
    privateKey: string;
    ownerLogin?: string;
    signJwt?: (opts: { appId: string; privateKey: string }) => string | Promise<string>;
  }): Promise<DiscoveredInstallation>;
  createFixtureRepo(args: {
    pat: string;
    slug: string;
    runId: string;
    /** Stamped into the repo DESCRIPTION by the harness, not into its name. */
    spec?: string;
  }): Promise<CreatedFixtureRepo>;
  waitForRepoReady(args: { pat: string; owner: string; repo: string }): Promise<unknown>;
  waitForInstallationVisibility(args: {
    token: string;
    fullName: string;
  }): Promise<unknown>;
  createRef(args: {
    token: string;
    owner: string;
    repo: string;
    branch: string;
    fromBranch?: string;
  }): Promise<unknown>;
  putContents(args: {
    token: string;
    owner: string;
    repo: string;
    branch: string;
    path: string;
    content: string;
  }): Promise<unknown>;
  listPulls(args: {
    token: string;
    owner: string;
    repo: string;
    state: string;
    head?: string;
  }): Promise<Array<Record<string, unknown>>>;
  listTagRefs(args: {
    token: string;
    owner: string;
    repo: string;
  }): Promise<Array<Record<string, unknown>> | string[]>;
  listBranches(args: {
    token: string;
    owner: string;
    repo: string;
  }): Promise<Array<Record<string, unknown>> | string[]>;
  countCommitsOnBranch(args: {
    token: string;
    owner: string;
    repo: string;
    branch: string;
  }): Promise<number>;
}

export interface RootHarness {
  rootDir: string;
  naming: RootNamingModule;
  api: RootGithubApiModule;
}

type EnvSource = Record<string, string | undefined>;

export interface GithubE2eDeps {
  /** Where to read the secrets from. Defaults to `process.env`. */
  env?: EnvSource;
  /** An already-loaded (or faked, in unit tests) root harness. */
  harness?: RootHarness;
  /** Injected `fetch` for the installation-token mint (unit tests). */
  fetchImpl?: typeof fetch;
  /** Injected `existsSync` (unit tests) so the fail-fast text is assertable. */
  existsSyncImpl?: (path: string) => boolean;
  /** Injected dynamic import (unit tests). */
  importModule?: (specifier: string) => Promise<unknown>;
}

// ---------------------------------------------------------------------------
// Root-checkout resolution + harness loading
// ---------------------------------------------------------------------------

/**
 * Resolve the root `supagloo` checkout — the same seam
 * `tests/e2e/global-setup.ts` uses (`SUPAGLOO_ROOT_DIR` ?? sibling `../supagloo`).
 *
 * The sibling fallback is computed from `process.cwd()` rather than from
 * `import.meta.url`: `src/**` typechecks under `"module": "node16"` (CJS output), where
 * `import.meta` is a compile error, and this module must stay inside `src/testing/`
 * beside `step-introspection.ts` / `seed-connections.ts`. Every lane that loads this file
 * runs from the dbos repo root (`npm run test:e2e` / `test:e2e:render`); anything more
 * exotic sets `SUPAGLOO_ROOT_DIR` explicitly, and the fail-fast in
 * {@link loadRootHarness} names that variable.
 */
export function resolveRootRepoDir(env: EnvSource = process.env): string {
  const explicit = env[ROOT_DIR_VAR];
  if (explicit !== undefined && explicit.trim() !== "") return explicit;
  return resolve(process.cwd(), "..", "supagloo");
}

function harnessFailFast(rootDir: string, missing: string[]): never {
  throw new Error(
    `dbos real-GitHub e2e: the shared harness module(s) ${missing.join(" + ")} were ` +
      `not found under the root checkout ${rootDir}. Task 62 D1/D3 put the ONE ` +
      `e2e repo-name prefix literal in ${NAMING_MODULE_REL} and the ONE ` +
      `real-GitHub network harness in ${GITHUB_API_MODULE_REL}, both in the ROOT repo, ` +
      `so the cleanup script's match can never drift from what the specs create. ` +
      `Either the root checkout is somewhere else — set ${ROOT_DIR_VAR}=/path/to/supagloo ` +
      `— or root's phase of this task has not landed yet.`,
  );
}

/**
 * Dynamic-import the two root harness modules, failing fast (naming BOTH the expected
 * path and {@link ROOT_DIR_VAR}) when they are absent. Memoised per process.
 */
export async function loadRootHarness(deps: GithubE2eDeps = {}): Promise<RootHarness> {
  if (deps.harness) return deps.harness;
  if (memo.harness) return memo.harness;

  const env = deps.env ?? process.env;
  const rootDir = resolveRootRepoDir(env);
  const exists = deps.existsSyncImpl ?? existsSync;
  const importModule =
    deps.importModule ?? ((specifier: string) => import(/* @vite-ignore */ specifier));

  const namingPath = resolve(rootDir, NAMING_MODULE_REL);
  const apiPath = resolve(rootDir, GITHUB_API_MODULE_REL);
  const missing = [
    exists(namingPath) ? undefined : NAMING_MODULE_REL,
    exists(apiPath) ? undefined : GITHUB_API_MODULE_REL,
  ].filter((v): v is string => v !== undefined);
  if (missing.length > 0) harnessFailFast(rootDir, missing);

  const naming = (await importModule(
    pathToFileURL(namingPath).href,
  )) as RootNamingModule;
  const api = (await importModule(pathToFileURL(apiPath).href)) as RootGithubApiModule;
  const harness: RootHarness = { rootDir, naming, api };
  memo.harness = harness;
  return harness;
}

// ---------------------------------------------------------------------------
// Secrets
// ---------------------------------------------------------------------------

/**
 * Resolve the four real-GitHub e2e credentials, failing FAST with a message naming the
 * missing var, the root `.env`, and `.env.example` (design-delta §10.8's convention;
 * empty/whitespace counts as missing).
 *
 * It must THROW, never warn-and-skip: vitest's default reporter collapses a skipped
 * file's console output, so a "loud skip" is invisible under `npm run test:e2e` — a
 * green lie (plan row 56 item 2).
 *
 * The PEM is returned VERBATIM. Escaped-`\n` normalisation belongs to db-lib's
 * `normalizePemNewlines`, the deliberate single choke point both services sign through
 * (row 62 item (c)); pre-normalising here would create a second implementation of
 * exactly the thing that broke.
 */
export function resolveGithubE2eSecrets(env: EnvSource = process.env): GithubE2eSecrets {
  const read = (name: string): string => {
    const value = env[name];
    if (value === undefined || value.trim() === "") {
      throw new Error(
        `dbos real-GitHub e2e requires the environment variable ${name}, but it is ` +
          `missing or empty. All four of ${GITHUB_E2E_ENV_VARS.join(", ")} come from the ` +
          `UNTRACKED root .env (documented by name only in the root .env.example — never ` +
          `values). Export them before running the lane, e.g. ` +
          `\`set -a; . ../supagloo/.env; set +a\`, or let the lane's ` +
          `tests/e2e/load-root-env.ts setupFile load them. This lane must never silently ` +
          `skip: a green suite that skipped is a lie.`,
      );
    }
    return value;
  };
  return {
    appId: read("GITHUB_APP_ID"),
    appSlug: read("GITHUB_APP_SLUG"),
    privateKey: read("GITHUB_APP_PRIVATE_KEY"),
    pat: read(GITHUB_E2E_PAT_VAR),
  };
}

// ---------------------------------------------------------------------------
// The resolved context
// ---------------------------------------------------------------------------

export interface GithubE2eContext extends GithubE2eSecrets {
  /** Discovered at runtime — NEVER a literal (D5). */
  installationId: string;
  /** The discovered account login that owns the fixture repos. */
  owner: string;
  /** A freshly minted installation token (`ghs_…`, ~1h) for seeding + assertion reads. */
  token: string;
  /** The per-process run id every fixture repo name carries (D7). */
  runId: string;
  harness: RootHarness;
}

const memo: { harness?: RootHarness; context?: Promise<GithubE2eContext> } = {};

/** Test-only: drop the per-process memoisation. */
export function __resetGithubE2eState(): void {
  delete memo.harness;
  delete memo.context;
}

function normaliseInstallationId(found: DiscoveredInstallation): string {
  const raw = found.installationId ?? found.id;
  if (raw === undefined || String(raw).trim() === "") {
    throw new Error(
      `dbos real-GitHub e2e: the root harness's discoverInstallation() returned no ` +
        `installation id (got ${JSON.stringify(found)}). Installation ids are DISCOVERED, ` +
        `never hardcoded (D5) — if the App is installed nowhere, install it at ` +
        `${GITHUB_APP_INSTALL_URL}.`,
    );
  }
  return String(raw);
}

function normaliseOwner(found: DiscoveredInstallation): string {
  const raw = found.ownerLogin ?? found.owner ?? found.account?.login;
  if (raw === undefined || String(raw).trim() === "") {
    throw new Error(
      `dbos real-GitHub e2e: the root harness's discoverInstallation() returned no ` +
        `account login (got ${JSON.stringify(found)}). The fixture-repo owner is ` +
        `discovered, never a literal — set ${GITHUB_E2E_OWNER_VAR} to pin it.`,
    );
  }
  return String(raw);
}

/**
 * Resolve everything a dbos e2e spec needs: validated secrets, the runtime-discovered
 * installation id + owner login, and a minted installation token. Memoised per process
 * (one App JWT + one exchange, ~200 ms) because every spec file in the lane needs it.
 *
 * The App JWT is signed by **db-lib's own `signAppJwt`**, passed into the root harness as
 * `signJwt`. That is deliberate (D3): the harness then exercises the PRODUCT signer, so a
 * broken signer — e.g. row 62 item (c)'s unsupported-PEM bug — fails the harness loudly
 * instead of being masked by a second, independently-correct implementation.
 */
export async function resolveGithubE2eContext(
  deps: GithubE2eDeps = {},
): Promise<GithubE2eContext> {
  if (memo.context) return memo.context;

  const build = async (): Promise<GithubE2eContext> => {
    const env = deps.env ?? process.env;
    const secrets = resolveGithubE2eSecrets(env);
    const harness = await loadRootHarness(deps);

    const ownerHint = env[GITHUB_E2E_OWNER_VAR];
    const found = await harness.api.discoverInstallation({
      appId: secrets.appId,
      // The slug only shapes the remediation text
      // (`https://github.com/apps/<slug>/installations/new`) — pass it so a differently
      // named App registration still yields a URL the operator can actually click.
      appSlug: secrets.appSlug,
      privateKey: secrets.privateKey,
      ...(ownerHint !== undefined && ownerHint.trim() !== ""
        ? { ownerLogin: ownerHint }
        : {}),
      signJwt: signAppJwt,
    });

    const installationId = normaliseInstallationId(found);
    const owner = normaliseOwner(found);

    const minted = await mintInstallationToken({
      appId: secrets.appId,
      privateKey: secrets.privateKey,
      installationId,
      apiBaseUrl: GITHUB_API_BASE_URL,
      ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
    });

    return {
      ...secrets,
      installationId,
      owner,
      token: minted.token,
      runId: harness.naming.E2E_RUN_ID,
      harness,
    };
  };

  const pending = build();
  memo.context = pending;
  // A failed resolution must not be cached — the next caller should get the same
  // actionable throw, not a stale rejected promise nobody can act on.
  pending.catch(() => {
    if (memo.context === pending) delete memo.context;
  });
  return pending;
}

// ---------------------------------------------------------------------------
// Fixture repos
// ---------------------------------------------------------------------------

export interface FixtureRepo {
  owner: string;
  repo: string;
  fullName: string;
  /** `https://github.com/<owner>/<repo>.git` — no credential in it. */
  cloneUrl: string;
}

/**
 * Create a per-run throwaway fixture repo on the real account and make it genuinely
 * usable, in this exact order (D6):
 *
 *   1. `POST /user/repos` with the **PAT** — `{ private: true, auto_init: true }`.
 *      `auto_init` is LOAD-BEARING, not cosmetic: `scaffold-project.ts` opens its base
 *      PR with `base: "main"`, and a commit-less repo has no `main`, so real GitHub
 *      422s. This is exactly what the retired git-server fixture's
 *      `{seed:true, defaultBranch:"main"}` did. Anyone "simplifying" it to
 *      `auto_init:false` breaks scaffold, commit, publish and render at once.
 *   2. `waitForRepoReady` — a just-created repo can 404 briefly on first contents read
 *      or clone.
 *   3. `waitForInstallationVisibility` — under `repository_selection: all` a new repo is
 *      visible to the installation but not instantly, and
 *      `scaffold-project/github-rest.ts`'s `ensureRepoReachable` classifies absence as a
 *      **PERMANENT** `RepoUnreachableError`. Skipping this gate means non-retryable
 *      scaffold failures that look like product bugs.
 *
 * Per-run-unique names are MANDATORY, not an optimisation: the scaffold's v0.0.0 commit
 * is byte-deterministic by design (fixed identity + fixed date, so a replayed
 * `commitBaseVersion` reproduces the same SHA), so a REUSED repo rejects a second run.
 * Any "cache the fixture repo" change silently reintroduces that rejection.
 *
 * There is no teardown counterpart, by design — see the file header.
 */
export async function provisionFixtureRepo(
  slug: string,
  deps: GithubE2eDeps = {},
): Promise<FixtureRepo> {
  const ctx = await resolveGithubE2eContext(deps);
  const { naming, api } = ctx.harness;

  const created = await api.createFixtureRepo({
    pat: ctx.pat,
    slug,
    runId: ctx.runId,
    // `spec` is what the harness stamps into the repo DESCRIPTION (via
    // `buildE2eRepoDescription`), so the reviewer running the cleanup script can see which
    // lane created it. It is not part of the repo NAME — that is prefix + slug + runId.
    spec: `dbos ${slug}`,
  });

  // GitHub's raw repo JSON: `owner` is `{login}`, the name is `name`, and `full_name` is
  // the canonical `owner/name`. Prefer `full_name` when splitting, so a login containing
  // no surprises is still derived from a single authoritative field.
  const ownerField = created.owner;
  const owner =
    (typeof ownerField === "string" ? ownerField : ownerField?.login) ??
    created.full_name?.split("/")[0] ??
    created.fullName?.split("/")[0] ??
    ctx.owner;
  const repo =
    created.repo ??
    created.name ??
    (created.full_name ?? created.fullName)?.split("/").slice(1).join("/") ??
    "";
  const fullName = created.full_name ?? created.fullName ?? `${owner}/${repo}`;

  // Defence in depth. The prefix is the HARD GATE the interactive cleanup script uses
  // to decide what it is even allowed to archive, on an account that also holds the
  // user's real repos. If the root harness ever hands us a name that fails the gate,
  // that repo could never be reclaimed — so refuse it loudly here rather than scaffold
  // into it.
  if (!repo || !naming.isE2eRepoName(repo)) {
    throw new Error(
      `dbos real-GitHub e2e: refusing to use fixture repo "${fullName}" — its name ` +
        `(${repo || "<empty>"}) does not start with the required e2e prefix ` +
        `${naming.E2E_REPO_PREFIX}. That prefix is the cleanup script's hard gate, so a ` +
        `repo failing it can never be reclaimed. Expected ` +
        `${naming.buildE2eRepoName(slug, ctx.runId)}. Fix the root harness ` +
        `(${GITHUB_API_MODULE_REL}); do NOT relax this check.`,
    );
  }

  await api.waitForRepoReady({ pat: ctx.pat, owner, repo });
  await api.waitForInstallationVisibility({ token: ctx.token, fullName });

  return { owner, repo, fullName, cloneUrl: publicRemoteUrl({ owner, repo }) };
}

// ---------------------------------------------------------------------------
// Connection-row seeding
// ---------------------------------------------------------------------------

export interface SeedGithubConnectionArgs {
  prisma: Pick<PrismaClient, "githubConnection">;
  userId: string;
  deps?: GithubE2eDeps;
}

/**
 * Seed the user's `GithubConnection` row with the DISCOVERED installation id + login,
 * replacing the fabricated `installationId: "42"` / `githubLogin: "acme"` the specs used
 * to write. dbos writes the row directly with db-lib's Prisma client (never via the api
 * container) — the same self-contained choice `seed-connections.ts` documents.
 *
 * `repositorySelection` records the live grant (`all`), which is what makes a
 * just-created repo reachable by the installation at all.
 */
export async function seedGithubConnection(
  args: SeedGithubConnectionArgs,
): Promise<GithubE2eContext> {
  const ctx = await resolveGithubE2eContext(args.deps ?? {});
  await args.prisma.githubConnection.create({
    data: {
      userId: args.userId,
      installationId: ctx.installationId,
      githubLogin: ctx.owner,
      repositorySelection: "all",
      status: "connected",
    },
  });
  return ctx;
}

// ---------------------------------------------------------------------------
// Worker env
// ---------------------------------------------------------------------------

/**
 * The GitHub half of a spec's `loadEnv(...)` overrides.
 *
 * Deliberately returns the App credentials and **NO base URL at all** — that is the
 * whole point of finding F1: `src/config/env.ts` defaults `GITHUB_API_BASE_URL` to
 * `https://api.github.com` and `GITHUB_GIT_BASE_URL` to `https://github.com`, so
 * real-by-default is achieved by NOT overriding them. Adding a `GITHUB_*_BASE_URL` key
 * here would be the exact regression `providers.e2e.ts`'s no-stub guard now watches for.
 *
 * `GITHUB_E2E_PAT_TOKEN` is intentionally absent: it is host-side harness-only and must
 * never enter the worker environment (and `render/child-env.ts`'s allowlist keeps it out
 * of render children by construction).
 */
export function makeRealHostEnvOverrides(
  env: EnvSource = process.env,
): Record<string, string | undefined> {
  return {
    GITHUB_APP_ID: env.GITHUB_APP_ID,
    GITHUB_APP_PRIVATE_KEY: env.GITHUB_APP_PRIVATE_KEY,
  };
}

// ---------------------------------------------------------------------------
// Remote URLs
// ---------------------------------------------------------------------------

const trimSlash = (u: string) => u.replace(/\/+$/, "");

/** `https://github.com/<owner>/<repo>.git` — carries no credential. */
export function publicRemoteUrl(args: {
  owner: string;
  repo: string;
  gitBaseUrl?: string;
}): string {
  return `${trimSlash(args.gitBaseUrl ?? GITHUB_GIT_BASE_URL)}/${args.owner}/${args.repo}.git`;
}

/**
 * `https://x-access-token:<token>@github.com/<owner>/<repo>.git` — the same shape the
 * product builds (`scaffold-project.ts:102-110` et al). Fixture repos are PRIVATE, so a
 * spec's own `git clone` / `git push` needs this; the retired git-server needed no auth,
 * which is why the specs used bare URLs.
 *
 * Keep it out of anything that could be logged: `scaffold-project/git.ts`'s
 * `redactUrlCredentials()` protects the product's own git failures, but a spec that
 * prints this string leaks a live token into CI output.
 */
export function authenticatedRemoteUrl(args: {
  token: string;
  owner: string;
  repo: string;
  gitBaseUrl?: string;
}): string {
  const url = new URL(publicRemoteUrl(args));
  url.username = "x-access-token";
  url.password = args.token;
  return url.toString();
}

// ---------------------------------------------------------------------------
// Assertion readers
// ---------------------------------------------------------------------------

export interface GithubReaders {
  /**
   * Pull requests for the repo. ALWAYS queried with `state: "all"` — a merged PR is
   * `closed`, so a `state=open` read would report zero PRs for a successfully scaffolded
   * repo and turn the non-duplication assertion into a green lie. (Same bug class as the
   * product fix in `scaffold-project/github-rest.ts` — D18-1.)
   */
  listPulls(args: {
    repo: string;
    head?: string;
  }): Promise<Array<Record<string, unknown>>>;
  listTagRefs(args: {
    repo: string;
  }): Promise<Array<Record<string, unknown>> | string[]>;
  listBranches(args: {
    repo: string;
  }): Promise<Array<Record<string, unknown>> | string[]>;
  countCommitsOnBranch(args: { repo: string; branch: string }): Promise<number>;
}

/**
 * The assertion readers, bound to the discovered owner and the INSTALLATION token.
 *
 * Thin delegation to the root harness on purpose: the network policy (Retry-After /
 * x-ratelimit-reset backoff, `Link: rel=next` walking, bounded retries for GitHub's
 * near-real-time-but-not-transactional pulls/refs indexes) has exactly one
 * implementation, in root (D3). What is pinned HERE is the calling contract — the
 * discovered owner, the installation token rather than the stronger PAT, and
 * `state: "all"`.
 */
export async function githubReaders(
  deps: GithubE2eDeps = {},
): Promise<GithubReaders> {
  const ctx = await resolveGithubE2eContext(deps);
  const { api } = ctx.harness;
  const base = { token: ctx.token, owner: ctx.owner };
  return {
    listPulls: (args) =>
      api.listPulls({
        ...base,
        repo: args.repo,
        state: "all",
        ...(args.head !== undefined ? { head: args.head } : {}),
      }),
    listTagRefs: (args) => api.listTagRefs({ ...base, repo: args.repo }),
    listBranches: (args) => api.listBranches({ ...base, repo: args.repo }),
    countCommitsOnBranch: (args) =>
      api.countCommitsOnBranch({ ...base, repo: args.repo, branch: args.branch }),
  };
}
