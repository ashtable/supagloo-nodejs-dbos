import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";

// Guardrail for a Railway platform constraint (identical to the API's). database-lib
// is a git submodule, but Railway does NOT initialize submodules and does NOT copy
// the outer repo's .git into the Docker build context, so the Dockerfile cannot read
// the real submodule pin at build time. Instead its deps stage clones database-lib at
// a hardcoded `ARG DATABASE_LIB_REF=<sha>` (see Dockerfile). This test fails loudly
// BEFORE merge if someone bumps the submodule but forgets to update the ARG: it
// asserts the Dockerfile's pinned ref equals the commit the superproject records for
// the submodule. It needs git metadata (.git), so it runs locally / in CI — OUTSIDE
// the Railway/Docker build boundary.

const REPO_ROOT = process.cwd();

/** The commit this repo records for the database-lib submodule (index gitlink). */
function recordedSubmoduleCommit(): string {
  let out: string;
  try {
    out = execFileSync("git", ["ls-files", "-s", "supagloo-database-lib"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
    });
  } catch (err) {
    throw new Error(
      "Could not read the database-lib submodule pin via `git ls-files -s` — " +
        "this guardrail requires git metadata (.git) and is meant to run " +
        "locally / in CI, not inside the Docker build. Underlying error: " +
        String(err),
    );
  }
  // Format: "160000 <40-hex-sha> <stage>\tsupagloo-database-lib"
  const match = out.match(/^160000 ([0-9a-f]{40}) \d+\s+supagloo-database-lib/m);
  if (!match) {
    throw new Error(
      "Unexpected `git ls-files -s` output for the submodule gitlink: " +
        JSON.stringify(out),
    );
  }
  return match[1];
}

/** The commit hardcoded in the Dockerfile's `ARG DATABASE_LIB_REF=<sha>` default. */
function dockerfileDatabaseLibRef(): string {
  const dockerfile = readFileSync(resolve(REPO_ROOT, "Dockerfile"), "utf8");
  const match = dockerfile.match(/^ARG\s+DATABASE_LIB_REF=(\S+)/m);
  if (!match) {
    throw new Error(
      "Dockerfile is missing an `ARG DATABASE_LIB_REF=<sha>` line — the deps " +
        "stage clones database-lib at that pinned commit; it must exist.",
    );
  }
  return match[1];
}

describe("Dockerfile database-lib pin", () => {
  it("keeps ARG DATABASE_LIB_REF in sync with the submodule commit", () => {
    const recorded = recordedSubmoduleCommit();
    const argRef = dockerfileDatabaseLibRef();

    expect(
      argRef,
      `Dockerfile ARG DATABASE_LIB_REF (${argRef}) is out of sync with the ` +
        `supagloo-database-lib submodule pin (${recorded}). When you bump the ` +
        `submodule, update the ARG default in the Dockerfile to the same SHA in ` +
        `the same commit: Railway builds clone db-lib at the ARG, not the ` +
        `submodule, so a stale ARG silently ships the wrong db-lib.`,
    ).toBe(recorded);
  });
});
