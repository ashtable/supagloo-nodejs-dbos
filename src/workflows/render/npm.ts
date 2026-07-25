import { access } from "node:fs/promises";
import { join } from "node:path";

/**
 * `installDependencies` — the argv builder for installing the CLONED (user-controlled)
 * project's dependencies.
 *
 * The one non-negotiable is `--ignore-scripts` (design-delta §7 workflow 9): the repo is
 * user-controlled, so no `preinstall`/`install`/`postinstall`/`prepare` lifecycle script
 * from it may ever execute on the worker.
 *
 * The design says `npm ci`. `npm ci` REQUIRES a lockfile and errors out without one, and
 * the Supagloo-generated Remotion project template ships no lockfile (`templates.ts`
 * emits `package.json` only — a deterministic lockfile cannot be generated offline). So:
 * `ci` when a lockfile is present (the reproducible path, and what an imported real-world
 * project will hit), `install` when it is not. Both carry `--ignore-scripts`.
 */

export const LOCKFILE_NAME = "package-lock.json";

/** Build the `npm` argv for the project's install. */
export function buildInstallArgs(hasLockfile: boolean): string[] {
  return [
    hasLockfile ? "ci" : "install",
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
  ];
}

/** True when the cloned project ships a lockfile (so `npm ci` is usable). */
export async function hasLockfile(projectDir: string): Promise<boolean> {
  try {
    await access(join(projectDir, LOCKFILE_NAME));
    return true;
  } catch {
    return false;
  }
}
