import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadEnv } from "./env";

// The DBOS worker needs TWO distinct Postgres connection strings (design-delta
// §4): the APP db (`supagloo`, where workflows write domain rows via db-lib's
// Prisma client) and the DBOS SYSTEM db (`supagloo_dbos`, DBOS's own
// checkpoints/queues). This suite pins that split — the crux of "config parsing
// (system DB vs app DB URLs)".
const APP_URL = "postgres://supagloo:supagloo@localhost:5432/supagloo";
const SYSTEM_URL = "postgres://supagloo:supagloo@localhost:5432/supagloo_dbos";

// Task #17 adds the GitHub App + base-URL vars the git-ops workflows consume. The
// APP_ID / PRIVATE_KEY are required (fail-fast at boot); the base URLs default to
// the real provider hosts (prod needs zero config) and are overridden to the stub
// URLs in test. Names are copied VERBATIM from supagloo-nodejs-api's env loader so
// the two services agree (GITHUB_GIT_BASE_URL is new — dbos is the only git client).
const GITHUB_APP = {
  GITHUB_APP_ID: "123456",
  GITHUB_APP_PRIVATE_KEY: "-----BEGIN RSA PRIVATE KEY-----\nX\n-----END RSA PRIVATE KEY-----",
};

// Task #29 provider-call layer: the single AES-256-GCM key used to decrypt per-user
// provider secrets (via db-lib's decryptSecret) inside the generation workflows.
// Required (fail-fast at boot), a 64-hex-char value — copied verbatim from
// supagloo-nodejs-api's loader so API and DBOS agree on the same key contract.
const SECRETS_ENCRYPTION_KEY = "0".repeat(64);

// Task #32 S3 (writer role): required for the asset-uploading workflows.
const S3_ENV = {
  S3_ENDPOINT: "http://minio:9000",
  S3_BUCKET: "supagloo-dev",
  S3_ACCESS_KEY: "supagloo",
  S3_SECRET_KEY: "supagloo-dev",
};

function validEnv(
  overrides: Record<string, string | undefined> = {},
): Record<string, string | undefined> {
  return {
    DATABASE_URL: APP_URL,
    DBOS_DATABASE_URL: SYSTEM_URL,
    SECRETS_ENCRYPTION_KEY,
    ...GITHUB_APP,
    ...S3_ENV,
    ...overrides,
  };
}

