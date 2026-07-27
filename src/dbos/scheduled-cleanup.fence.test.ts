import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";

/**
 * Plan row 42 / **D42.1** — THE fence. The single most dangerous property in this run.
 *
 * `cleanupOrphanedAssetsWorkflow` deletes objects out of the ONE shared `supagloo-dev`
 * MinIO bucket and rows out of the shared app database. Fifteen e2e lanes launch the REAL
 * DBOS runtime IN-PROCESS against that same bucket and that same app DB — only the DBOS
 * *system* schema is per-lane. So a schedule armed at module load from `runtime.ts` would
 * fire inside every one of them, against the fixtures another spec is mid-assertion on,
 * including the `Session` rows the api's own test-seed endpoint mints.
 *
 * The chosen guard is STRUCTURAL, not configurational (D42.1 shape (ii), chosen over an env
 * flag consulted at registration):
 *
 *   • the WORKFLOW registers at module load from `runtime.ts`, exactly like every other
 *     workflow, so its name is in the frozen registry and a test can invoke it directly;
 *   • the SCHEDULE lives in `scheduled-cleanup.ts`, which ONLY `main.ts` imports. The lanes
 *     call `launchDbos()` from `runtime.ts` and never load `main.ts`, so the schedule is
 *     inert in lanes by construction — no flag to set, no hook to remember, nothing a
 *     future spec can accidentally turn on.
 *
 * This test is the fence around that. It is a SOURCE-level assertion, modelled on
 * `dockerfile-database-lib-pin.test.ts`, deliberately: the alternative — boot a runtime and
 * watch for a schedule that should not fire — is exactly the banned "sample for minutes to
 * prove a precondition" pattern. A property that holds by construction is asserted by
 * reading the construction.
 *
 * ── Step-11 item 6 (RX-2 + R42-1): TWO holes, both measured, both closed here ────────────
 *
 * (a) **The fence was keyed to ONE LITERAL, `registerScheduled`.** `DBOS.createSchedule`,
 *     `DBOS.applySchedules` and `@DBOS.scheduled` arm the identical receiver, all three
 *     exist in the pinned `@dbos-inc/dbos-sdk@4.23.6`, and `scheduled-cleanup.ts`'s own
 *     docblock recommends migrating to `applySchedules` as the follow-up. A reviewer armed
 *     a nightly destructive sweep from `runtime.ts` with `DBOS.createSchedule` and all five
 *     fence tests stayed GREEN — i.e. the guard evaporated on exactly the change the plan
 *     tells the next author to make. The assertions below therefore match a scheduling-API
 *     **vocabulary**, not a name.
 *
 * (b) **The scan skipped `tests/`.** `sourceFiles()` walked `src/` and excluded
 *     `*.test.ts`, so `tests/e2e/**` — the fifteen in-process lanes, the ONLY place that
 *     can actually breach the fence — was never read. `import "../../src/main";` in a lane
 *     spec arms the schedule for that lane and was invisible. The walk now covers `src/`
 *     and `tests/`, test files included.
 *
 * ⚠ **This spec must exclude ITSELF** (see {@link SELF}). It necessarily contains every
 * word in the vocabulary — that is what makes it a fence — so a self-inclusive scan reports
 * this file as a scheduling site and the "exactly one file" assertions fail for a reason
 * that has nothing to do with the property. The exclusion is by exact path, never by a
 * `*.test.ts` pattern: excluding test files by pattern is hole (b).
 */

const ROOT = process.cwd();
const SRC = resolve(ROOT, "src");
const TESTS = resolve(ROOT, "tests");

/**
 * This spec's own repo-relative path. Excluded from every scan below, by EXACT PATH and
 * nothing broader, because it is the one file that must name the whole vocabulary.
 */
const SELF = "src/dbos/scheduled-cleanup.fence.test.ts";

/** The one file allowed to arm a schedule. */
const SCHEDULE_SITE = "src/dbos/scheduled-cleanup.ts";

/** The process entry point — the one file allowed to import {@link SCHEDULE_SITE}. */
const ENTRY_POINT = "src/main.ts";

/**
 * Every DBOS API that can arm a schedule on the pinned SDK, plus the two runtime-control
 * verbs that imply one has been armed.
 *
 * A vocabulary rather than a literal because the receiver is what matters, not the spelling:
 * `registerScheduled` (used today), `createSchedule` / `applySchedules` (the persistent
 * replacements, and the plan's own recommended migration), `@DBOS.scheduled` (the decorator
 * form), `SchedulerMode` (the enum no non-scheduling file has any reason to import), and
 * `triggerSchedule` / `backfillSchedule` (firing an existing schedule on demand — same
 * destructive effect, no registration needed). Adding a member is cheap; the cost of a
 * missing one is a nightly destructive sweep inside fifteen test lanes.
 */
