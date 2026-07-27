import { afterEach, describe, expect, it } from "vitest";
import {
  __resetLogSecrets,
  bootLogSecrets,
  redactForLog,
  redactForLogSafe,
  redactSecretsFromText,
  registerLogSecrets,
} from "./redact";
import { WORKER_FAILED_LOG, WORKER_READY_LOG } from "../dbos/worker-log";

/**
 * Plan row 43, dbos half — "redaction so secrets are never logged" (design-delta §2.10).
 *
 * The technique is the one design-delta §11.8:2460-2472 pins for the git wrapper and
 * `github-e2e.test.ts` already uses for the fixture-git seam: put a distinctive SENTINEL
 * where a secret would be and assert the sentinel is ABSENT from everything the serializer
 * emits. Asserting "it looks redacted" is not the same property — a sibling field, a
 * `cause`, or a stack frame carrying the raw value passes that and still leaks.
 *
 * Two things this must NOT do:
 *   - break `WORKER_READY_LOG` / `WORKER_FAILED_LOG`. They are grep-scraped CROSS-REPO by
 *     the nextjs render lane's `globalSetup` out of `docker compose logs --no-color dbos`,
 *     and the failure string in the tail is treated as a HARD failure. Reformatting,
 *     prefixing or reordering them breaks another repo's lane invisibly (brief §0.7 / R4).
 *   - claim to have closed the documented residual (design-delta §11.8:2469-2472): the
 *     installation token still lives in the git child's argv while it runs and in a
 *     clone's `.git/config`. Redacting what we LOG does not change that.
 */

const SENTINEL = "ghs_S3NT1NELtokenValue0000000000000000";

afterEach(() => {
  __resetLogSecrets();
});

describe("redactSecretsFromText", () => {
  it("redacts a GitHub token embedded in free text", () => {
    const out = redactSecretsFromText(`clone failed using ${SENTINEL} for acme/x`);
    expect(out).not.toContain(SENTINEL);
    expect(out).toContain("acme/x");
  });

  it("redacts URL userinfo in BOTH an https clone URL and a postgres DSN", () => {
    const out = redactSecretsFromText(
      `https://x-access-token:${SENTINEL}@github.com/acme/x.git and ` +
        `postgres://supagloo:${SENTINEL}@db:5432/supagloo`,
    );
    expect(out).not.toContain(SENTINEL);
    // The username survives for debuggability — that is `redactUrlCredentials`' contract.
    expect(out).toContain("x-access-token:***@github.com/acme/x.git");
    expect(out).toContain("supagloo:***@db:5432/supagloo");
  });

  it("redacts a PEM private-key block whole", () => {
    const pem =
      "-----BEGIN RSA PRIVATE KEY-----\nMIIEow" + SENTINEL + "\n-----END RSA PRIVATE KEY-----";
    const out = redactSecretsFromText(`bad key: ${pem}`);
    expect(out).not.toContain(SENTINEL);
    expect(out).not.toContain("MIIEow");
  });

  it("redacts a 64-hex encryption key but LEAVES a 40-char git sha alone", () => {
    const key = "7c4a8d09ca3762af61e59520943dc26494f8941b1a3c5f9e2d6b0a7e4f13c85d";
    const sha = "1f0c2a9b3d4e5f60718293a4b5c6d7e8f9012345";
    const out = redactSecretsFromText(`key=${key} sha=${sha}`);
    expect(out).not.toContain(key);
    // Git shas are the single most useful thing in a git-ops failure log. Redacting them
    // would make the redactor a debuggability regression, so the hex rule starts at 64.
    expect(out).toContain(sha);
  });

  it("redacts an OpenRouter-shaped key and a Bearer credential", () => {
    const out = redactSecretsFromText(
      "authorization: Bearer sk-or-v1-abcdef0123456789abcdef0123456789",
    );
    expect(out).not.toContain("sk-or-v1-abcdef0123456789abcdef0123456789");
  });

  it("leaves ordinary text untouched", () => {
    const text = "open pull request failed: 422 — No commits between main and v0.0.1";
    expect(redactSecretsFromText(text)).toBe(text);
  });
});

