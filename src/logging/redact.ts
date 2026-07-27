import { redactUrlCredentials } from "../workflows/scaffold-project/git";

/**
 * Log redaction for the DBOS worker (plan row 43, design-delta §2.10).
 *
 * The worker handles four classes of secret: GitHub App private keys and the installation
 * tokens minted from them, the AES `SECRETS_ENCRYPTION_KEY`, per-user provider credentials
 * decrypted inside the generation workflows, and the Postgres/S3 credentials in its own
 * connection strings. Any of them can end up inside an `Error` — in a message, a `stderr`,
 * a stack frame, or a URL — and `console.error(label, err)` would print it verbatim.
 *
 * TWO LAYERS, because neither alone is enough:
 *
 *   1. **Shape matching** ({@link redactSecretsFromText}) catches values this process has
 *      never held: a `ghs_…` token in a fresh error from a library, a PEM block, a 64-hex
 *      key. It is the only layer that can work for a secret we cannot enumerate.
 *   2. **Exact-value matching** ({@link registerLogSecrets}) catches the ones with no
 *      recognisable shape at all — a Gloo client secret, `S3_SECRET_KEY`,
 *      `YOUVERSION_APP_KEY` — by registering the CONFIGURED values once at boot.
 *
 * WHAT THIS DOES NOT FIX, and must not be read as fixing (design-delta §11.8:2469-2472):
 * the installation token is still present in the git child's argv while `git` runs, and in
 * a clone's `.git/config`. Redacting what we LOG changes neither. That residual is
 * documented, accepted, and outside this row's scope.
 *
 * SCOPE NOTE: `registerLogSecrets` is called by `main.ts` (the process entry point) and
 * nowhere else — it mutates module state exactly once, before `DBOS.launch()`, so no DBOS
 * determinism rule is engaged. Step-11 item 4 additionally imports the PURE
 * {@link redactSecretsFromText} into the four git-ops workflows, where it scrubs the
 * message written to the browser-visible `ProjectJob.error`. That call sits INSIDE the
 * `DBOS.runStep` that records the failure, and its output is checkpointed with the step, so
 * it is a step-local read of boot-time state — not a workflow-body read of mutable module
 * state. Keep it that way: never call `registerLogSecrets` from workflow or step code.
 */

/** Registered exact secret values. Module state, written once at boot from `main.ts`. */
const knownSecrets = new Set<string>();

/**
 * A value short enough that redacting it would corrupt unrelated log text. `"abc"` as a
 * secret would blank every occurrence of those three letters everywhere.
 */
const MIN_REGISTERABLE_SECRET_LENGTH = 8;

const REDACTED = "***";

/**
 * Secret SHAPES, each with a reason to be here rather than a guess:
 *   - GitHub tokens: `ghs_` (installation), `ghp_`/`gho_`/`ghu_`/`ghr_` (user/PAT/refresh)
 *     and the fine-grained `github_pat_` form. Every git-ops workflow holds one.
 *   - PEM private-key blocks: `GITHUB_APP_PRIVATE_KEY`, which arrives as env text and is
 *     echoed by some JWT libraries on a parse failure.
 *   - `sk-…`: the OpenRouter API-key shape, decrypted per user inside the AI workflows.
 *   - Bearer / `token` authorization values: what a header dump looks like.
 *   - 64+ hex characters: the `SECRETS_ENCRYPTION_KEY` shape. Deliberately NOT 40 — a
 *     40-hex run is a git SHA, and git SHAs are the most useful thing in a git-ops failure
 *     log. Starting at 64 keeps the redactor from being a debuggability regression.
 */
const SECRET_PATTERNS: readonly RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /github_pat_[A-Za-z0-9_]{20,}/g,
  /gh[psour]_[A-Za-z0-9_]{16,}/g,
  /\bsk-[A-Za-z0-9\-_]{16,}/g,
  /\b(?:Bearer|bearer|token)\s+[A-Za-z0-9\-._~+/=]{16,}/g,
  /\b[0-9a-fA-F]{64,}\b/g,
];

/** Escape a literal for use inside a RegExp. */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Register secret VALUES (typically straight off the validated env) so they are redacted by
 * exact match wherever they appear. Empty, non-string and implausibly short values are
 * ignored — a three-character "secret" would redact half the log.
 */
export function registerLogSecrets(
  values: Array<string | undefined | null>,
): void {
  for (const value of values) {
    if (typeof value !== "string") continue;
    if (value.length < MIN_REGISTERABLE_SECRET_LENGTH) continue;
    knownSecrets.add(value);
  }
}