const SCHEDULING_VOCABULARY = [
  "registerScheduled",
  "createSchedule",
  "applySchedules",
  "DBOS.scheduled",
  "SchedulerMode",
  "triggerSchedule",
  "backfillSchedule",
] as const;

const read = (rel: string): string => readFileSync(resolve(ROOT, rel), "utf8");

const rel = (abs: string): string => relative(ROOT, abs).split("\\").join("/");

/**
 * Every `.ts` file under `src/` **and** `tests/`, tests INCLUDED (hole (b)), minus this
 * spec ({@link SELF}).
 */
function scannedFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.endsWith(".ts") && !entry.endsWith(".tsx")) continue;
      if (rel(full) === SELF) continue;
      out.push(full);
    }
  };
  walk(SRC);
  walk(TESTS);
  return out;
}

/**
 * Source with comments removed.
 *
 * The fence is about what a module DOES, not what it mentions. Several files deliberately
 * name `scheduled-cleanup` and discuss `applySchedules` in prose — that is how a future
 * reader learns the rule exists at all — so a naive substring scan would flag exactly the
 * documentation that makes the rule survivable, and the obvious "fix" would be to delete
 * the comments.
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

/** Does this file import the process entry point (and therefore arm the schedule)? */
const importsEntryPoint = (source: string): boolean =>
  importSpecifiers(source).some((s) => {
    // Basename equality, not `endsWith("main")`: `./child-main` is the Remotion render
    // child and has nothing to do with the worker entry point.
    const stem = basename(s).replace(/\.(ts|tsx|js|mjs|cjs)$/, "");
    return stem === "main" && (s.startsWith(".") || s.startsWith("/"));
  });

/** Which vocabulary words a file actually uses, comments stripped. */
const schedulingWordsIn = (source: string): string[] => {
  const stripped = code(source);
  return SCHEDULING_VOCABULARY.filter((w) => stripped.includes(w));
};

describe("D42.1 — the scheduled cleanup cannot reach an e2e lane", () => {
  it("U-FENCE1: runtime.ts arms NO schedule, by any scheduling API", () => {
    const runtime = read("src/dbos/runtime.ts");
    // `launchDbos` is what all fifteen lanes call. If this file ever arms a schedule —
    // directly, via a re-export, or via any of the four equivalent SDK entry points — every
    // lane arms a daily destructive workflow against the shared bucket and the shared app
    // DB. Keyed to the vocabulary, so the plan's own recommended `applySchedules` migration
    // cannot silently relocate the schedule here (Step-11 item 6a).
    expect(importsCleanupSchedule(runtime)).toBe(false);
    expect(schedulingWordsIn(runtime)).toEqual([]);
  });

  it("U-FENCE2: main.ts DOES import scheduled-cleanup, and before launchDbos", () => {
    const main = read(ENTRY_POINT);
    const importAt = main.indexOf('"./dbos/scheduled-cleanup"');
    expect(importAt).toBeGreaterThan(-1);
    // Registration is a module-load side effect, so it must be imported before the
    // runtime launches — DBOS.launch() reads the static graph as it finds it.
    expect(importAt).toBeLessThan(main.indexOf("launchDbos("));
  });

  it("U-FENCE3: runtime.ts DOES import the workflow module, so lanes can still invoke it directly", () => {
    // The workflow itself must be registered everywhere — the fence is on the SCHEDULE,
    // not on the workflow. Without this the e2e could not run it at all.
    expect(read("src/dbos/runtime.ts")).toContain('"../workflows/cleanup-orphaned-assets"');
  });

  it("U-FENCE4: the scheduling vocabulary appears in exactly ONE file, across src AND tests", () => {
    const hits = scannedFiles()
      .filter((f) => schedulingWordsIn(readFileSync(f, "utf8")).length > 0)
      .map(rel)
      .sort();
    expect(hits).toEqual([SCHEDULE_SITE]);
  });

  it("U-FENCE5: scheduled-cleanup.ts is imported by main.ts and by nothing else", () => {
    const importers = scannedFiles()
      .filter((f) => importsCleanupSchedule(readFileSync(f, "utf8")))
      .map(rel)
      .filter((f) => f !== SCHEDULE_SITE)
      .sort();
    expect(importers).toEqual([ENTRY_POINT]);
  });

  it("U-FENCE6: NOTHING imports the process entry point — main.ts is only ever executed", () => {
    // The cheapest possible breach, and the one the old `src/`-only walk could not see: a
    // lane spec that does `import "../../src/main";` (to reuse its env wiring, say) arms
    // the nightly destructive schedule inside that lane's in-process runtime. `main.ts` is
    // reached by `node dist/main.js` and by nothing else, ever.
    const importers = scannedFiles()
      .filter((f) => importsEntryPoint(readFileSync(f, "utf8")))
      .map(rel)
      .sort();
    expect(importers).toEqual([]);
  });
});
