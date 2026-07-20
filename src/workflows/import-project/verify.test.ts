import { describe, expect, it } from "vitest";
import { NotASupaglooProjectError } from "./errors";
import {
  isVersionBranch,
  verifySupaglooProject,
  versionBranches,
} from "./verify";

// verifySupaglooProject is the PURE content gate for import (design-delta §7 workflow
// 2): a repo is a Supagloo project iff `remotion.config.ts` is present at the root AND
// it has at least one `vN.N.N` (semver) branch. A failure is a typed NON-RETRYABLE
// NotASupaglooProjectError whose message drives the 12b "NOT A SUPAGLOO PROJECT" stage
// state. Pure over its two inputs (a boolean + a branch-name list) so it is fully
// unit-testable without any git.

describe("isVersionBranch / versionBranches", () => {
  it("treats a vN.N.N (or bare N.N.N) name as a version branch", () => {
    expect(isVersionBranch("v0.0.1")).toBe(true);
    expect(isVersionBranch("v0.10.0")).toBe(true);
    expect(isVersionBranch("0.2.3")).toBe(true);
  });

  it("rejects non-semver branch names", () => {
    expect(isVersionBranch("main")).toBe(false);
    expect(isVersionBranch("feature/x")).toBe(false);
    expect(isVersionBranch("v1.2")).toBe(false);
    expect(isVersionBranch("release-1")).toBe(false);
  });

  it("filters a mixed branch list down to the version branches only", () => {
    expect(
      versionBranches(["main", "v0.0.1", "feature/x", "v0.2.3", "dev"]),
    ).toEqual(["v0.0.1", "v0.2.3"]);
  });
});

describe("verifySupaglooProject", () => {
  it("passes when remotion.config.ts is present and there is >=1 version branch", () => {
    expect(() =>
      verifySupaglooProject({
        hasRemotionConfig: true,
        branches: ["main", "v0.0.1"],
      }),
    ).not.toThrow();
  });

  it("throws a NON-RETRYABLE NotASupaglooProjectError when remotion.config.ts is missing", () => {
    let thrown: unknown;
    try {
      verifySupaglooProject({ hasRemotionConfig: false, branches: ["v0.0.1"] });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(NotASupaglooProjectError);
    expect((thrown as Error).message).toContain("NOT A SUPAGLOO PROJECT");
    expect((thrown as NotASupaglooProjectError).permanent).toBe(true);
  });

  it("throws NotASupaglooProjectError when there is no version branch", () => {
    expect(() =>
      verifySupaglooProject({
        hasRemotionConfig: true,
        branches: ["main", "develop"],
      }),
    ).toThrow(NotASupaglooProjectError);
    try {
      verifySupaglooProject({ hasRemotionConfig: true, branches: ["main"] });
    } catch (e) {
      expect((e as Error).message).toContain("NOT A SUPAGLOO PROJECT");
    }
  });
});