describe("registerLogSecrets", () => {
  it("redacts a shapeless secret by exact value once registered", () => {
    // A Gloo client secret / S3 secret key has no recognisable prefix or length, so shape
    // matching cannot see it. Registering the CONFIGURED values at boot closes that gap.
    const shapeless = "wq8Zrt-Not-A-Shape-42";
    expect(redactSecretsFromText(`secret=${shapeless}`)).toContain(shapeless);
    registerLogSecrets([shapeless]);
    expect(redactSecretsFromText(`secret=${shapeless}`)).not.toContain(shapeless);
  });

  it("ignores empty and implausibly short values so it cannot redact the whole log", () => {
    registerLogSecrets(["", undefined, "abc"]);
    const text = "abc def";
    expect(redactSecretsFromText(text)).toBe(text);
  });
});

describe("redactForLog", () => {
  it("emits a serializable error with the sentinel absent from EVERY field", () => {
    const err = new Error(
      `git clone https://x-access-token:${SENTINEL}@github.com/acme/x.git failed`,
    );
    (err as Error & { stderr?: string }).stderr = `fatal: Authentication for ${SENTINEL}`;
    const out = redactForLog(err);
    const serialized = JSON.stringify(out);
    expect(serialized).not.toContain(SENTINEL);
    // Still an actionable error, not a black box.
    expect(serialized).toContain("git clone");
    expect((out as { name?: string }).name).toBe("Error");
  });

  it("drops `cause` entirely rather than trusting it to be clean", () => {
    // `git.ts`'s `toGitCommandError` makes the same call and for the same reason: the raw
    // rejection's message, cmd and stack all carry the plaintext clone URL, and a nested
    // unknown object is not something a serializer can promise to have scrubbed.
    const err = new Error("wrapped");
    (err as Error & { cause?: unknown }).cause = new Error(`inner ${SENTINEL}`);
    const out = redactForLog(err);
    const serialized = JSON.stringify(out);
    // The serializer must produce a PLAIN object — an `Error` has no enumerable own
    // properties, so returning it unchanged serializes to `{}` and would pass a
    // "sentinel absent" assertion while logging the raw error through `console.error`'s
    // own inspector. Requiring the message to be present is what makes this test real.
    expect(serialized).toContain("wrapped");
    expect(serialized).not.toContain(SENTINEL);
    expect(serialized).not.toContain("inner");
    expect(Object.keys(out as object)).not.toContain("cause");
  });

  it("scrubs the stack trace too", () => {
    const err = new Error("boom");
    err.stack = `Error: boom\n    at run (/app/${SENTINEL}/x.js:1:1)`;
    const serialized = JSON.stringify(redactForLog(err));
    expect(serialized).toContain("boom");
    expect(serialized).not.toContain(SENTINEL);
  });

  it("handles non-Error throwables without losing them", () => {
    expect(JSON.stringify(redactForLog(`plain string with ${SENTINEL}`))).not.toContain(
      SENTINEL,
    );
    expect(JSON.stringify(redactForLog({ token: SENTINEL }))).not.toContain(SENTINEL);
    expect(redactForLog(undefined)).toBeDefined();
  });

  it("keeps a GithubRestError-shaped `status` readable", () => {
    const err = Object.assign(new Error("merge pull request failed: 503"), { status: 503 });
    expect(redactForLog(err)).toMatchObject({ status: 503 });
  });

  /**
   * Step-11 item 18 (R4344-6) — a NON-STRING `message` used to make the redactor THROW.
   *
   * Reproduced: `redactSecretsFromText(err.message)` on an `Error` whose `message` had been
   * reassigned to an object raised `TypeError: text.replace is not a function`. `Error.message`
   * is a plain writable property, and libraries do reassign it (some AWS/Prisma/Zod wrappers
   * attach a structured payload there, and `Object.assign(new Error(), {...})` is a common
   * idiom in this very repo).
   *
   * In dbos the consequence is STRUCTURAL, not cosmetic. `main.ts` does
   * `console.error(WORKER_FAILED_LOG, redactForLog(err))` — the argument is evaluated FIRST,
   * so a throw inside the redactor suppresses the log line AND the `process.exit(1)` that
   * follows it. `WORKER_FAILED_LOG` is grep-scraped from `docker compose logs dbos` by the
   * nextjs render lane's `globalSetup` and treated as a hard failure signal (§0.7 / R4). So
   * the cross-repo boot-failure signal vanished exactly when a boot failed in an unusual way,
   * and the worker stayed up with a broken runtime instead of exiting.
   */
  it("does NOT throw on a non-string `message`, and still redacts it (item 18)", () => {
    const err = Object.assign(new Error(), { message: { tok: SENTINEL } });
    let out: unknown;
    expect(() => {
      out = redactForLog(err);
    }).not.toThrow();
    expect(out).toBeDefined();
    expect(typeof (out as { message: unknown }).message).toBe("string");
    expect(JSON.stringify(out)).not.toContain(SENTINEL);
  });

  it("survives every other non-string `message` shape a library might attach", () => {
    for (const message of [undefined, null, 42, [SENTINEL], { a: { b: SENTINEL } }, true]) {
      const err = Object.assign(new Error(), { message });
      let out: unknown;
      expect(() => {
        out = redactForLog(err);
      }, String(message)).not.toThrow();
      expect(typeof (out as { message: unknown }).message, String(message)).toBe("string");
      expect(JSON.stringify(out), String(message)).not.toContain(SENTINEL);
    }
  });
});

