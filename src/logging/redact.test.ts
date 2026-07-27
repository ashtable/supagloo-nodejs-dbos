import { afterEach, describe, expect, it } from "vitest";
import {
  __resetLogSecrets,
  redactForLog,
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
