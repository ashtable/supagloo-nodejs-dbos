import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { WORKER_FAILED_LOG, WORKER_READY_LOG } from "./worker-log";

/**
 * Task 62 / D23: the nextjs render-lane globalSetup gates on the containerised dbos
 * worker having actually booted by SCRAPING this exact line out of
 * `docker compose logs dbos`. A reword here would silently break that gate (the gate
 * would time out with an opaque "worker never became ready" instead of pointing at the
 * rename), so the string is exported as a constant and PINNED here.
 *
 * If you are changing the launch line: change it in ONE place (`worker-log.ts`), update
 * this pin deliberately, and update the nextjs gate in the same change.
 */
describe("WORKER_READY_LOG", () => {
  it("is the exact line the nextjs render-lane log gate scrapes", () => {
    expect(WORKER_READY_LOG).toBe(
      "[supagloo-dbos] worker launched — static queues registered, polling for work",
    );
  });

  it("is a single line with no leading/trailing whitespace (grep-safe)", () => {
    expect(WORKER_READY_LOG).not.toMatch(/[\r\n]/);
    expect(WORKER_READY_LOG.trim()).toBe(WORKER_READY_LOG);
    expect(WORKER_READY_LOG.length).toBeGreaterThan(0);
  });

  it("carries the [supagloo-dbos] prefix that distinguishes it from api log lines", () => {
    expect(WORKER_READY_LOG.startsWith("[supagloo-dbos] ")).toBe(true);
  });
});

/**
 * Plan row 43 added log REDACTION to `main.ts`, and the two constants above are the exact
 * thing redaction must not touch (brief §0.7 / R4): the nextjs render lane greps them out
 * of `docker compose logs --no-color dbos` and treats `WORKER_FAILED_LOG` in the tail as a
 * HARD failure. Wrapping either label — or moving it out of argument 0, where a
 * substring-matching grep over a merged stream still finds it at the start of the line —
 * breaks another repo's lane with a message that blames the wrong thing.
 *
 * Asserted over `main.ts`'s SOURCE rather than by executing it: importing `main.ts` runs
 * the process entry point (it calls `loadEnv()` and `DBOS.launch()` at module scope), which
 * a unit test must not do.
 */
describe("main.ts keeps the scraped constants in argument 0", () => {
  const source = readFileSync(join(__dirname, "..", "main.ts"), "utf8");

  it("logs WORKER_READY_LOG alone, unwrapped", () => {
    expect(source).toContain("console.log(WORKER_READY_LOG);");
  });

  it("logs WORKER_FAILED_LOG first and only REDACTS the payload", () => {
    expect(source).toContain("console.error(WORKER_FAILED_LOG, redactForLog(err));");
    // Neither label may be passed through the redactor itself.
    expect(source).not.toMatch(/redactForLog\(\s*WORKER_/);
    expect(source).not.toMatch(/redactSecretsFromText\(\s*WORKER_/);
  });

  it("routes every console.error payload through the redactor", () => {
    // The shutdown handler is the other one. A future third `console.error(…, err)` that
    // forgets the redactor fails here.
    const rawErrorLogs = source.match(/console\.error\([^)]*\berr\b\s*\)/g) ?? [];
    for (const call of rawErrorLogs) {
      expect(call).toContain("redactForLog(err)");
    }
  });

  it("still exports both constants for the cross-repo gate to match", () => {
    expect(WORKER_READY_LOG).toContain("[supagloo-dbos]");
    expect(WORKER_FAILED_LOG).toBe("[supagloo-dbos] failed to launch:");
  });
});