/**
 * Step-11 item 18 (R4344-6), belt-and-braces half — the serializer `main.ts` calls cannot
 * throw, because a throw there costs the cross-repo boot-failure signal AND the exit code.
 */
describe("redactForLogSafe", () => {
  it("returns a payload for every throwable shape, never throwing", () => {
    const shapes: unknown[] = [
      new Error(`boom ${SENTINEL}`),
      Object.assign(new Error(), { message: { tok: SENTINEL } }),
      Object.assign(new Error(), { message: 42 }),
      `bare string ${SENTINEL}`,
      { token: SENTINEL },
      undefined,
      null,
      // A getter that throws is the pathological case the guard exists for.
      Object.defineProperty(new Error("x"), "message", {
        get() {
          throw new Error("message getter exploded");
        },
      }),
    ];
    shapes.forEach((shape, i) => {
      // Labelled by INDEX, not `String(shape)`: the last shape's `message` getter throws, so
      // stringifying it here would raise inside the assertion label rather than inside the
      // thing under test.
      const label = `shape[${i}]`;
      let out: unknown;
      expect(() => {
        out = redactForLogSafe(shape);
      }, label).not.toThrow();
      expect(out, label).toBeDefined();
      expect(JSON.stringify(out) ?? "", label).not.toContain(SENTINEL);
    });
  });

  it("is indistinguishable from redactForLog on the normal path", () => {
    const err = new Error(`clone failed for ${SENTINEL}`);
    expect(redactForLogSafe(err)).toEqual(redactForLog(err));
  });
});

/**
 * Step-11 item 19 (R4344-5) — the DSN password.
 *
 * Reproduced: `postgres://user:p@ssw0rdLong@db:5432/x` redacted to
 * `postgres://user:***@ssw0rdLong@db:5432/x`, because layer 1's userinfo class stopped at the
 * FIRST `@`. Neither service registered its DSN password, so layer 2 did not catch it either
 * — the two layers failed on the same input for two different reasons, which is why the
 * fix is both of them.
 */
