import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@supagloo/database-lib";
import {
  TERMINAL_RENDER_STATUSES,
  markRenderCanceled,
  markRenderCompleted,
  markRenderFailed,
  markRenderStarted,
  recordFrameProgress,
  setRenderFramesTotal,
  setRenderStatus,
} from "./status";

/**
 * Task #36 — the `RenderJob` row writers.
 *
 * Two properties are load-bearing and are what this suite exists to pin:
 *
 *  1. PROGRESS MONOTONICITY UNDER REPLAY (plan row 36). `@remotion/renderer`'s
 *     `onProgress` reports `renderedFrames` starting from 0 on EVERY execution. A
 *     retried step or a DBOS recovery-replay therefore re-reports low numbers. The
 *     write must be a GUARDED `updateMany({ where: { id, framesDone: { lt: n } } })`,
 *     never an unconditional `update` — the guard is what makes `framesDone` a
 *     high-water mark rather than a value that visibly rewinds in the 14c overlay.
 *
 *  2. CANCEL STATE MAPPING (plan row 36). Once DBOS has marked the workflow CANCELLED,
 *     no further `DBOS.runStep` can execute — so the `canceled` write is a direct,
 *     non-checkpointed Prisma write from the workflow body. It must therefore be
 *     idempotent AND unable to clobber an already-terminal row (a cancel that races a
 *     completion must lose).
 */

interface FakeRow {
  framesDone: number;
  status: string;
}

function makeFakePrisma(initial: Partial<FakeRow> = {}) {
  const row: FakeRow = { framesDone: 0, status: "queued", ...initial };
  const update = vi.fn(async (args: { data: Record<string, unknown> }) => {
    Object.assign(row, args.data);
    return row;
  });
  const updateMany = vi.fn(
    async (args: {
      where: Record<string, unknown>;
      data: Record<string, unknown>;
    }) => {
      const frames = args.where.framesDone as { lt?: number } | undefined;
      if (frames?.lt !== undefined && !(row.framesDone < frames.lt)) {
        return { count: 0 };
      }
      const status = args.where.status as { notIn?: string[] } | undefined;
      if (status?.notIn && status.notIn.includes(row.status)) {
        return { count: 0 };
      }
      Object.assign(row, args.data);
      return { count: 1 };
    },
  );
  const prisma = { renderJob: { update, updateMany } } as unknown as PrismaClient;
  return { prisma, row, update, updateMany };
}

describe("recordFrameProgress — monotonic by construction", () => {
  it("issues a GUARDED updateMany (framesDone lt n), never an unconditional update", async () => {
    const { prisma, update, updateMany } = makeFakePrisma();
    await recordFrameProgress(prisma, "rj-1", 42);

    expect(update).not.toHaveBeenCalled();
    expect(updateMany).toHaveBeenCalledTimes(1);
    const call = updateMany.mock.calls[0][0];
    expect(call.where).toEqual({ id: "rj-1", framesDone: { lt: 42 } });
    expect(call.data).toEqual({ framesDone: 42 });
  });

  it("never lets framesDone go backwards across a replayed rewind (5, 9, 3, 12 -> 12)", async () => {
    const { prisma, row } = makeFakePrisma();
    for (const n of [5, 9, 3, 12]) {
      await recordFrameProgress(prisma, "rj-1", n);
    }
    expect(row.framesDone).toBe(12);
  });

  it("keeps the high-water mark when a whole replay restarts from frame 0", async () => {
    const { prisma, row } = makeFakePrisma();
    for (const n of [3, 7, 11]) await recordFrameProgress(prisma, "rj-1", n);
    // crash -> replay: the renderMedia step re-executes from scratch
    for (const n of [0, 1, 2, 3]) await recordFrameProgress(prisma, "rj-1", n);
    expect(row.framesDone).toBe(11);
  });

  it("ignores a non-positive/NaN frame count rather than writing garbage", async () => {
    const { prisma, updateMany } = makeFakePrisma();
    await recordFrameProgress(prisma, "rj-1", -1);
    await recordFrameProgress(prisma, "rj-1", Number.NaN);
    expect(updateMany).not.toHaveBeenCalled();
  });
});