/** Test-only: drop every registered value. */
export function __resetLogSecrets(): void {
  knownSecrets.clear();
}

/**
 * Scrub every known secret shape and every registered secret value out of `text`.
 *
 * URL credentials go through {@link redactUrlCredentials} — the SAME implementation
 * `scaffold-project/git.ts` already uses on git failures, rather than a second copy that
 * could drift. It covers `https://x-access-token:<token>@github.com/...` and
 * `postgres://user:<password>@host/db` alike, and keeps the username for debuggability.
 */
export function redactSecretsFromText(text: string): string {
  let out = redactUrlCredentials(text);
  for (const pattern of SECRET_PATTERNS) {
    out = out.replace(pattern, REDACTED);
  }
  // Exact values LAST, so a registered value that also matched a shape is already gone and
  // this pass only has to catch the shapeless ones.
  for (const secret of knownSecrets) {
    out = out.replace(new RegExp(escapeRegExp(secret), "g"), REDACTED);
  }
  return out;
}

/** The redacted, JSON-serializable shape a log line carries instead of a raw error. */
export interface RedactedError {
  name: string;
  message: string;
  stack?: string;
  stderr?: string;
  code?: string | number;
  status?: number;
}

function scrub(value: unknown): string | undefined {
  return typeof value === "string" ? redactSecretsFromText(value) : undefined;
}

/**
 * Coerce anything an `Error.message` might have been reassigned to into a string, WITHOUT
 * losing a secret into an unscrubbed corner (Step-11 item 18).
 *
 * A structured message is JSON-stringified rather than `String(...)`ed, because
 * `String({ tok: "ghs_…" })` is `"[object Object]"` — which does not throw, but silently
 * discards the diagnostic the log line exists for. The result always goes through
 * `redactSecretsFromText` at the call site, so serializing MORE of the payload is safe.
 */
function stringifyMessage(message: unknown): string {
  if (typeof message === "string") return message;
  if (message === undefined || message === null) return "";
  if (typeof message === "object") {
    try {
      return JSON.stringify(message) ?? String(message);
    } catch {
      // Circular, or a throwing `toJSON`.
      return String(message);
    }
  }
  return String(message);
}

/**
 * The serializer. Turns anything throwable into a PLAIN object with every string scrubbed.
 *
 * Plain is load-bearing: an `Error` has no enumerable own properties, so handing one to a
 * logger relies on that logger's own inspector, which prints `message`, `stack`, `cause`
 * and any attached fields verbatim. Projecting onto a known set of keys is what makes
 * "secrets are never logged" checkable rather than aspirational.
 *
 * `cause` is DROPPED, not scrubbed — the same call `git.ts`'s `toGitCommandError` makes,
 * for the same reason: a nested unknown object of arbitrary depth is not something a
 * serializer can promise to have cleaned, and the causes this repo produces carry the
 * plaintext clone URL.
 */
export function redactForLog(err: unknown): RedactedError {
  if (err instanceof Error) {
    const extra = err as Error & {
      stderr?: unknown;
      code?: unknown;
      status?: unknown;
    };
    const out: RedactedError = {
      name: err.name,
      // Step-11 item 18 (R4344-6) — `String(...)` is load-bearing, not defensive noise.
      // `Error.message` is a plain writable property and libraries DO reassign it to a
      // structured payload (`Object.assign(new Error(), { message: {...} })` is a common
      // idiom, including in this repo). Passing that straight to `redactSecretsFromText`
      // raised `TypeError: text.replace is not a function` — and in `main.ts` the throw
      // would take out BOTH `console.error(WORKER_FAILED_LOG, ...)` and the
      // `process.exit(1)` after it, because the argument is evaluated first. That is the
      // cross-repo hard-failure signal the nextjs render lane grep-scrapes (§0.7 / R4)
      // disappearing at exactly the moment it matters.
      message: redactSecretsFromText(stringifyMessage(err.message)),
    };
    const stack = scrub(err.stack);
    if (stack !== undefined) out.stack = stack;
    const stderr = scrub(extra.stderr);
    if (stderr !== undefined) out.stderr = stderr;
    if (typeof extra.code === "number") out.code = extra.code;
    else if (typeof extra.code === "string") out.code = redactSecretsFromText(extra.code);
    if (typeof extra.status === "number") out.status = extra.status;
    return out;
  }
  // A non-Error throwable (a string, a rejected plain object). Stringified first, then
  // scrubbed as text, so an unknown key holding a secret cannot escape by not being one of
  // the fields above.
  let asText: string;
  try {
    asText = typeof err === "string" ? err : (JSON.stringify(err) ?? String(err));
  } catch {
    asText = String(err);
  }
  return { name: "NonError", message: redactSecretsFromText(asText) };
}

