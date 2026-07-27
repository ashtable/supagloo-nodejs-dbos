import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

/**
 * Plan row 42 / **D42.1** — THE fence. The single most dangerous property in this run.
 *
 * `cleanupOrphanedAssetsWorkflow` deletes objects out of the ONE shared `supagloo-dev`
 * MinIO bucket and rows out of the shared app database. Fourteen (now fifteen) e2e lanes
 * launch the REAL DBOS runtime IN-PROCESS against that same bucket and that same app DB —
 * only the DBOS *system* schema is per-lane. So a schedule armed at module load from
 * `runtime.ts` would fire inside every one of them, against the fixtures another spec is
 * mid-assertion on, including the `Session` rows the api's own test-seed endpoint mints.
 *
 * The chosen guard is STRUCTURAL, not configurational (D42.1 shape (ii), chosen over an env
 * flag consulted at registration):
 *
 *   • the WORKFLOW registers at module load from `runtime.ts`, exactly like every other
 *     workflow, so its name is in the frozen registry and a test can invoke it directly;
 *   • `DBOS.registerScheduled` lives in `scheduled-cleanup.ts`, which ONLY `main.ts`
 *     imports. The lanes call `launchDbos()` from `runtime.ts` and never load `main.ts`,
 *     so the SCHEDULE is inert in lanes by construction — no flag to set, no hook to
 *     remember, nothing a future spec can accidentally turn on.
 *
 * This test is the fence around that. It is a SOURCE-level assertion, modelled on
 * `dockerfile-database-lib-pin.test.ts`, deliberately: the alternative — boot a runtime and
 * watch for a schedule that should not fire — is exactly the banned "sample for minutes to
 * prove a precondition" pattern. A property that holds by construction is asserted by
 * reading the construction.
 */

const SRC = resolve(process.cwd(), "src");

const read = (rel: string): string => readFileSync(resolve(SRC, rel), "utf8");

/** Every `.ts` file under `src/`, excluding tests. */
function sourceFiles(dir: string = SRC): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...sourceFiles(full));
      continue;
    }
    if (!entry.endsWith(".ts") || entry.endsWith(".test.ts")) continue;
    out.push(full);
  }
  return out;
}

/**
 * Source with comments removed.
 *
 * The fence is about what a module IMPORTS, not what it mentions. Several files
 * deliberately name `scheduled-cleanup` in prose — that is how a future reader learns the
 * rule exists at all — so a naive substring scan would flag exactly the documentation
 * that makes the rule survivable, and the obvious "fix" would be to delete the comments.
 */
function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

/** The module specifiers a file actually imports (`import "x"` and `... from "x"`). */
function importSpecifiers(source: string): string[] {
  const out: string[] = [];
  const re = /(?:^|\s)(?:import|export)[\s\S]*?["']([^"']+)["']|(?:^|\s)require\(\s*["']([^"']+)["']/gm;
  for (const m of code(source).matchAll(re)) {
    const spec = m[1] ?? m[2];
    if (spec) out.push(spec);
  }
  return out;
}

const importsCleanupSchedule = (source: string): boolean =>
  importSpecifiers(source).some((s) => s.includes("scheduled-cleanup"));

describe("D42.1 — the scheduled cleanup cannot reach an e2e lane", () => {
  it("U-FENCE1: runtime.ts does NOT import scheduled-cleanup", () => {
    const runtime = read("dbos/runtime.ts");
    // `launchDbos` is what all fifteen lanes call. If this file ever reaches
    // scheduled-cleanup — directly or via a re-export — every lane arms a daily
    // destructive workflow against the shared bucket and the shared app DB.
    expect(importsCleanupSchedule(runtime)).toBe(false);
    expect(code(runtime)).not.toContain("registerScheduled");
  });

  it("U-FENCE2: main.ts DOES import scheduled-cleanup, and before launchDbos", () => {
    const main = read("main.ts");
    const importAt = main.indexOf('"./dbos/scheduled-cleanup"');
    expect(importAt).toBeGreaterThan(-1);
    // Registration is a module-load side effect, so it must be imported before the
    // runtime launches — DBOS.launch() reads the static graph as it finds it.
    expect(importAt).toBeLessThan(main.indexOf("launchDbos("));
  });

  it("U-FENCE3: runtime.ts DOES import the workflow module, so lanes can still invoke it directly", () => {
    // The workflow itself must be registered everywhere — the fence is on the SCHEDULE,
    // not on the workflow. Without this the e2e could not run it at all.
    expect(read("dbos/runtime.ts")).toContain('"../workflows/cleanup-orphaned-assets"');
  });

  it("U-FENCE4: registerScheduled is CALLED in exactly ONE source file in the repo", () => {
    const hits = sourceFiles()
      .filter((f) => code(readFileSync(f, "utf8")).includes("registerScheduled"))
      .map((f) => f.slice(SRC.length + 1));
    expect(hits).toEqual(["dbos/scheduled-cleanup.ts"]);
  });

  it("U-FENCE5: scheduled-cleanup.ts is imported by main.ts and by nothing else", () => {
    const importers = sourceFiles()
      .filter((f) => importsCleanupSchedule(readFileSync(f, "utf8")))
      .map((f) => f.slice(SRC.length + 1))
      .filter((f) => f !== "dbos/scheduled-cleanup.ts");
    expect(importers).toEqual(["main.ts"]);
  });
});
