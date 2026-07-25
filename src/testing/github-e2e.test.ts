import { afterEach, describe, expect, it } from "vitest";
import { signAppJwt } from "@supagloo/database-lib";
import * as adapter from "./github-e2e";
import {
  GITHUB_APP_INSTALL_URL,
  GITHUB_E2E_ENV_VARS,
  GITHUB_E2E_OWNER_VAR,
  GITHUB_E2E_PAT_VAR,
  NAMING_MODULE_REL,
  GITHUB_API_MODULE_REL,
  ROOT_DIR_VAR,
  __resetGithubE2eState,
  authenticatedRemoteUrl,
  githubReaders,
  loadRootHarness,
  makeRealHostEnvOverrides,
  provisionFixtureRepo,
  publicRemoteUrl,
  resolveGithubE2eContext,
  resolveGithubE2eSecrets,
  resolveRootRepoDir,
  type RootHarness,
} from "./github-e2e";

/**
 * Unit coverage for the dbos side of task 62's real-GitHub e2e harness (plan D3/D4/D5).
 *
 * ZERO network egress: the ROOT harness modules are injected as a fake, and the
 * installation-token mint runs through db-lib's `mintInstallationToken` with an injected
 * `fetch`. That is the whole point of the seam — the e2e lanes reach real github.com, the
 * unit lane never does (HARD RULE 5 / design-delta §10.6).
 *
 * What this pins:
 *   • the root-checkout resolution seam (`SUPAGLOO_ROOT_DIR` ?? sibling `../supagloo`)
 *     and a fail-fast that names BOTH the missing file and the var (D1)
 *   • per-var secret fail-fast naming the var + the root `.env` (D5 throw 1)
 *   • the App JWT handed to `discoverInstallation` is the PRODUCT signer (D3)
 *   • the ordered provisioning gates: create → repo-ready → installation-visibility,
 *     with NO teardown of any kind (D6)
 *   • the prefix hard gate re-checked adapter-side, so a drifting root harness cannot
 *     hand dbos a repo name the cleanup script would refuse to reclaim (D1)
 *   • reader delegation ALWAYS passing `state: "all"` (D9/D18-1)
 *   • `makeRealHostEnvOverrides()` contributing no GitHub base URL (F1 — dbos is
 *     real-by-default and must stay that way)
 */

const PEM_MULTILINE = `-----BEGIN PRIVATE KEY-----
MIIBVAIBADANBgkqhkiG9w0BAQEFAASCAT4wggE6AgEAAkEAxDMBRHR0KaBb6L1H
-----END PRIVATE KEY-----`;

// A REAL 2048-bit key is needed for a real signature; generate one once per file.
import { generateKeyPairSync } from "node:crypto";
const { privateKey: REAL_PEM } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});

const baseEnv = (over: Record<string, string | undefined> = {}) => ({
  GITHUB_APP_ID: "990001",
  GITHUB_APP_SLUG: "supagloo",
  GITHUB_APP_PRIVATE_KEY: REAL_PEM,
  GITHUB_E2E_PAT_TOKEN: "ghp_fake_for_unit_test",
  ...over,
});

interface FakeCalls {
  discover: Array<Record<string, unknown>>;
  create: Array<Record<string, unknown>>;
  repoReady: Array<Record<string, unknown>>;
  visibility: Array<Record<string, unknown>>;
  pulls: Array<Record<string, unknown>>;
  tags: Array<Record<string, unknown>>;
  branches: Array<Record<string, unknown>>;
  commits: Array<Record<string, unknown>>;
  order: string[];
}

