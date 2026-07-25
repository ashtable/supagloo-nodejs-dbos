import { describe, expect, it } from "vitest";
import { buildInstallArgs, LOCKFILE_NAME } from "./npm";

/**
 * Task #36 — `installDependencies` runs the cloned (user-controlled) project's install
 * with `--ignore-scripts` ALWAYS, so no `preinstall`/`postinstall`/`prepare` lifecycle
 * script from the repo ever executes on the worker (design-delta §7 workflow 9,
 * "Untrusted-code isolation").
 *
 * The design says `npm ci`. `npm ci` REQUIRES a lockfile, and the Supagloo-generated
 * Remotion project template ships none (src/remotion/templates.ts emits package.json
 * only) — so the plan is `ci` when a lockfile is present and `install` when it is not.
 * `--ignore-scripts` is non-negotiable on BOTH paths.
 */

describe("buildInstallArgs", () => {
  it("uses `npm ci --ignore-scripts` when a lockfile is present", () => {
    const args = buildInstallArgs(true);
    expect(args[0]).toBe("ci");
    expect(args).toContain("--ignore-scripts");
  });

  it("falls back to `npm install --ignore-scripts` when the project has no lockfile", () => {
    const args = buildInstallArgs(false);
    expect(args[0]).toBe("install");
    expect(args).toContain("--ignore-scripts");
  });

  it("ALWAYS passes --ignore-scripts, on every variant", () => {
    for (const hasLockfile of [true, false]) {
      expect(buildInstallArgs(hasLockfile)).toContain("--ignore-scripts");
    }
  });

  it("never re-enables scripts via a competing flag", () => {
    for (const hasLockfile of [true, false]) {
      const args = buildInstallArgs(hasLockfile);
      expect(args).not.toContain("--foreground-scripts");
      expect(args).not.toContain("--unsafe-perm");
      expect(args).not.toContain("--ignore-scripts=false");
      expect(args).not.toContain("--no-ignore-scripts");
    }
  });

  it("keeps the install quiet and non-interactive (no audit/fund network chatter)", () => {
    const args = buildInstallArgs(false);
    expect(args).toContain("--no-audit");
    expect(args).toContain("--no-fund");
  });

  it("pins the lockfile name it probes for", () => {
    expect(LOCKFILE_NAME).toBe("package-lock.json");
  });
});
