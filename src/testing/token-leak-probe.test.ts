import { describe, expect, it } from "vitest";
import { encryptSecret } from "@supagloo/database-lib";
import { TEST_SECRETS_ENCRYPTION_KEY } from "./secrets-fixture";
import {
  GITHUB_TOKEN_SHAPE,
  findTokenShapedCheckpoints,
  unwrapCheckpointString,
  type CheckpointRow,
} from "./token-leak-probe";

/**
 * The pure half of plan row 48's e2e probe. The DB half is exercised for real by the five
 * git-ops/render lanes; the SCANNER is unit-tested here because a leak detector that
 * silently matches nothing is indistinguishable from a clean system — and that is exactly
 * the vacuous-pass failure mode the probe exists to avoid.
 */

const row = (over: Partial<CheckpointRow>): CheckpointRow => ({
  function_id: 1,
  function_name: "step",
  output: null,
  error: null,
  ...over,
});

describe("GITHUB_TOKEN_SHAPE", () => {
  it("U-TLP1: matches every GitHub credential prefix at realistic length", () => {
    for (const prefix of ["ghs_", "ghp_", "gho_", "ghu_", "ghr_"]) {
      expect(GITHUB_TOKEN_SHAPE.test(`${prefix}${"a1B2".repeat(8)}`)).toBe(true);
    }
    expect(GITHUB_TOKEN_SHAPE.test(`github_pat_${"a1B2_".repeat(6)}`)).toBe(true);
  });

  it("U-TLP2: matches the LONG, separator-bearing shape real api.github.com actually returns", () => {
    // MEASURED, not assumed: a real installation token minted by this App in the render
    // lane was 383 characters and carried characters outside [A-Za-z0-9_] within the first
    // twenty. An earlier `[A-Za-z0-9]{20,}` tail matched some real tokens and missed
    // others depending on where the first separator fell — a silent miss in a leak
    // detector, which is the one failure mode that must not exist here.
    const real = `ghs_${"A1b2C3d4".repeat(4)}.${"e5F6g7H8".repeat(4)}-${"i9J0k1L2".repeat(4)}`;
    expect(real.length).toBeGreaterThan(100);
    expect(GITHUB_TOKEN_SHAPE.test(real)).toBe(true);
  });

  it("U-TLP3: does not match prose, git shas, or the step name itself", () => {
    expect(GITHUB_TOKEN_SHAPE.test("mintInstallationToken")).toBe(false);
    expect(GITHUB_TOKEN_SHAPE.test("9f2c1b7e4a6d8c0f3e5a7b9d1c3e5f7a9b1d3f50")).toBe(false);
    expect(GITHUB_TOKEN_SHAPE.test("the token was minted")).toBe(false);
    // Short enough to be a placeholder rather than a credential.
    expect(GITHUB_TOKEN_SHAPE.test("ghs_token")).toBe(false);
  });

  it("U-TLP3b: does not match a sealed token (the whole point of the fix)", () => {
    const sealed = encryptSecret(`ghs_${"a1B2".repeat(8)}`, TEST_SECRETS_ENCRYPTION_KEY);
    expect(GITHUB_TOKEN_SHAPE.test(sealed)).toBe(false);
  });
});

describe("findTokenShapedCheckpoints", () => {
  const leaky = `ghs_${"a1B2".repeat(8)}`;

  it("U-TLP4: flags a token in `output`", () => {
    const found = findTokenShapedCheckpoints([
      row({ function_name: "markJobRunning", output: "null" }),
      row({ function_name: "mintInstallationToken", output: `{"json":"${leaky}"}` }),
    ]);
    expect(found.map((r) => r.function_name)).toEqual(["mintInstallationToken"]);
  });

  it("U-TLP5: flags a token in `error` too — a failed step checkpoints its message", () => {
    const found = findTokenShapedCheckpoints([
      row({ function_name: "cloneToWorkspace", error: `fatal: auth failed for ${leaky}` }),
    ]);
    expect(found).toHaveLength(1);
  });

  it("U-TLP6: returns nothing for an all-sealed workflow", () => {
    const sealed = encryptSecret(leaky, TEST_SECRETS_ENCRYPTION_KEY);
    expect(
      findTokenShapedCheckpoints([
        row({ function_name: "mintInstallationToken", output: `{"json":"${sealed}"}` }),
        row({ function_name: "finalizeRecords", output: '{"json":null}' }),
      ]),
    ).toEqual([]);
  });
});

describe("unwrapCheckpointString", () => {
  it("U-TLP7: unwraps the SDK's `{json: …}` envelope and a bare JSON string", () => {
    expect(unwrapCheckpointString('{"json":"abc"}')).toBe("abc");
    expect(unwrapCheckpointString('"abc"')).toBe("abc");
  });

  it("U-TLP8: falls back to the raw text so a serializer change degrades to a decrypt error", () => {
    expect(unwrapCheckpointString("not-json-at-all")).toBe("not-json-at-all");
    expect(unwrapCheckpointString('{"other":1}')).toBe('{"other":1}');
  });
});
