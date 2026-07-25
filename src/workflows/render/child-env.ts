/**
 * The scrubbed child-process environment (design-delta §7 workflow 9, "Untrusted-code
 * isolation").
 *
 * The cloned project is USER-CONTROLLED code. `npm install` resolves its dependency tree,
 * `@remotion/bundler` runs webpack over its sources, and `@remotion/renderer` evaluates it
 * inside Chromium — all of which execute code we did not write. None of those processes
 * has any business seeing the worker's secrets.
 *
 * So the child environment is built from an explicit ALLOWLIST: default-deny, with only
 * the handful of variables Node, npm, and Chromium genuinely need, plus whatever the
 * caller passes explicitly. This is deliberately the OPPOSITE shape from
 * `scaffold-project/git.ts`'s `{ ...process.env, ...HERMETIC_ENV, ...opts.env }`, which
 * only ADDS and would leak `SECRETS_ENCRYPTION_KEY`, `GITHUB_APP_PRIVATE_KEY`, both
 * Postgres connection strings, and the S3 credentials straight into the child.
 *
 * Note on per-user provider keys: OpenRouter API keys are never environment variables —
 * they are decrypted from per-user ciphertext at call time (`providers/credentials.ts`) —
 * so they cannot leak through inherited env by construction.
 *
 * Full sandboxing (microVM / container-per-render) is explicitly post-v1.
 */

/**
 * The closed set of variables a child may inherit. Every name here is either required for
 * the child to run at all (`PATH`, `HOME`) or is inert locale/timezone/temp-dir metadata.
 * Nothing secret-shaped may ever be added — `child-env.test.ts` asserts that.
 *
 * - `PATH`      — find `node` / `npm` / the bundled ffmpeg.
 * - `HOME`      — npm's cache + Remotion's Chrome Headless Shell download directory.
 * - `TMPDIR`/`TEMP`/`TMP` — where Chromium and ffmpeg place their scratch files.
 * - `LANG`/`LANGUAGE`/`LC_ALL` — text shaping/collation inside Chromium.
 * - `TZ`        — deterministic date rendering inside the composition.
 * - `SHELL`/`USER`/`LOGNAME` — npm writes these into its debug logs; harmless.
 * - `SystemRoot`/`SYSTEMROOT`/`COMSPEC` — required for any process to start on Windows.
 */
export const CHILD_ENV_ALLOWLIST: readonly string[] = [
  "PATH",
  "HOME",
  "TMPDIR",
  "TEMP",
  "TMP",
  "LANG",
  "LANGUAGE",
  "LC_ALL",
  "TZ",
  "SHELL",
  "USER",
  "LOGNAME",
  "SystemRoot",
  "SYSTEMROOT",
  "COMSPEC",
] as const;

export interface BuildChildEnvArgs {
  /** Where to inherit from. Defaults to `process.env`. */
  source?: Record<string, string | undefined>;
  /** Explicit additions — the ONLY way anything outside the allowlist gets in. */
  extra?: Record<string, string>;
}

/**
 * Build a child environment containing ONLY allowlisted variables present in `source`,
 * plus `extra`. Absent allowlisted names are omitted entirely (never set to the string
 * `"undefined"`).
 */
export function buildScrubbedChildEnv(
  args: BuildChildEnvArgs = {},
): Record<string, string> {
  const source = args.source ?? process.env;
  const env: Record<string, string> = {};
  for (const name of CHILD_ENV_ALLOWLIST) {
    const value = source[name];
    if (typeof value === "string") {
      env[name] = value;
    }
  }
  return { ...env, ...(args.extra ?? {}) };
}