/**
 * {@link redactForLog} that CANNOT throw (Step-11 item 18 / R4344-6, the belt-and-braces half).
 *
 * `main.ts` does `console.error(WORKER_FAILED_LOG, redactForLogSafe(err))`, and the argument
 * is evaluated before the call: a throw inside the serializer would suppress the log line AND
 * the `process.exit(1)` that follows it, leaving a broken worker Up with no signal. That
 * signal is scraped CROSS-REPO — the nextjs render lane's `globalSetup` greps
 * `WORKER_FAILED_LOG` out of `docker compose logs --no-color dbos` and treats it as a hard
 * failure (§0.7 / R4) — so losing it is another repo's lane hanging on a timeout.
 *
 * `stringifyMessage` already removes the ONE reproduced throw, so this is a second line of
 * defence rather than the fix. It exists because the cost of being wrong about "the serializer
 * can no longer throw" is a silent boot, and the cost of the guard is four lines.
 */
export function redactForLogSafe(err: unknown): unknown {
  try {
    return redactForLog(err);
  } catch {
    try {
      // `String(err)` on an Error is `${name}: ${message}` and cannot throw for the reason
      // above (it is already a string by the time the redactor sees it).
      return redactSecretsFromText(String(err));
    } catch {
      return "(error payload could not be serialized)";
    }
  }
}

/**
 * The exact set of values `main.ts` registers with {@link registerLogSecrets} at boot.
 *
 * A FUNCTION rather than an inline array in `main.ts` so it is unit-testable: `main.ts` is the
 * process entry point (importing it launches DBOS), so anything asserted only there is
 * asserted by reading source text.
 *
 * ── Step-11 item 19 (R4344-5): the DSN PASSWORDS are the addition ────────────────────────
 *
 * Layer 1 ({@link redactUrlCredentials}) matches URL userinfo, and its character class stops
 * at an `@`. A Postgres password containing `@` — entirely legal, and common in generated
 * credentials — therefore leaked its tail: `postgres://user:p@ssw0rdLong@db:5432/x` came out
 * as `postgres://user:***@ssw0rdLong@db:5432/x`. The class has since been widened to the LAST
 * `@` before the authority, but that alone is not a sufficient answer, because layer 1 can
 * only ever redact what LOOKS like a URL. Registering the parsed password closes it by exact
 * value, wherever it appears — in a Prisma error that quotes only the password, in a
 * `pg` error's `cause` chain, in a stack frame.
 *
 * BOTH DSNs are registered. `DBOS_DATABASE_URL` is the one the SDK holds (and the one whose
 * initialization errors quote it), `DATABASE_URL` is db-lib's; in Compose they share a
 * password, and assuming that is exactly the assumption an operator changes.
 */
export function bootLogSecrets(env: {
  SECRETS_ENCRYPTION_KEY: string;
  GITHUB_APP_PRIVATE_KEY: string;
  S3_SECRET_KEY: string;
  S3_ACCESS_KEY: string;
  YOUVERSION_APP_KEY?: string;
  DATABASE_URL: string;
  DBOS_DATABASE_URL: string;
}): Array<string | undefined> {
  return [
    // The secrets with no recognisable SHAPE — a redactor cannot pattern-match an S3 secret
    // key or a YouVersion app key, so the validated values are registered by exact match.
    // `SECRETS_ENCRYPTION_KEY` and the App private key are shape-matched as well; registering
    // them too costs nothing and closes the gap if a key format ever changes.
    env.SECRETS_ENCRYPTION_KEY,
    env.GITHUB_APP_PRIVATE_KEY,
    env.S3_SECRET_KEY,
    env.S3_ACCESS_KEY,
    env.YOUVERSION_APP_KEY,
    // Item 19: the DSN passwords, parsed. `registerLogSecrets` already ignores empty and
    // implausibly short values, so a passwordless local DSN registers nothing.
    dsnPassword(env.DBOS_DATABASE_URL),
    dsnPassword(env.DATABASE_URL),
  ];
}

/**
 * The password out of a Postgres DSN, or `undefined` if there is none / it will not parse.
 *
 * Never throws: this runs at boot, immediately after `loadEnv`, and a URL the validator
 * accepted but `new URL` rejects must not be the thing that stops redaction being armed.
 */
function dsnPassword(dsn: string): string | undefined {
  try {
    const password = new URL(dsn).password;
    return password === "" ? undefined : decodeURIComponent(password);
  } catch {
    return undefined;
  }
}