function makeFakeHarness(over: Partial<RootHarness["api"]> = {}): {
  harness: RootHarness;
  calls: FakeCalls;
} {
  const calls: FakeCalls = {
    discover: [],
    create: [],
    repoReady: [],
    visibility: [],
    pulls: [],
    tags: [],
    branches: [],
    commits: [],
    order: [],
  };
  const harness: RootHarness = {
    rootDir: "/fake/supagloo",
    naming: {
      E2E_REPO_PREFIX: "fake-e2e-prefix-",
      E2E_RUN_ID: "runid42",
      buildE2eRepoName: (slug: string, runId: string) =>
        `fake-e2e-prefix-${slug}-${runId}`,
      isE2eRepoName: (name: string) => name.startsWith("fake-e2e-prefix-"),
    },
    api: {
      discoverInstallation: async (args) => {
        calls.discover.push(args as Record<string, unknown>);
        calls.order.push("discoverInstallation");
        return { installationId: "77700099", ownerLogin: "fake-owner-login" };
      },
      createFixtureRepo: async (args) => {
        calls.create.push(args as Record<string, unknown>);
        calls.order.push("createFixtureRepo");
        const repo = `fake-e2e-prefix-${String(args.slug)}-${String(args.runId)}`;
        return { owner: "fake-owner-login", repo, fullName: `fake-owner-login/${repo}` };
      },
      waitForRepoReady: async (args) => {
        calls.repoReady.push(args as Record<string, unknown>);
        calls.order.push("waitForRepoReady");
      },
      waitForInstallationVisibility: async (args) => {
        calls.visibility.push(args as Record<string, unknown>);
        calls.order.push("waitForInstallationVisibility");
      },
      createRef: async () => {
        calls.order.push("createRef");
      },
      putContents: async () => {
        calls.order.push("putContents");
      },
      listPulls: async (args) => {
        calls.pulls.push(args as Record<string, unknown>);
        return [];
      },
      listTagRefs: async (args) => {
        calls.tags.push(args as Record<string, unknown>);
        return [];
      },
      listBranches: async (args) => {
        calls.branches.push(args as Record<string, unknown>);
        return [];
      },
      countCommitsOnBranch: async (args) => {
        calls.commits.push(args as Record<string, unknown>);
        return 1;
      },
      ...over,
    },
  };
  return { harness, calls };
}

/** A fetch that satisfies db-lib's `mintInstallationToken` without egress. */
function mintFetch(record: { urls: string[]; jwts: string[] } = { urls: [], jwts: [] }) {
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    record.urls.push(String(url));
    record.jwts.push(new Headers(init?.headers).get("authorization") ?? "");
    return new Response(
      JSON.stringify({
        token: "ghs_unit_test_token",
        expires_at: new Date(Date.now() + 3_600_000).toISOString(),
        permissions: { contents: "write", pull_requests: "write", metadata: "read" },
        repository_selection: "all",
      }),
      { status: 201, headers: { "content-type": "application/json" } },
    );
  }) as unknown as typeof fetch;
  return { impl, record };
}

afterEach(() => {
  __resetGithubE2eState();
});

describe("resolveRootRepoDir", () => {
  it("honours SUPAGLOO_ROOT_DIR when set", () => {
    expect(resolveRootRepoDir({ [ROOT_DIR_VAR]: "/elsewhere/supagloo" })).toBe(
      "/elsewhere/supagloo",
    );
  });

  it("falls back to the established sibling checkout seam (../supagloo)", () => {
    const dir = resolveRootRepoDir({});
    expect(dir.endsWith("/supagloo")).toBe(true);
    expect(dir).not.toContain("supagloo-nodejs-dbos");
  });
});

describe("loadRootHarness fail-fast (D1)", () => {
  it("names the missing module path AND SUPAGLOO_ROOT_DIR when the root checkout is absent", async () => {
    const err = await loadRootHarness({
      env: { [ROOT_DIR_VAR]: "/definitely/not/here" },
    }).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    const msg = (err as Error).message;
    expect(msg).toContain("/definitely/not/here");
    expect(msg).toContain(NAMING_MODULE_REL);
    expect(msg).toContain(ROOT_DIR_VAR);
  });

  it("mentions the second harness module too, so a half-landed root is attributable", async () => {
    const err = await loadRootHarness({
      env: { [ROOT_DIR_VAR]: "/definitely/not/here" },
      // Only the naming module exists; the api module does not.
      existsSyncImpl: (p: string) => p.includes("e2e-github-naming.mjs"),
    }).catch((e: Error) => e);
    expect((err as Error).message).toContain(GITHUB_API_MODULE_REL);
  });
});

