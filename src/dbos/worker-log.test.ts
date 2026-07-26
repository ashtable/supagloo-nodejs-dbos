import { describe, expect, it } from "vitest";
import { WORKER_READY_LOG } from "./worker-log";

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
