/**
 * COOPERATIVE cancellation for the long render steps.
 *
 * DBOS's own cancellation "preempts execution at the beginning of the NEXT step — the
 * current step completes first". `renderMedia` is a single step that can run for many
 * minutes, so DBOS preemption alone would let a cancelled render burn CPU (and a worker
 * slot on a `workerConcurrency: 1` queue) to completion. That is exactly the orphaned
 * work the design's cancel story is meant to avoid.
 *
 * So the render/still steps poll their OWN workflow status and, on CANCELLED, fire
 * Remotion's `makeCancelSignal()` cancel, which tears the Chromium render down promptly.
 *
 * The status reader is injected so this is unit-testable with fake timers and no DBOS.
 * Read failures are swallowed: a system-DB blip must never kill an otherwise healthy
 * render — the next poll (or DBOS's own step-boundary preemption) will catch it.
 */

export interface CancellationWatch {
  /** Stop polling. Safe to call more than once. */
  stop(): void;
}

export interface WatchForCancellationArgs {
  workflowId: string;
  intervalMs: number;
  /** Invoked at most ONCE, the first time the workflow is observed CANCELLED. */
  onCancel: () => void;
  getStatus: (
    workflowId: string,
  ) => Promise<{ status?: string | null } | null | undefined>;
}

/** True only for DBOS's `CANCELLED` status (a failure/max-recovery state is NOT a cancel). */
export function isCancelledStatus(status?: string | null): boolean {
  return status === "CANCELLED";
}

export function watchForCancellation(
  args: WatchForCancellationArgs,
): CancellationWatch {
  let fired = false;
  let stopped = false;

  const timer = setInterval(() => {
    if (stopped || fired) return;
    void args
      .getStatus(args.workflowId)
      .then((info) => {
        if (stopped || fired) return;
        if (isCancelledStatus(info?.status)) {
          fired = true;
          args.onCancel();
        }
      })
      .catch(() => {
        // Transient system-DB failure — keep polling.
      });
  }, args.intervalMs);

  // Never hold the event loop open just to poll.
  if (typeof timer.unref === "function") timer.unref();

  return {
    stop() {
      stopped = true;
      clearInterval(timer);
    },
  };
}