describe("resolveGithubE2eSecrets fail-fast (D5 throw 1)", () => {
  it.each(GITHUB_E2E_ENV_VARS)("names %s and the root .env when it is missing", (name) => {
    const err = (() => {
      try {
        resolveGithubE2eSecrets(baseEnv({ [name]: undefined }));
        return undefined;
      } catch (e) {
        return e as Error;
      }
    })();
    expect(err, `${name} must be required`).toBeInstanceOf(Error);
    expect(err!.message).toContain(name);
    expect(err!.message).toContain(".env");
  });

  it("treats whitespace-only as missing", () => {
    expect(() => resolveGithubE2eSecrets(baseEnv({ GITHUB_APP_ID: "   " }))).toThrow(
      /GITHUB_APP_ID/,
    );
  });

  it("returns the four secrets when all are present", () => {
    const s = resolveGithubE2eSecrets(baseEnv());
    expect(s.appId).toBe("990001");
    expect(s.appSlug).toBe("supagloo");
    expect(s.privateKey).toBe(REAL_PEM);
    expect(s.pat).toBe("ghp_fake_for_unit_test");
  });

  it("names the PAT var exactly as documented in the root .env.example", () => {
    expect(GITHUB_E2E_PAT_VAR).toBe("GITHUB_E2E_PAT_TOKEN");
    expect(GITHUB_E2E_ENV_VARS).toContain("GITHUB_E2E_PAT_TOKEN");
  });

  it("never puts a literal installation id or owner login in the module", () => {
    // D5: the real installation id and the real owner login must appear in NO file —
    // both are discovered at runtime. Every id/login/prefix in this test file is
    // deliberately FAKE, which is also why the remediation URL is the only real constant.
    expect(GITHUB_APP_INSTALL_URL).toBe(
      "https://github.com/apps/supagloo/installations/new",
    );
  });
});

describe("resolveGithubE2eContext (D3/D5)", () => {
  it("discovers the installation with the PRODUCT App-JWT signer, not a second implementation", async () => {
    const { harness, calls } = makeFakeHarness();
    const mint = mintFetch();
    const ctx = await resolveGithubE2eContext({
      env: baseEnv(),
      harness,
      fetchImpl: mint.impl,
    });

    expect(ctx.installationId).toBe("77700099");
    expect(ctx.owner).toBe("fake-owner-login");
    expect(ctx.token).toBe("ghs_unit_test_token");

    // The harness was handed a signJwt callback...
    const signJwt = calls.discover[0].signJwt as (a: {
      appId: string;
      privateKey: string;
    }) => string;
    expect(typeof signJwt).toBe("function");
    // ...and it is db-lib's own signer: byte-identical output for the same inputs.
    const now = new Date("2026-07-25T00:00:00Z");
    expect(signJwt({ appId: "990001", privateKey: REAL_PEM, now } as never)).toBe(
      signAppJwt({ appId: "990001", privateKey: REAL_PEM, now }),
    );
  });

  it("passes SUPAGLOO_E2E_GITHUB_OWNER through as the target owner when set", async () => {
    const { harness, calls } = makeFakeHarness();
    await resolveGithubE2eContext({
      env: baseEnv({ [GITHUB_E2E_OWNER_VAR]: "someone-else" }),
      harness,
      fetchImpl: mintFetch().impl,
    });
    expect(calls.discover[0].ownerLogin).toBe("someone-else");
  });

  it("mints the installation token via the product path against the REAL api host", async () => {
    const { harness } = makeFakeHarness();
    const mint = mintFetch();
    await resolveGithubE2eContext({ env: baseEnv(), harness, fetchImpl: mint.impl });
    expect(mint.record.urls[0]).toBe(
      "https://api.github.com/app/installations/77700099/access_tokens",
    );
    // A signed App JWT (3 dot-separated segments), NOT the PAT.
    expect(mint.record.jwts[0]).toMatch(/^Bearer [\w-]+\.[\w-]+\.[\w-]+$/);
    expect(mint.record.jwts[0]).not.toContain("ghp_");
  });

  it("is memoised per process — one discovery + one mint however many callers ask", async () => {
    const { harness, calls } = makeFakeHarness();
    const mint = mintFetch();
    const deps = { env: baseEnv(), harness, fetchImpl: mint.impl };
    const a = await resolveGithubE2eContext(deps);
    const b = await resolveGithubE2eContext(deps);
    expect(b).toBe(a);
    expect(calls.discover).toHaveLength(1);
    expect(mint.record.urls).toHaveLength(1);
  });

  it("propagates the root harness's zero-installations remediation verbatim", async () => {
    const { harness } = makeFakeHarness({
      discoverInstallation: async () => {
        throw new Error(
          `the GitHub App has no installations — install it at ${GITHUB_APP_INSTALL_URL}`,
        );
      },
    });
    const err = await resolveGithubE2eContext({
      env: baseEnv(),
      harness,
      fetchImpl: mintFetch().impl,
    }).catch((e: Error) => e);
    expect((err as Error).message).toContain(GITHUB_APP_INSTALL_URL);
  });

  it("THROWS rather than resolving a degraded context when a secret is missing (row 56 item 2)", async () => {
    const { harness } = makeFakeHarness();
    await expect(
      resolveGithubE2eContext({
        env: baseEnv({ GITHUB_APP_PRIVATE_KEY: undefined }),
        harness,
        fetchImpl: mintFetch().impl,
      }),
    ).rejects.toThrow(/GITHUB_APP_PRIVATE_KEY/);
  });
});

