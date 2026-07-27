import { describe, it, expect, beforeAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/**
 * Plan row 44 — the RED PATH. "A deliberate mismatch fails the build", proven by running
 * the REAL executable and reading its REAL exit code.
 *
 * WHY THERE IS NO `.github/workflows` HERE, AND THAT IS THE DESIGN (D44.1). The row's
 * headline says "CI enforcement", but:
 *   • current-design §5.4 item 7 states plainly that **no CI exists in any of the five
 *     repos**, by an explicit §9-Q12 deferral (the secrets-into-CI story is deliberately
 *     not designed);
 *   • design-delta §9-Q11 offers a CI check **or** a postinstall hook — alternatives, not
 *     both — and the postinstall arm is already shipped (`package.json` `"postinstall":
 *     "check-prisma-version"`, pinned by `src/prisma-pin.test.ts`);
 *   • the row's own E2E column asks for a "**CI-sim** run", which is exactly this file.
 * Authoring a workflow file would falsify §5.4 item 7's headline sentence and reopen a
 * deliberately-deferred design question. So "fails the build" already means what it needs
 * to mean: `postinstall` runs on every `npm install`, INCLUDING inside this repo's
 * Dockerfile (whose deps stage comments say "a Prisma pin drift fails the build here").
 * This test proves the exit code that mechanism consumes.
 *
 * TECHNIQUE. The consumer package.json is COPIED to a temp dir and mutated there. The
 * nested `supagloo-database-lib/` checkout is never written to (hard rule: a submodule
 * checkout inside another repo is read-only), and this repo's own `package.json` is never
 * touched — a red-path test that mutated it in place could leave the repo broken on a
 * crash.
 */

const REPO_ROOT = process.cwd();
const CLI = resolve(
  REPO_ROOT,
  "supagloo-database-lib/dist/check-prisma-version.cli.js",
);

interface CliOutcome {
  status: number;
  stdout: string;
  stderr: string;
}

/** Run the real bin against a package.json in `dir`. */
function runCheck(dir: string): CliOutcome {
  try {
    const stdout = execFileSync(process.execPath, [CLI], {
      cwd: dir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { status: 0, stdout, stderr: "" };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return {
      status: e.status ?? -1,
      stdout: e.stdout ?? "",
      stderr: e.stderr ?? "",
    };
  }
}

/** A temp dir holding this repo's package.json, optionally with the pins rewritten. */
function scratchConsumer(
  mutate?: (pkg: Record<string, unknown>) => void,
): string {
  const dir = mkdtempSync(join(tmpdir(), "supagloo-dbos-pin-"));
  const pkg = JSON.parse(
    readFileSync(resolve(REPO_ROOT, "package.json"), "utf8"),
  ) as Record<string, unknown>;
  mutate?.(pkg);
  writeFileSync(join(dir, "package.json"), JSON.stringify(pkg, null, 2));
  return dir;
}

const deps = (pkg: Record<string, unknown>): Record<string, string> =>
  pkg.dependencies as Record<string, string>;

beforeAll(() => {
  // If db-lib was never built, the CLI does not exist and every assertion below would be
  // measuring the wrong failure. Fail with that sentence rather than a bare ENOENT.
  expect(
    () => readFileSync(CLI, "utf8"),
    `${CLI} is missing — run \`npm install\` (or \`npm run build\`) inside supagloo-database-lib`,
  ).not.toThrow();
});

describe("prisma pin — CI-sim against the real check-prisma-version bin", () => {
  it("U-PIN1: the UNMUTATED consumer package.json exits 0", () => {
    const dir = scratchConsumer();
    try {
      const out = runCheck(dir);
      expect(out.status).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("U-PIN2: a drifted `prisma` version exits 1 and names the package", () => {
    const dir = scratchConsumer((pkg) => {
      deps(pkg).prisma = "7.7.0";
    });
    try {
      const out = runCheck(dir);
      // Exit 1 is the whole contract: it is what npm turns into a failed install, and
      // what the Dockerfile's deps stage turns into a failed image build.
      expect(out.status).toBe(1);
      expect(out.stderr).toContain("prisma");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("U-PIN3: a drifted `@prisma/client` version exits 1", () => {
    const dir = scratchConsumer((pkg) => {
      deps(pkg)["@prisma/client"] = "7.7.0";
    });
    try {
      expect(runCheck(dir).status).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("U-PIN4: a RANGE spec exits 1 even when it would resolve to the right version", () => {
    // `^7.8.0` resolves to 7.8.0 today and to 7.9.0 tomorrow. The pin exists because
    // @prisma/client and the generated client must match EXACTLY, so a range is a
    // deferred break, not a lenient equivalent.
    const dir = scratchConsumer((pkg) => {
      deps(pkg).prisma = "^7.8.0";
      deps(pkg)["@prisma/client"] = "~7.8.0";
    });
    try {
      expect(runCheck(dir).status).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("U-PIN5: BOTH packages drifting is still exactly one failing exit code", () => {
    const dir = scratchConsumer((pkg) => {
      deps(pkg).prisma = "6.0.0";
      deps(pkg)["@prisma/client"] = "6.0.0";
    });
    try {
      expect(runCheck(dir).status).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
