import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { loadEnv } from "../config/env";
import { TEST_SECRETS_ENCRYPTION_KEY } from "./secrets-fixture";

/**
 * Plan row 43 / D43.1 — the STRUCTURAL half of "the all-zeros key is gone".
 *
 * `loadEnv` now rejects the all-zeros key, and every spec in this repo used it. Migrating
 * them is mechanical; PROVING the migration is not, because a Step-6 run executes only the
 * e2e lanes its change touches — the other lanes would otherwise be trusted to still boot
 * on the say-so of a diff. So the property is asserted structurally here instead of being
 * observed by running eleven lanes (memory `no-long-running-samplers-to-prove-a-precondition`:
 * assert it inline at the point of use, or structurally; never sample to prove a
 * precondition).
 *
 * The scan covers `src/` and `tests/` for both spellings a spec could use: the 64-character
 * literal and the `"0".repeat(64)` expression that produced it everywhere in this repo.
 */

const REPO_ROOT = join(__dirname, "..", "..");
const SCANNED_DIRS = ["src", "tests"];
const ALL_ZEROS_LITERAL = "0".repeat(64);
const ALL_ZEROS_EXPRESSION = /"0"\s*\.\s*repeat\(\s*64\s*\)/;

/**
 * The three files that may name the placeholder, each because naming it is the point:
 * the rejection list, the test that proves the rejection, and this test's own scanner.
 * Anything else mentioning it is a fixture that would fail `loadEnv` at module load.
 */
const ALLOWED = [
  join("src", "config", "env.ts"), // defines WEAK_SECRETS_KEYS
  join("src", "config", "env.test.ts"), // proves the rejection
  join("src", "testing", "secrets-fixture.test.ts"), // this file
];

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      yield* walk(full);
    } else if (entry.endsWith(".ts") || entry.endsWith(".tsx")) {
      yield full;
    }
  }
}

function scannedFiles(): string[] {
  return SCANNED_DIRS.flatMap((d) => [...walk(join(REPO_ROOT, d))]);
}

describe("TEST_SECRETS_ENCRYPTION_KEY", () => {
  it("is a structurally valid 64-hex AES key that loadEnv accepts", () => {
    expect(TEST_SECRETS_ENCRYPTION_KEY).toMatch(/^[0-9a-fA-F]{64}$/);
    const env = loadEnv({
      DATABASE_URL: "postgres://u:p@localhost:5432/supagloo",
      DBOS_DATABASE_URL: "postgres://u:p@localhost:5432/supagloo_dbos",
      SECRETS_ENCRYPTION_KEY: TEST_SECRETS_ENCRYPTION_KEY,
      GITHUB_APP_ID: "123456",
      GITHUB_APP_PRIVATE_KEY: "-----BEGIN RSA PRIVATE KEY-----\nX\n-----END RSA PRIVATE KEY-----",
      S3_ENDPOINT: "http://minio:9000",
      S3_BUCKET: "supagloo-dev",
      S3_ACCESS_KEY: "supagloo",
      S3_SECRET_KEY: "supagloo-dev",
      // Required at boot since 2026-07-30 (`config/env.ts`). This env has to be a COMPLETE
      // one or the case fails on a variable it is not about — the claim here is only that
      // the shared test AES key is one `loadEnv` accepts.
      YOUVERSION_APP_KEY: "yvp-app-key-value",
    });
    expect(env.SECRETS_ENCRYPTION_KEY).toBe(TEST_SECRETS_ENCRYPTION_KEY);
  });

  it("is the ONLY encryption-key fixture: no all-zeros key survives in src/ or tests/", () => {
    const offenders: string[] = [];
    for (const file of scannedFiles()) {
      const rel = relative(REPO_ROOT, file);
      if (ALLOWED.includes(rel)) continue;
      const text = readFileSync(file, "utf8");
      if (text.includes(ALL_ZEROS_LITERAL) || ALL_ZEROS_EXPRESSION.test(text)) {
        offenders.push(rel);
      }
    }
    // Every lane this run does NOT execute is covered by exactly this assertion: a spec
    // still carrying the all-zeros key would fail `loadEnv` at module load, and this is
    // where that is caught.
    expect(offenders).toEqual([]);
  });
});