describe("provisionFixtureRepo (D6)", () => {
  it("creates with the PAT then gates repo-ready THEN installation-visibility, in that order", async () => {
    const { harness, calls } = makeFakeHarness();
    const repo = await provisionFixtureRepo("scaffold", {
      env: baseEnv(),
      harness,
      fetchImpl: mintFetch().impl,
    });

    expect(calls.order).toEqual([
      "discoverInstallation",
      "createFixtureRepo",
      "waitForRepoReady",
      "waitForInstallationVisibility",
    ]);
    // Repo creation is user-scoped: the PAT, never the installation token.
    expect(calls.create[0].pat).toBe("ghp_fake_for_unit_test");
    expect(calls.create[0].slug).toBe("scaffold");
    expect(calls.create[0].runId).toBe("runid42");
    // Branch/file seeding + reads use the INSTALLATION token (the granted scope).
    expect(calls.visibility[0].token).toBe("ghs_unit_test_token");
    expect(calls.visibility[0].fullName).toBe(repo.fullName);
    expect(repo.repo).toBe("fake-e2e-prefix-scaffold-runid42");
    expect(repo.fullName).toBe("fake-owner-login/fake-e2e-prefix-scaffold-runid42");
  });

  it("normalises GitHub's RAW repo JSON — `owner` is an OBJECT, the name is `name` (root returns res.body)", async () => {
    // This is the real contract: `<root>/tests/support/e2e-github-api.mjs`'s
    // `createFixtureRepo` returns `res.body` of `POST /user/repos` verbatim. Treating
    // `owner` as a string there yields `[object Object]/<repo>` remotes and a Project row
    // pointing at a repo that does not exist — a failure that surfaces minutes later as an
    // opaque clone error, so it is pinned here.
    const { harness, calls } = makeFakeHarness({
      createFixtureRepo: async () => ({
        name: "fake-e2e-prefix-scaffold-runid42",
        full_name: "real-login/fake-e2e-prefix-scaffold-runid42",
        owner: { login: "real-login" },
        private: true,
      }),
    });
    const repo = await provisionFixtureRepo("scaffold", {
      env: baseEnv(),
      harness,
      fetchImpl: mintFetch().impl,
    });
    expect(repo.owner).toBe("real-login");
    expect(repo.repo).toBe("fake-e2e-prefix-scaffold-runid42");
    expect(repo.fullName).toBe("real-login/fake-e2e-prefix-scaffold-runid42");
    expect(repo.cloneUrl).toBe(
      "https://github.com/real-login/fake-e2e-prefix-scaffold-runid42.git",
    );
    // The gates must receive the NORMALISED owner/name, not the raw object.
    expect(calls.repoReady[0].owner).toBe("real-login");
    expect(calls.repoReady[0].repo).toBe("fake-e2e-prefix-scaffold-runid42");
  });

  it("passes `spec` (the harness's description stamp), not a `description` the harness ignores", async () => {
    const { harness, calls } = makeFakeHarness();
    await provisionFixtureRepo("scaffold", {
      env: baseEnv(),
      harness,
      fetchImpl: mintFetch().impl,
    });
    expect(calls.create[0].spec).toBe("dbos scaffold");
    expect(calls.create[0].description).toBeUndefined();
  });

  it("re-checks the prefix HARD GATE adapter-side, so a drifting root harness cannot orphan a repo", async () => {
    const { harness } = makeFakeHarness({
      createFixtureRepo: async () => ({
        owner: "fake-owner-login",
        repo: "supagloo-nextjs",
        fullName: "fake-owner-login/supagloo-nextjs",
      }),
    });
    const err = await provisionFixtureRepo("scaffold", {
      env: baseEnv(),
      harness,
      fetchImpl: mintFetch().impl,
    }).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain("fake-e2e-prefix-");
    expect((err as Error).message).toContain("supagloo-nextjs");
  });

  it("produces per-run-unique names so the byte-deterministic scaffold commit is never re-pushed", async () => {
    const { harness } = makeFakeHarness();
    const deps = { env: baseEnv(), harness, fetchImpl: mintFetch().impl };
    const a = await provisionFixtureRepo("scaffold", deps);
    const b = await provisionFixtureRepo("publish", deps);
    expect(a.repo).not.toBe(b.repo);
    expect(a.repo).toContain("runid42");
  });

  it("exports NO teardown/archive/delete helper — the cleanup script is the only lifecycle end (D6)", () => {
    const names = Object.keys(adapter);
    expect(names.filter((n) => /archive|delete|teardown|destroyRepo/i.test(n))).toEqual(
      [],
    );
  });
});