describe("DSN passwords (item 19)", () => {
  const PW = "p@ssw0rdLongEnough";
  const DBOS_DSN = `postgres://supagloo:${PW}@db:5432/supagloo_dbos`;
  const APP_DSN = `postgres://supagloo:${PW}@db:5432/supagloo`;

  const bootEnv = {
    SECRETS_ENCRYPTION_KEY: "a".repeat(64),
    GITHUB_APP_PRIVATE_KEY: "-----BEGIN RSA PRIVATE KEY-----\nX\n-----END RSA PRIVATE KEY-----",
    S3_SECRET_KEY: "s3-secret-value",
    S3_ACCESS_KEY: "s3-access-value",
    YOUVERSION_APP_KEY: undefined,
    DATABASE_URL: APP_DSN,
    DBOS_DATABASE_URL: DBOS_DSN,
  };

  it("U-RED-DSN1: layer 1 alone redacts a password containing `@` to its END, not its first @", () => {
    // The regex half. No registration, so this is `redactUrlCredentials` on its own.
    const out = redactSecretsFromText(DBOS_DSN);
    expect(out).toBe("postgres://supagloo:***@db:5432/supagloo_dbos");
    expect(out).not.toContain("ssw0rdLongEnough");
  });

  it("U-RED-DSN2: layer 1 still redacts each authority independently on a multi-URL line", () => {
    // The greed must stay local — `/` and whitespace bound it.
    const line =
      `clone https://x-access-token:ghs_AAAAAAAAAAAAAAAAAAAA@github.com/a/b.git ` +
      `then https://u:p@example.com/c reported by dev@example.com`;
    const out = redactSecretsFromText(line);
    expect(out).toContain("https://x-access-token:***@github.com/a/b.git");
    expect(out).toContain("https://u:***@example.com/c");
    // A bare email address is not URL userinfo and must be left alone.
    expect(out).toContain("dev@example.com");
  });

  it("U-RED-DSN3: bootLogSecrets registers BOTH DSN passwords, so layer 2 catches a bare value", () => {
    registerLogSecrets(bootLogSecrets(bootEnv));
    // The case layer 1 structurally cannot reach: a Prisma/`pg` error that quotes the
    // password alone, with no surrounding URL.
    const out = redactSecretsFromText(
      `PrismaClientInitializationError: authentication failed for user "supagloo" ` +
        `(password: ${PW})`,
    );
    expect(out).not.toContain(PW);
    expect(out).not.toContain("ssw0rdLongEnough");
    expect(out).toContain("***");
  });

  it("U-RED-DSN4: registers the other non-shaped values too, and skips an absent one", () => {
    registerLogSecrets(bootLogSecrets(bootEnv));
    for (const value of [bootEnv.S3_SECRET_KEY, bootEnv.S3_ACCESS_KEY]) {
      expect(redactSecretsFromText(`config: ${value}`)).not.toContain(value);
    }
    // An undefined YOUVERSION_APP_KEY must not become the string "undefined" in the set —
    // that would redact the word "undefined" out of every log line in the process.
    expect(redactSecretsFromText("value was undefined")).toBe("value was undefined");
  });

  it("U-RED-DSN5: a passwordless or unparseable DSN registers nothing rather than throwing", () => {
    expect(() =>
      registerLogSecrets(
        bootLogSecrets({
          ...bootEnv,
          DATABASE_URL: "postgres://db:5432/supagloo",
          DBOS_DATABASE_URL: "not a url at all",
        }),
      ),
    ).not.toThrow();
    expect(redactSecretsFromText("postgres://db:5432/supagloo")).toBe(
      "postgres://db:5432/supagloo",
    );
  });
});

describe("the cross-repo boot log constants are untouched by redaction", () => {
  it("passes WORKER_READY_LOG and WORKER_FAILED_LOG through byte-identically", () => {
    // The nextjs render lane greps these EXACT strings out of `docker compose logs
    // --no-color dbos`. Redaction runs on the error PAYLOAD, never on the label, and this
    // test is what stops a future "redact everything we print" refactor from silently
    // breaking another repo's globalSetup (brief §0.7 / R4).
    expect(redactSecretsFromText(WORKER_READY_LOG)).toBe(WORKER_READY_LOG);
    expect(redactSecretsFromText(WORKER_FAILED_LOG)).toBe(WORKER_FAILED_LOG);
  });
});
