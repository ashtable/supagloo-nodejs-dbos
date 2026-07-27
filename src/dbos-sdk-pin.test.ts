import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Step-11 item 17 (RX-3) — `@dbos-inc/dbos-sdk` is pinned EXACTLY, not by caret.
 *
 * The worker owns the `dbos` system schema: it is the process that runs
 * `DBOS.launch()`, and the SDK's own migrations create and shape that schema. A caret
 * therefore makes `npm install` a schema migration with no review step — and the concrete
 * failure has already been measured on this branch: a re-resolved minor produced
 * `column "debounce_deadline_epoch_ms" ... does not exist` on `POST /v1/projects`, i.e. the
 * api enqueueing into a schema the worker had migrated differently. Every unit test in both
 * repos stayed green through it, because nothing asserted the DECLARED spec.
 *
 * Root's `tests/unit/dbos-sdk-pin.test.ts` holds the cross-repo half (all three declared
 * specs exact and equal). This is the in-repo half, and it is the one that runs in the same
 * suite as the `npm install` that would break it: a caret reintroduced here fails the dbos
 * suite immediately, without needing root checked out.
 *
 * Deliberately reads BOTH `package.json` and `package-lock.json`: an exact declared spec that
 * the lockfile disagrees with is the same hazard wearing a disguise.
 */

const SDK = "@dbos-inc/dbos-sdk";

/** The version every repo in the system must agree on. */
const PINNED_SDK_VERSION = "4.23.6";

const read = (rel: string): unknown =>
  JSON.parse(readFileSync(resolve(process.cwd(), rel), "utf8"));

describe("@dbos-inc/dbos-sdk version pin (item 17 / RX-3)", () => {
  const pkg = read("package.json") as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  const lock = read("package-lock.json") as {
    packages: Record<string, { version?: string; dependencies?: Record<string, string> }>;
  };

  it("U-SDK-PIN1: the DECLARED spec is an exact version — no caret, tilde or range", () => {
    const spec = pkg.dependencies?.[SDK];
    expect(spec).toBeDefined();
    // The assertion that was missing everywhere: `^4.23.6` and `4.23.6` are both "4.23.6"
    // to a human skimming a diff, and only one of them survives an `npm install`.
    expect(spec).toBe(PINNED_SDK_VERSION);
    expect(spec).not.toMatch(/[\^~><*x|\s]/);
  });

  it("U-SDK-PIN2: the lockfile agrees, at the root dependency AND the resolved package", () => {
    expect(lock.packages[""]?.dependencies?.[SDK]).toBe(PINNED_SDK_VERSION);
    expect(lock.packages[`node_modules/${SDK}`]?.version).toBe(PINNED_SDK_VERSION);
  });

  it("U-SDK-PIN3: the INSTALLED tree is the pinned version", () => {
    // `node_modules/.../package.json` is not reachable through `require` (the package's
    // `exports` map does not expose it), so it is read as a file.
    const installed = read(`node_modules/${SDK}/package.json`) as { version?: string };
    expect(installed.version).toBe(PINNED_SDK_VERSION);
  });
});