describe("reader delegation (D9)", () => {
  it("ALWAYS asks for state=all — never state=open (D18-1's bug class, harness side)", async () => {
    const { harness, calls } = makeFakeHarness();
    const readers = await githubReaders({
      env: baseEnv(),
      harness,
      fetchImpl: mintFetch().impl,
    });
    await readers.listPulls({ repo: "fake-e2e-prefix-scaffold-runid42" });
    expect(calls.pulls[0].state).toBe("all");
    expect(calls.pulls[0].token).toBe("ghs_unit_test_token");
    expect(calls.pulls[0].owner).toBe("fake-owner-login");
  });

  it("binds the discovered owner + installation token into every reader", async () => {
    const { harness, calls } = makeFakeHarness();
    const readers = await githubReaders({
      env: baseEnv(),
      harness,
      fetchImpl: mintFetch().impl,
    });
    await readers.listTagRefs({ repo: "r" });
    await readers.listBranches({ repo: "r" });
    await readers.countCommitsOnBranch({ repo: "r", branch: "v0.0.1" });
    for (const rec of [calls.tags[0], calls.branches[0], calls.commits[0]]) {
      expect(rec.owner).toBe("fake-owner-login");
      expect(rec.token).toBe("ghs_unit_test_token");
    }
    expect(calls.commits[0].branch).toBe("v0.0.1");
  });
});

describe("makeRealHostEnvOverrides (F1: dbos is real-by-default)", () => {
  it("contributes NO GitHub base URL of any kind", () => {
    const over = makeRealHostEnvOverrides();
    for (const key of Object.keys(over)) {
      expect(key).not.toMatch(/^GITHUB_.*BASE_URL$/);
    }
    expect(over.GITHUB_API_BASE_URL).toBeUndefined();
    expect(over.GITHUB_GIT_BASE_URL).toBeUndefined();
  });

  it("carries the real App credentials through from the environment", () => {
    const over = makeRealHostEnvOverrides(baseEnv());
    expect(over.GITHUB_APP_ID).toBe("990001");
    expect(over.GITHUB_APP_PRIVATE_KEY).toBe(REAL_PEM);
  });

  it("never carries the PAT into the worker environment (it is host-side harness-only)", () => {
    const over = makeRealHostEnvOverrides(baseEnv());
    expect(JSON.stringify(over)).not.toContain("ghp_fake_for_unit_test");
    expect(Object.keys(over)).not.toContain("GITHUB_E2E_PAT_TOKEN");
  });
});

describe("remote URL builders", () => {
  it("builds an x-access-token authenticated https remote for the real host", () => {
    const url = authenticatedRemoteUrl({
      token: "ghs_abc",
      owner: "fake-owner-login",
      repo: "fake-e2e-prefix-scaffold-runid42",
    });
    expect(url).toBe(
      "https://x-access-token:ghs_abc@github.com/fake-owner-login/fake-e2e-prefix-scaffold-runid42.git",
    );
  });

  it("builds an unauthenticated remote with no credential in it at all", () => {
    const url = publicRemoteUrl({ owner: "fake-owner-login", repo: "r" });
    expect(url).toBe("https://github.com/fake-owner-login/r.git");
    expect(url).not.toContain("@");
  });

  it("accepts a non-default git base URL without double slashes", () => {
    expect(
      publicRemoteUrl({ owner: "o", repo: "r", gitBaseUrl: "https://github.com/" }),
    ).toBe("https://github.com/o/r.git");
  });
});

describe("PEM handling parity with the product signer", () => {
  it("accepts the documented single-line escaped-\\n env form (row 62 item (c)'s bug class)", () => {
    const escaped = PEM_MULTILINE.replace(/\n/g, "\\n");
    const s = resolveGithubE2eSecrets(baseEnv({ GITHUB_APP_PRIVATE_KEY: escaped }));
    // The adapter must NOT pre-normalise: db-lib's signAppJwt owns that ONE choke point.
    expect(s.privateKey).toBe(escaped);
  });
});
