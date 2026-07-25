import type { PrismaClient, RenderStatus } from "@supagloo/database-lib";

/**
 * The `RenderJob` row writers (design-delta §2.7 / §6c).
 *
 * The runtime status sequence is the design's PROSE order —
 *   `queued → synthesizing → bundling → encoding → uploading → completed|failed|canceled`
 * — not the Prisma enum's declaration order (which lists `bundling` before `synthesizing`
 * for readability). §7 workflow 9 is explicit: "the RenderJob status sequence now reports
 * synthesizing before bundling".
 *
 * `markRenderStarted` deliberately does NOT change the status: per §6c the row stays
 * `queued` through clone/install/asset-download, and `synthesizing` is the first
 * transition. It sets `startedAt` so a poller can still distinguish "queued, not picked
 * up" from "queued, worker is preparing". (Surfacing that distinction in the 14c overlay
 * is task 38's problem.)
 */

/** Statuses past which nothing may write. Used to make the cancel write conditional. */
export const TERMINAL_RENDER_STATUSES = ["completed", "failed", "canceled"] as const;

/** The phases a render passes through while working. */
export type RenderPhase = Extract<
  RenderStatus,
  "synthesizing" | "bundling" | "encoding" | "uploading"
>;

/** Step 0: record that a worker has picked the job up. Status is untouched (see above). */
export async function markRenderStarted(
  prisma: PrismaClient,
  renderJobId: string,
): Promise<void> {
  await prisma.renderJob.update({
    where: { id: renderJobId },
    data: { startedAt: new Date() },
  });
}

/** Advance the row to a working phase. Idempotent under replay (the value is absolute). */
export async function setRenderStatus(
  prisma: PrismaClient,
  renderJobId: string,
  status: RenderPhase,
): Promise<void> {
  await prisma.renderJob.update({
    where: { id: renderJobId },
    data: { status },
  });
}

/** Record the resolved composition length so the UI can compute a real percentage. */
export async function setRenderFramesTotal(
  prisma: PrismaClient,
  renderJobId: string,
  framesTotal: number,
): Promise<void> {
  await prisma.renderJob.update({
    where: { id: renderJobId },
    data: { framesTotal },
  });
}

/**
 * MONOTONIC progress. `@remotion/renderer`'s `onProgress` reports `renderedFrames`
 * starting from 0 on EVERY execution, so a retried step or a DBOS recovery-replay
 * re-reports low numbers. The guarded `updateMany` (`framesDone: { lt: n }`) turns the
 * column into a high-water mark: a rewound report is simply a zero-row update, so the
 * 14c overlay never shows the count going backwards.
 *
 * This is also why progress is NOT reported via `DBOS.setEvent`/`writeStream`: events
 * must be published from the workflow body (not from inside a step's callback), each is a
 * durable system-DB write — thousands per render — and stream writes from steps are
 * at-least-once, so a replay would append a duplicated, rewound series.
 */
export async function recordFrameProgress(
  prisma: PrismaClient,
  renderJobId: string,
  framesDone: number,
): Promise<void> {
  if (!Number.isFinite(framesDone) || framesDone <= 0) return;
  const value = Math.floor(framesDone);
  await prisma.renderJob.updateMany({
    where: { id: renderJobId, framesDone: { lt: value } },
    data: { framesDone: value },
  });
}

export interface RenderCompletion {
  outputAssetKey: string;
  thumbnailAssetKey: string;
  framesTotal: number;
}

/** Terminal success: both asset keys, a squared-up frame count, and `completedAt`. */
export async function markRenderCompleted(
  prisma: PrismaClient,
  renderJobId: string,
  completion: RenderCompletion,
): Promise<void> {
  await prisma.renderJob.update({
    where: { id: renderJobId },
    data: {
      status: "completed",
      outputAssetKey: completion.outputAssetKey,
      thumbnailAssetKey: completion.thumbnailAssetKey,
      // The throttled progress writes may lag the last few frames; square them up so the
      // overlay lands on 100% rather than 97%.
      framesDone: completion.framesTotal,
      framesTotal: completion.framesTotal,
      completedAt: new Date(),
      error: null,
    },
  });
}

/** Terminal failure. */
export async function markRenderFailed(
  prisma: PrismaClient,
  renderJobId: string,
  error: string,
): Promise<void> {
  await prisma.renderJob.update({
    where: { id: renderJobId },
    data: { status: "failed", error, completedAt: new Date() },
  });
}

/**
 * Terminal cancellation.
 *
 * CONDITIONAL by necessity as well as by taste. Once DBOS has marked the workflow
 * CANCELLED, no further `DBOS.runStep` can execute — so unlike `markRenderFailed` this
 * write happens OUTSIDE a step, directly from the workflow body. That puts it outside
 * DBOS's exactly-once guarantee, so it must be idempotent; and because the render API's
 * cancel endpoint (task 37) may write the same value, it must not clobber a row that has
 * already reached a terminal state (a cancel racing a completion must lose).
 */
export async function markRenderCanceled(
  prisma: PrismaClient,
  renderJobId: string,
): Promise<void> {
  await prisma.renderJob.updateMany({
    where: { id: renderJobId, status: { notIn: [...TERMINAL_RENDER_STATUSES] } },
    data: { status: "canceled", completedAt: new Date() },
  });
}
