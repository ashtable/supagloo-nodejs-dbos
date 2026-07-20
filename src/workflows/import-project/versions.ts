import { compareSemver, parseSemver } from "@supagloo/database-lib";

/**
 * `resolveLatestVersionBranch` — pick the highest `vN.N.N` branch by REAL semver
 * compare (design-delta §2.6). Imported semver is free-form (`0.2.3`, `0.10.0`), so a
 * lexical sort is wrong (`"0.10.0" < "0.2.3"` lexically, yet 0.10.0 is newer) — ordering
 * MUST be numeric, via the shared `compareSemver`. Non-version branches are ignored.
 * Returns the branch name (with its leading `v`) plus the stored, `v`-less semver that
 * `ProjectVersion.semver` persists.
 *
 * Precondition: `verifySupaglooProject` has already established >=1 version branch, so
 * an empty result is a programming error (thrown, not a typed content failure).
 */
export interface ResolvedVersion {
  branchName: string;
  semver: string;
}

export function resolveLatestVersionBranch(branches: string[]): ResolvedVersion {
  const versionBranches = branches.filter((b) => parseSemver(b) !== null);
  if (versionBranches.length === 0) {
    throw new Error(
      "resolveLatestVersionBranch: no version branch to resolve (verify must run first)",
    );
  }
  // Ascending semver sort; the last element is the highest version.
  const sorted = [...versionBranches].sort(compareSemver);
  const branchName = sorted[sorted.length - 1];
  return { branchName, semver: branchName.replace(/^v/, "") };
}
