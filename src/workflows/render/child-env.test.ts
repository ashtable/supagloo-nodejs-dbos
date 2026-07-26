import { describe, expect, it } from "vitest";
import {
  CHILD_ENV_ALLOWLIST,
  buildScrubbedChildEnv,
} from "./child-env";

/**
 * Task #36 — the untrusted-code isolation crux (design-delta §7 workflow 9).
 *
 * The cloned project is USER-CONTROLLED code. `npm ci`, `@remotion/bundler`'s webpack
 * build, and `@remotion/renderer`'s Chromium all execute (or evaluate) that code, so
 * they run in a child process whose environment is built from an explicit ALLOWLIST —
 * never `{ ...process.env, ...overrides }` (the shape `scaffold-project/git.ts` uses,
 * which only ADDS and would leak every secret the worker holds).
 *
 * This suite is the proof: a parent environment stuffed with every secret the dbos
 * worker actually carries must produce a child env that contains none of them, by KEY
 * or by VALUE (a secret smuggled under a renamed key is still a leak).
 *
 * Note on per-user provider keys: OpenRouter API keys are NEVER env vars (they are
 * decrypted from ciphertext at call time), so they cannot leak via inherited env by
 * construction. We assert the *host/base-URL* provider vars are dropped, and we do not
 * invent a requirement to scrub something that was never in the environment.
 */

const SECRET_VALUES = {
  SECRETS_ENCRYPTION_KEY: "0".repeat(64),
  GITHUB_APP_PRIVATE_KEY: "-----BEGIN PRIVATE KEY-----\nMIIEv\n-----END PRIVATE KEY-----",
  GITHUB_APP_ID: "123456",
  DATABASE_URL: "postgres://supagloo:supagloo@postgres:5432/supagloo",
  DBOS_DATABASE_URL: "postgres://supagloo:supagloo@postgres:5432/supagloo_dbos",
  S3_ACCESS_KEY: "supagloo-access-key-value",
  S3_SECRET_KEY: "supagloo-secret-key-value",
  OPENROUTER_BASE_URL: "https://openrouter.example.invalid",
  GLOO_BASE_URL: "https://gloo.example.invalid",
  YOUVERSION_APP_KEY: "yvp-app-key-value",
  AWS_SECRET_ACCESS_KEY: "aws-secret-value",
  OPENROUTER_E2E_TEST_API_KEY: "sk-or-e2e-key-value",
  // Task 62 risk 12: the real-GitHub e2e harness introduces a REAL user-scoped PAT
  // (`GITHUB_E2E_PAT_TOKEN`, the credential that can create/archive repos on the
  // account holding the user's real repos). It is host-side harness-only and must
  // never reach untrusted cloned project code. The allowlist is a closed set, so this
  // holds by construction — pinned here so it stays true.
  GITHUB_E2E_PAT_TOKEN: "ghp_e2e_pat_token_value",
  SOME_FUTURE_TOKEN: "a-var-nobody-has-thought-of-yet",
};

const BENIGN = {
  PATH: "/usr/local/bin:/usr/bin:/bin",
  HOME: "/home/node",
  TMPDIR: "/tmp",
  LANG: "C.UTF-8",
  TZ: "UTC",
};

const PARENT_ENV: Record<string, string> = { ...BENIGN, ...SECRET_VALUES };

describe("buildScrubbedChildEnv — the allowlist is a CLOSED set", () => {
  it("drops every secret and connection string the worker holds", () => {
    const child = buildScrubbedChildEnv({ source: PARENT_ENV });
    for (const name of Object.keys(SECRET_VALUES)) {
      expect(child, `child env must not carry ${name}`).not.toHaveProperty(name);
    }
  });

  it("does not smuggle any secret VALUE through under a different key", () => {
    const child = buildScrubbedChildEnv({ source: PARENT_ENV });
    const values = Object.values(child);
    for (const [name, secret] of Object.entries(SECRET_VALUES)) {
      expect(
        values.some((v) => v.includes(secret)),
        `the value of ${name} leaked into the child env`,
      ).toBe(false);
    }
  });

  it("drops an unknown variable that is not on the allowlist (default-deny)", () => {
    const child = buildScrubbedChildEnv({
      source: { ...PARENT_ENV, TOTALLY_NEW_VAR: "x" },
    });
    expect(child).not.toHaveProperty("TOTALLY_NEW_VAR");
  });

  it("passes through only the benign vars Node/npm/Chromium need", () => {
    const child = buildScrubbedChildEnv({ source: PARENT_ENV });
    expect(child.PATH).toBe(BENIGN.PATH);
    expect(child.HOME).toBe(BENIGN.HOME);
    expect(child.TMPDIR).toBe(BENIGN.TMPDIR);
    expect(child.LANG).toBe(BENIGN.LANG);
    expect(child.TZ).toBe(BENIGN.TZ);
  });

  it("omits allowlisted names that are absent from the source (no undefined values)", () => {
    const child = buildScrubbedChildEnv({ source: { PATH: "/bin" } });
    expect(Object.keys(child)).toEqual(["PATH"]);
    for (const value of Object.values(child)) {
      expect(typeof value).toBe("string");
    }
  });

  it("merges caller-supplied extras on top (the only way anything else gets in)", () => {
    const child = buildScrubbedChildEnv({
      source: PARENT_ENV,
      extra: { REMOTION_SOMETHING: "yes" },
    });
    expect(child.REMOTION_SOMETHING).toBe("yes");
    expect(child.PATH).toBe(BENIGN.PATH);
    expect(child).not.toHaveProperty("SECRETS_ENCRYPTION_KEY");
  });

  it("exposes the allowlist itself and keeps it free of any secret-shaped name", () => {
    expect(CHILD_ENV_ALLOWLIST.length).toBeGreaterThan(0);
    for (const name of CHILD_ENV_ALLOWLIST) {
      expect(name).not.toMatch(/SECRET|PRIVATE|PASSWORD|TOKEN|API_KEY|DATABASE_URL/i);
    }
  });

  it("defaults its source to process.env but still scrubs it", () => {
    const previous = process.env.SECRETS_ENCRYPTION_KEY;
    process.env.SECRETS_ENCRYPTION_KEY = "1".repeat(64);
    try {
      const child = buildScrubbedChildEnv();
      expect(child).not.toHaveProperty("SECRETS_ENCRYPTION_KEY");
    } finally {
      if (previous === undefined) delete process.env.SECRETS_ENCRYPTION_KEY;
      else process.env.SECRETS_ENCRYPTION_KEY = previous;
    }
  });
});