describe("status writers", () => {
  it("markRenderStarted sets startedAt without leaving the design's queued phase", async () => {
    const { prisma, update } = makeFakePrisma();
    await markRenderStarted(prisma, "rj-1");
    const data = update.mock.calls[0][0].data as Record<string, unknown>;
    expect(data.startedAt).toBeInstanceOf(Date);
    // §6c: the row stays `queued` through clone/install/asset-download; the first
    // status transition is `synthesizing`.
    expect(data.status).toBeUndefined();
  });

  it("setRenderStatus writes each phase of the design's runtime sequence", async () => {
    for (const status of ["synthesizing", "bundling", "encoding", "uploading"] as const) {
      const { prisma, update } = makeFakePrisma();
      await setRenderStatus(prisma, "rj-1", status);
      expect(update.mock.calls[0][0].data).toMatchObject({ status });
    }
  });

  it("setRenderFramesTotal records the resolved composition length", async () => {
    const { prisma, update } = makeFakePrisma();
    await setRenderFramesTotal(prisma, "rj-1", 300);
    expect(update.mock.calls[0][0].data).toMatchObject({ framesTotal: 300 });
  });

  it("markRenderCompleted writes both asset keys, completedAt, and squares framesDone up to framesTotal", async () => {
    const { prisma, update } = makeFakePrisma();
    await markRenderCompleted(prisma, "rj-1", {
      outputAssetKey: "renders/rj-1/output.mp4",
      thumbnailAssetKey: "renders/rj-1/thumb.jpg",
      framesTotal: 300,
    });
    const data = update.mock.calls[0][0].data as Record<string, unknown>;
    expect(data.status).toBe("completed");
    expect(data.outputAssetKey).toBe("renders/rj-1/output.mp4");
    expect(data.thumbnailAssetKey).toBe("renders/rj-1/thumb.jpg");
    expect(data.framesDone).toBe(300);
    expect(data.framesTotal).toBe(300);
    expect(data.completedAt).toBeInstanceOf(Date);
    expect(data.error).toBeNull();
  });

  it("markRenderFailed records the terminal error", async () => {
    const { prisma, update } = makeFakePrisma();
    await markRenderFailed(prisma, "rj-1", "chromium died");
    const data = update.mock.calls[0][0].data as Record<string, unknown>;
    expect(data.status).toBe("failed");
    expect(data.error).toBe("chromium died");
    expect(data.completedAt).toBeInstanceOf(Date);
  });
});

describe("markRenderCanceled — cancel state mapping", () => {
  it("flips a non-terminal row to canceled", async () => {
    const { prisma, row } = makeFakePrisma({ status: "encoding" });
    await markRenderCanceled(prisma, "rj-1");
    expect(row.status).toBe("canceled");
  });

  it("uses a CONDITIONAL write so it can never clobber an already-terminal row", async () => {
    const { prisma, updateMany } = makeFakePrisma({ status: "encoding" });
    await markRenderCanceled(prisma, "rj-1");
    const where = updateMany.mock.calls[0][0].where as Record<string, unknown>;
    expect(where.id).toBe("rj-1");
    expect(where.status).toEqual({ notIn: [...TERMINAL_RENDER_STATUSES] });
  });

  it("loses the race against a completed row (a cancel arriving after success is a no-op)", async () => {
    const { prisma, row } = makeFakePrisma({ status: "completed" });
    await markRenderCanceled(prisma, "rj-1");
    expect(row.status).toBe("completed");
  });

  it("is idempotent — a second cancel leaves the row canceled", async () => {
    const { prisma, row } = makeFakePrisma({ status: "bundling" });
    await markRenderCanceled(prisma, "rj-1");
    await markRenderCanceled(prisma, "rj-1");
    expect(row.status).toBe("canceled");
  });

  it("pins the terminal status set (no orphan status is reachable after cancel)", () => {
    expect([...TERMINAL_RENDER_STATUSES].sort()).toEqual([
      "canceled",
      "completed",
      "failed",
    ]);
  });
});
