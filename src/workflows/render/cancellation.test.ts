import { afterEach, describe, expect, it, vi } from "vitest";
import { isCancelledStatus, watchForCancellation } from "./cancellation";

/**
 * Task #36 — COOPERATIVE cancellation (plan D4).
 *
 * The `dbos-typescript` skill's `workflow-control` rule is explicit: cancellation
 * "preempts execution at the beginning of the NEXT step — the current step completes
 * first". `renderMedia` is a single step that can run for many minutes, so relying on
 * DBOS preemption alone would leave a cancelled render burning CPU to completion — the
 * "orphan" the plan's e2e forbids.
 *
 * So the render step polls the workflow's own DBOS status and, on CANCELLED, fires
 * Remotion's `makeCancelSignal()` cancel. This suite pins the polling contract with
 * fake timers and an injected status reader — no DBOS, no Chromium.
 */

afterEach(() => {
  vi.useRealTimers();
});

describe("isCancelledStatus", () => {
  it("treats CANCELLED as cancelled", () => {
    expect(isCancelledStatus("CANCELLED")).toBe(true);
  });

  it("does not treat a running, enqueued, or finished workflow as cancelled", () => {
    for (const s of ["PENDING", "ENQUEUED", "SUCCESS", "ERROR", undefined, null]) {
      expect(isCancelledStatus(s)).toBe(false);
    }
  });

  it("treats MAX_RECOVERY_ATTEMPTS_EXCEEDED as NOT a cancellation (it is a failure)", () => {
    expect(isCancelledStatus("MAX_RECOVERY_ATTEMPTS_EXCEEDED")).toBe(false);
  });
});

describe("watchForCancellation", () => {
  it("fires onCancel once the workflow status flips to CANCELLED", async () => {
    vi.useFakeTimers();
    let status = "PENDING";
    const onCancel = vi.fn();
    const watch = watchForCancellation({
      workflowId: "rj-1",
      intervalMs: 100,
      onCancel,
      getStatus: async () => ({ status }),
    });

    await vi.advanceTimersByTimeAsync(250);
    expect(onCancel).not.toHaveBeenCalled();

    status = "CANCELLED";
    await vi.advanceTimersByTimeAsync(150);
    expect(onCancel).toHaveBeenCalledTimes(1);

    // Latched: it never double-fires even if polling continues.
    await vi.advanceTimersByTimeAsync(500);
    expect(onCancel).toHaveBeenCalledTimes(1);
    watch.stop();
  });

  it("stops polling once stopped (no work after the step finishes)", async () => {
    vi.useFakeTimers();
    const getStatus = vi.fn(async () => ({ status: "PENDING" }));
    const watch = watchForCancellation({
      workflowId: "rj-1",
      intervalMs: 100,
      onCancel: vi.fn(),
      getStatus,
    });
    await vi.advanceTimersByTimeAsync(250);
    const callsBefore = getStatus.mock.calls.length;
    expect(callsBefore).toBeGreaterThan(0);

    watch.stop();
    await vi.advanceTimersByTimeAsync(1000);
    expect(getStatus.mock.calls.length).toBe(callsBefore);
  });

  it("survives a transient status-read failure rather than killing the render", async () => {
    vi.useFakeTimers();
    let calls = 0;
    const onCancel = vi.fn();
    const watch = watchForCancellation({
      workflowId: "rj-1",
      intervalMs: 100,
      onCancel,
      getStatus: async () => {
        calls += 1;
        if (calls <= 2) throw new Error("system db blip");
        return { status: "CANCELLED" };
      },
    });

    await vi.advanceTimersByTimeAsync(500);
    expect(onCancel).toHaveBeenCalledTimes(1);
    watch.stop();
  });

  it("does not poll before the first interval elapses", async () => {
    vi.useFakeTimers();
    const getStatus = vi.fn(async () => ({ status: "PENDING" }));
    const watch = watchForCancellation({
      workflowId: "rj-1",
      intervalMs: 1000,
      onCancel: vi.fn(),
      getStatus,
    });
    await vi.advanceTimersByTimeAsync(500);
    expect(getStatus).not.toHaveBeenCalled();
    watch.stop();
  });
});
