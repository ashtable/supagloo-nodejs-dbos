import { parseSemver } from "@supagloo/database-lib";
import { NotASupaglooProjectError } from "./errors";

/**
 * `verifySupaglooProject` — the pure content gate (design-delta §7 workflow 2).
 *
 * A repo is a Supagloo project iff BOTH hold: `remotion.config.ts` is present at the
 * repo root (the documented marker — see remotion/templates.ts) AND it has at least one
 * `vN.N.N` version branch. This runs BEFORE `resolveLatestVersionBranch`, so it is pure
 * over the two facts the workflow has already gathered from the clone: whether the file
 * exists on the default-branch checkout, and the list of remote-tracking branch names.
 * A failure is a typed NON-RETRYABLE {@link NotASupaglooProjectError}.
 */

/** True iff `name` parses as a semver (`vN.N.N` or bare `N.N.N`) — a version branch. */
export function isVersionBranch(name: string): boolean {
  return parseSemver(name) !== null;
}

/** Keep only the version branches from a list of branch names. */
export function versionBranches(branches: string[]): string[] {
  return branches.filter(isVersionBranch);
}

export interface VerifyInput {
  /** Whether `remotion.config.ts` exists at the checked-out repo root. */
  hasRemotionConfig: boolean;
  /** All remote-tracking branch names (short form, e.g. `main`, `v0.10.0`). */
  branches: string[];
}

export function verifySupaglooProject(input: VerifyInput): void {
  if (!input.hasRemotionConfig) {
    throw new NotASupaglooProjectError(
      "NOT A SUPAGLOO PROJECT: remotion.config.ts is missing at the repository root",
    );
  }
  if (versionBranches(input.branches).length === 0) {
    throw new NotASupaglooProjectError(
      "NOT A SUPAGLOO PROJECT: no version branch (vN.N.N) was found in the repository",
    );
  }
}
