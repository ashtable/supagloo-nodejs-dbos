import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { REACT_VERSION, REMOTION_VERSION } from "./versions";

/**
 * Guardrail (same spirit as the Prisma-pin test): the versions stamped into every
 * generated project's package.json (REMOTION_VERSION / REACT_VERSION) must equal
 * the EXACT versions dbos itself installs — so the worker that runs bundle() and
 * the projects it generates never drift apart. Exact pins only (no `^`/`~`).
 */
const pkg = JSON.parse(
  readFileSync(join(__dirname, "..", "..", "package.json"), "utf8"),
) as { dependencies?: Record<string, string> };

const deps = pkg.dependencies ?? {};

describe("remotion/react dependency pins", () => {
  it("dbos pins remotion + @remotion/bundler to REMOTION_VERSION exactly", () => {
    expect(deps.remotion).toBe(REMOTION_VERSION);
    expect(deps["@remotion/bundler"]).toBe(REMOTION_VERSION);
  });

  it("dbos pins react + react-dom to REACT_VERSION exactly", () => {
    expect(deps.react).toBe(REACT_VERSION);
    expect(deps["react-dom"]).toBe(REACT_VERSION);
  });

  it("uses exact pins (no caret/tilde ranges)", () => {
    for (const name of ["remotion", "@remotion/bundler", "react", "react-dom"]) {
      expect(deps[name]).toMatch(/^\d+\.\d+\.\d+$/);
    }
  });
});
