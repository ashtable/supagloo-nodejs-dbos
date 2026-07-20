import { describe, expect, it } from "vitest";
import { resolveLatestVersionBranch } from "./versions";

// resolveLatestVersionBranch picks the highest `vN.N.N` branch by REAL semver compare
// (design-delta §2.6: imported semver is free-form — 0.2.3, 0.10.0 — so ordering MUST
// be numeric; a lexical sort would wrongly pick v0.2.3 over v0.10.0). It returns the
// branch name (with the `v`) plus the stored, `v`-less semver, and ignores any
// non-version branches in the list.

describe("resolveLatestVersionBranch", () => {
  it("picks the highest version by numeric semver, NOT lexical order", () => {
    const r = resolveLatestVersionBranch(["v0.1.0", "v0.2.3", "v0.10.0"]);
    // Lexically "v0.2.3" > "v0.10.0"; numerically 0.10.0 is the newer version.
    expect(r.branchName).toBe("v0.10.0");
    expect(r.semver).toBe("0.10.0");
  });

  it("strips the leading v for the stored semver", () => {
    expect(resolveLatestVersionBranch(["v0.0.1"])).toEqual({
      branchName: "v0.0.1",
      semver: "0.0.1",
    });
  });

  it("ignores non-version branches when resolving", () => {
    const r = resolveLatestVersionBranch([
      "main",
      "v0.0.1",
      "feature/x",
      "v1.4.2",
      "develop",
    ]);
    expect(r.branchName).toBe("v1.4.2");
    expect(r.semver).toBe("1.4.2");
  });

  it("handles a single version branch", () => {
    expect(resolveLatestVersionBranch(["v2.0.0"]).branchName).toBe("v2.0.0");
  });

  it("throws when there is no version branch to resolve (precondition: verify ran)", () => {
    expect(() => resolveLatestVersionBranch(["main", "dev"])).toThrow();
  });
});