/** Last path segment of a postgres URL = the database name. */
function dbNameOf(url: string): string {
  return new URL(url).pathname.replace(/^\//, "");
}

describe("loadEnv", () => {
  it("accepts a valid env with distinct app + system database URLs", () => {
    const env = loadEnv(validEnv());
    expect(env.DATABASE_URL).toBe(APP_URL);
    expect(env.DBOS_DATABASE_URL).toBe(SYSTEM_URL);
    expect(env.NODE_ENV).toBe("development");
  });

  it("keeps the app db (supagloo) and the DBOS system db (supagloo_dbos) separate", () => {
    const env = loadEnv(validEnv());
    expect(env.DATABASE_URL).not.toBe(env.DBOS_DATABASE_URL);
    expect(dbNameOf(env.DATABASE_URL)).toBe("supagloo");
    expect(dbNameOf(env.DBOS_DATABASE_URL)).toBe("supagloo_dbos");
  });

  it("accepts the postgresql:// scheme for both and NODE_ENV=production", () => {
    const env = loadEnv(
      validEnv({
        DATABASE_URL: "postgresql://u:p@db:5432/app",
        DBOS_DATABASE_URL: "postgresql://u:p@db:5432/app_dbos",
        NODE_ENV: "production",
      }),
    );
    expect(env.DATABASE_URL).toBe("postgresql://u:p@db:5432/app");
    expect(env.DBOS_DATABASE_URL).toBe("postgresql://u:p@db:5432/app_dbos");
    expect(env.NODE_ENV).toBe("production");
  });

  it("rejects a missing app DATABASE_URL", () => {
    expect(() => loadEnv(validEnv({ DATABASE_URL: undefined }))).toThrow(
      /DATABASE_URL/,
    );
  });

  it("rejects an empty app DATABASE_URL", () => {
    expect(() => loadEnv(validEnv({ DATABASE_URL: "" }))).toThrow(
      /DATABASE_URL/,
    );
  });

  it("rejects a missing system DBOS_DATABASE_URL", () => {
    expect(() => loadEnv(validEnv({ DBOS_DATABASE_URL: undefined }))).toThrow(
      /DBOS_DATABASE_URL/,
    );
  });

  it("rejects a non-postgres app DATABASE_URL scheme", () => {
    expect(() =>
      loadEnv(validEnv({ DATABASE_URL: "http://example.com/db" })),
    ).toThrow(/postgres/i);
  });

  it("rejects a non-postgres system DBOS_DATABASE_URL scheme", () => {
    expect(() =>
      loadEnv(validEnv({ DBOS_DATABASE_URL: "mysql://nope/db" })),
    ).toThrow(/DBOS_DATABASE_URL/);
  });

  it("defaults the GitHub base URLs to the real provider hosts", () => {
    const env = loadEnv(validEnv());
    expect(env.GITHUB_API_BASE_URL).toBe("https://api.github.com");
    expect(env.GITHUB_GIT_BASE_URL).toBe("https://github.com");
  });

  // The override MECHANISM still exists (a self-hosted GitHub Enterprise host is the
  // legitimate reason), but since task 62 nothing in this repo uses it: the github-stub +
  // git-server are deleted and no spec or Compose file injects a GitHub base URL any more,
  // so the real-host defaults above are the only values a run ever sees. Kept as a
  // schema test, deliberately using a NEUTRAL host rather than the retired stub ports, so
  // nobody reads this as evidence that stub wiring is still supported.
  it("accepts an explicitly overridden GitHub base URL (e.g. GitHub Enterprise)", () => {
    const env = loadEnv(
      validEnv({
        GITHUB_API_BASE_URL: "https://github.example.com/api/v3",
        GITHUB_GIT_BASE_URL: "https://github.example.com",
      }),
    );
    expect(env.GITHUB_API_BASE_URL).toBe("https://github.example.com/api/v3");
    expect(env.GITHUB_GIT_BASE_URL).toBe("https://github.example.com");
  });

  it("rejects a non-http GitHub base URL", () => {
    expect(() =>
      loadEnv(validEnv({ GITHUB_API_BASE_URL: "ftp://nope" })),
    ).toThrow(/GITHUB_API_BASE_URL|http/i);
  });

  it("requires GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY (fail-fast at boot)", () => {
    expect(() => loadEnv(validEnv({ GITHUB_APP_ID: undefined }))).toThrow(
      /GITHUB_APP_ID/,
    );
    expect(() => loadEnv(validEnv({ GITHUB_APP_PRIVATE_KEY: undefined }))).toThrow(
      /GITHUB_APP_PRIVATE_KEY/,
    );
  });

  // --- Task #29 provider-call layer -----------------------------------------

  it("defaults the provider base URLs to the real hosts (prod needs zero config)", () => {
    const env = loadEnv(validEnv());
    expect(env.OPENROUTER_BASE_URL).toBe("https://openrouter.ai");
    expect(env.GLOO_BASE_URL).toBe("https://platform.ai.gloo.com");
  });

  it("accepts overridden (stub) provider base URLs", () => {
    const env = loadEnv(
      validEnv({
        OPENROUTER_BASE_URL: "http://localhost:4802",
        GLOO_BASE_URL: "http://localhost:4803",
      }),
    );
    expect(env.OPENROUTER_BASE_URL).toBe("http://localhost:4802");
    expect(env.GLOO_BASE_URL).toBe("http://localhost:4803");
  });

  it("rejects a non-http provider base URL", () => {
    expect(() =>
      loadEnv(validEnv({ OPENROUTER_BASE_URL: "ftp://nope" })),
    ).toThrow(/OPENROUTER_BASE_URL|http/i);
  });

  it("requires SECRETS_ENCRYPTION_KEY (fail-fast at boot)", () => {
    expect(() =>
      loadEnv(validEnv({ SECRETS_ENCRYPTION_KEY: undefined })),
    ).toThrow(/SECRETS_ENCRYPTION_KEY/);
  });

  it("rejects a SECRETS_ENCRYPTION_KEY that is not 64 hex characters", () => {
    expect(() =>
      loadEnv(validEnv({ SECRETS_ENCRYPTION_KEY: "tooshort" })),
    ).toThrow(/SECRETS_ENCRYPTION_KEY|hex/i);
    expect(() =>
      loadEnv(validEnv({ SECRETS_ENCRYPTION_KEY: "z".repeat(64) })),
    ).toThrow(/SECRETS_ENCRYPTION_KEY|hex/i);
  });

  it("accepts a valid 64-hex SECRETS_ENCRYPTION_KEY", () => {
    const key = "abcdef0123456789".repeat(4);
    const env = loadEnv(validEnv({ SECRETS_ENCRYPTION_KEY: key }));
    expect(env.SECRETS_ENCRYPTION_KEY).toBe(key);
  });

  // Task #32 S3 (writer role) — required; region defaults; public endpoint optional/unused.
  it("requires S3_ENDPOINT / S3_BUCKET / S3_ACCESS_KEY / S3_SECRET_KEY (fail-fast)", () => {
    for (const key of [
      "S3_ENDPOINT",
      "S3_BUCKET",
      "S3_ACCESS_KEY",
      "S3_SECRET_KEY",
    ] as const) {
      expect(() => loadEnv(validEnv({ [key]: undefined }))).toThrow(
        new RegExp(key),
      );
    }
  });

  it("defaults S3_REGION to us-east-1 and accepts an override", () => {
    expect(loadEnv(validEnv()).S3_REGION).toBe("us-east-1");
    expect(loadEnv(validEnv({ S3_REGION: "eu-west-1" })).S3_REGION).toBe(
      "eu-west-1",
    );
  });

  it("rejects a non-http S3_ENDPOINT", () => {
    expect(() => loadEnv(validEnv({ S3_ENDPOINT: "minio:9000" }))).toThrow(
      /S3_ENDPOINT|http/i,
    );
  });
});

// ---------------------------------------------------------------------------
// Task #36 — renderWorkflow tuning + the render-time audio fallback models.
//
// Timeouts are "generous" by design (design-delta §9-Q8 defers real tuning to the
// load-testing task 45); they exist as env vars so task 45 can tune them without a
// code change. DBOS has no per-step timeout, so these are CHILD-PROCESS kill
// deadlines — which is also what bounds the untrusted user code.
//
// RENDER_NARRATION_MODEL / RENDER_MUSIC_MODEL are OPTIONAL WITH NO DEFAULT: model ids
// are never hardcoded (design §7 / §10.9), and an unset model means the render simply
// proceeds without that track rather than failing.
//
// Note the deliberate ABSENCE of REMOTION_ASSET_BASE_URL: the render workflow
// downloads assets into the workspace `public/` dir and resolves them with
// `staticFile()`, so no remote asset origin is needed (plan D1).
// ---------------------------------------------------------------------------

describe("Task #36 render env", () => {
  it("defaults the three render timeouts to generous values", () => {
    const env = loadEnv(validEnv());
    expect(env.RENDER_MEDIA_TIMEOUT_SECONDS).toBe(3600);
    expect(env.RENDER_BUNDLE_TIMEOUT_SECONDS).toBe(900);
    expect(env.RENDER_INSTALL_TIMEOUT_SECONDS).toBe(900);
  });

  it("coerces string overrides to numbers", () => {
    const env = loadEnv(
      validEnv({
        RENDER_MEDIA_TIMEOUT_SECONDS: "120",
        RENDER_BUNDLE_TIMEOUT_SECONDS: "60",
        RENDER_INSTALL_TIMEOUT_SECONDS: "45",
      }),
    );
    expect(env.RENDER_MEDIA_TIMEOUT_SECONDS).toBe(120);
    expect(env.RENDER_BUNDLE_TIMEOUT_SECONDS).toBe(60);
    expect(env.RENDER_INSTALL_TIMEOUT_SECONDS).toBe(45);
  });

  it("rejects a non-positive timeout", () => {
    expect(() => loadEnv(validEnv({ RENDER_MEDIA_TIMEOUT_SECONDS: "0" }))).toThrow();
    expect(() => loadEnv(validEnv({ RENDER_BUNDLE_TIMEOUT_SECONDS: "-1" }))).toThrow();
  });

  it("leaves the render audio models undefined when unset (fallback synthesis is opt-in)", () => {
    const env = loadEnv(validEnv());
    expect(env.RENDER_NARRATION_MODEL).toBeUndefined();
    expect(env.RENDER_MUSIC_MODEL).toBeUndefined();
  });

  it("treats an EMPTY render model as absent (compose ${VAR:-} substitution)", () => {
    const env = loadEnv(
      validEnv({ RENDER_NARRATION_MODEL: "", RENDER_MUSIC_MODEL: "   " }),
    );
    expect(env.RENDER_NARRATION_MODEL).toBeUndefined();
    expect(env.RENDER_MUSIC_MODEL).toBeUndefined();
  });

  it("accepts render audio model ids when supplied", () => {
    const env = loadEnv(
      validEnv({ RENDER_NARRATION_MODEL: "a/b", RENDER_MUSIC_MODEL: "c/d" }),
    );
    expect(env.RENDER_NARRATION_MODEL).toBe("a/b");
    expect(env.RENDER_MUSIC_MODEL).toBe("c/d");
  });

  it("does NOT introduce REMOTION_ASSET_BASE_URL (assets resolve via staticFile, plan D1)", () => {
    const env = loadEnv(validEnv()) as Record<string, unknown>;
    expect(env.REMOTION_ASSET_BASE_URL).toBeUndefined();
  });
});

describe("DBOS_SYSTEM_DATABASE_SCHEMA (the optional system-schema knob)", () => {
  it("U-DBENV-DS1: DBOS_SYSTEM_DATABASE_SCHEMA is OPTIONAL — a valid env without it parses and the value is undefined", () => {
    const env = loadEnv(validEnv());
    // The pin that shipped behaviour is unchanged: unset ⇒ undefined ⇒ DBOS.setConfig
    // receives `undefined` ⇒ the SDK's own default schema "dbos" stands, which is the
    // schema the api's enqueuer (also unset) writes into.
    expect(env.DBOS_SYSTEM_DATABASE_SCHEMA).toBeUndefined();

    const set = loadEnv(
      validEnv({ DBOS_SYSTEM_DATABASE_SCHEMA: "dbos_e2e_dbos_noop" }),
    );
    expect(set.DBOS_SYSTEM_DATABASE_SCHEMA).toBe("dbos_e2e_dbos_noop");
  });

  it("U-DBENV-DS2: a non-identifier DBOS_SYSTEM_DATABASE_SCHEMA is rejected with a message naming the var", () => {
    for (const bad of ['a"b', "a;b", "a b", "Dbos", "1abc", "a-b"]) {
      expect(
        () => loadEnv(validEnv({ DBOS_SYSTEM_DATABASE_SCHEMA: bad })),
        bad,
      ).toThrow(/DBOS_SYSTEM_DATABASE_SCHEMA/);
    }
  });

  it("U-DBENV-DS3: .env.example documents the key, ships it UNSET, and states the api↔dbos agreement rule", () => {
    // The fifth reader of a config key is the operator, and `.env.example` is the only
    // place they meet it. The wording here is deliberately IDENTICAL to the api's
    // (`supagloo-nodejs-api/.env.example`, guarded by its U-ENV-DS3): the whole hazard
    // is that the two services disagree, so the two docs must not.
    const example = readFileSync(
      join(__dirname, "..", "..", ".env.example"),
      "utf8",
    );

    expect(example).toContain("DBOS_SYSTEM_DATABASE_SCHEMA");
    // Shipped UNSET — a live value here would silently repartition a developer's stack.
    expect(example).not.toMatch(/^DBOS_SYSTEM_DATABASE_SCHEMA=/m);
    expect(example).toMatch(/^#\s*DBOS_SYSTEM_DATABASE_SCHEMA=/m);

    const at = example.indexOf("DBOS_SYSTEM_DATABASE_SCHEMA");
    const section = example.slice(Math.max(0, at - 1400), at + 500);
    expect(section).toMatch(/same value/i);
    expect(section).toMatch(/nothing polls|never polls|no worker polls/i);
  });
});
