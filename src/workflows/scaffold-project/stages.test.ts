import { describe, it, expect, vi } from "vitest";
import type { PrismaClient } from "@supagloo/database-lib";
import {
  SCAFFOLD_STAGES,
  initialStages,
  mergeStage,
  markJobFailed,
  markJobRunning,
  JobStagesSchema,
  type JobStage,
} from "./stages";

// The ProjectJob.stages column is an untyped Prisma `Json` array of
// { key, label, state }. Each workflow step updates its OWN entry BY KEY (an
// upsert-in-place, never an append), so a replayed step re-writing `done` after a
// crash is a no-op relative to the already-recorded state. This suite pins that
// the fold is pure, order-stable, and idempotent (the property replays rely on).

describe("SCAFFOLD_STAGES catalogue", () => {
  it("lists the eight workflow steps row-for-row, in order", () => {
    expect(SCAFFOLD_STAGES.map((s) => s.key)).toEqual([
      "mintInstallationToken",
      "ensureRepoAccessible",
      "cloneToWorkspace",
      "writeRemotionScaffold",
      "commitBaseVersion",
      "pushOpenMergeBasePr",
      "cutWorkingBranch",
      "finalizeRecords",
    ]);
    // Every stage has a human-readable label.
    for (const stage of SCAFFOLD_STAGES) {
      expect(stage.label.length).toBeGreaterThan(0);
    }
  });

  it("seeds all stages pending", () => {
    const stages = initialStages();
    expect(stages).toHaveLength(SCAFFOLD_STAGES.length);
    expect(stages.every((s) => s.state === "pending")).toBe(true);
    // Round-trips through the schema (this is what the Json column stores).
    expect(() => JobStagesSchema.parse(stages)).not.toThrow();
  });
});

describe("mergeStage", () => {
  const base: JobStage[] = initialStages();

  it("sets exactly the target key's state and preserves order + other keys", () => {
    const next = mergeStage(base, "commitBaseVersion", "done");
    expect(next.map((s) => s.key)).toEqual(base.map((s) => s.key));
    expect(next.find((s) => s.key === "commitBaseVersion")?.state).toBe("done");
    // Every other stage untouched.
    for (const stage of next) {
      if (stage.key !== "commitBaseVersion") expect(stage.state).toBe("pending");
    }
  });

  it("does not mutate the input array", () => {
    const snapshot = JSON.parse(JSON.stringify(base));
    mergeStage(base, "commitBaseVersion", "done");
    expect(base).toEqual(snapshot);
  });

  it("is idempotent — applying the same update twice equals applying it once", () => {
    const once = mergeStage(base, "pushOpenMergeBasePr", "done");
    const twice = mergeStage(once, "pushOpenMergeBasePr", "done");
    expect(twice).toEqual(once);
  });

  it("is a no-op for an unknown key (never appends)", () => {
    const next = mergeStage(base, "notARealStage", "done");
    expect(next).toEqual(base);
  });
});

describe("markJobRunning", () => {
  it("flips the job's top-level status to running (status only)", async () => {
    const update = vi.fn().mockResolvedValue(undefined);
    const prisma = { projectJob: { update } } as unknown as PrismaClient;

    await markJobRunning(prisma, "job-1");

    expect(update).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledWith({
      where: { id: "job-1" },
      data: { status: "running" },
    });
  });
});

// --------------------------------------------------------------------- plan row 63
// Until now `scaffoldProjectFn` had NO try/catch and no `markJobFailed`, so a permanent
// failure (row 63's own `422 field:base code:invalid`) left `ProjectJob.status` at
// `"running"` with `pushOpenMergeBasePr: pending` FOREVER while DBOS reported ERROR —
// the user-visible face of the defect is an eternal wizard spinner instead of a
// failure. Import already had this (`import-project/stages.ts:35`); scaffold did not.
describe("markJobFailed", () => {
  it("flips status to failed, marks the offending stage failed in place, stamps completedAt and writes the error", async () => {
    const findUniqueOrThrow = vi.fn().mockResolvedValue({ stages: initialStages() });
    const update = vi.fn().mockResolvedValue(undefined);
    const prisma = {
      projectJob: { findUniqueOrThrow, update },
    } as unknown as PrismaClient;

    await markJobFailed(
      prisma,
      "job-1",
      "pushOpenMergeBasePr",
      "open pull request failed: 422 — base is invalid",
    );

    expect(update).toHaveBeenCalledTimes(1);
    const arg = update.mock.calls[0][0];
    expect(arg.where).toEqual({ id: "job-1" });
    expect(arg.data.status).toBe("failed");
    expect(arg.data.error).toContain("422");
    expect(arg.data.completedAt).toBeInstanceOf(Date);

    const stages = arg.data.stages as Array<{ key: string; state: string }>;
    // Upsert IN PLACE — the order and every other stage survive untouched.
    expect(stages.map((s) => s.key)).toEqual(SCAFFOLD_STAGES.map((s) => s.key));
    expect(stages.find((s) => s.key === "pushOpenMergeBasePr")?.state).toBe("failed");
    expect(stages.find((s) => s.key === "mintInstallationToken")?.state).toBe("pending");
  });

  // Review finding DR4. The scaffold catch now records EVERY error that escapes the
  // workflow body, not just the three typed permanent ones — which opens exactly one new
  // window: `finalizeRecords` writes `status = "succeeded"` and only THEN calls
  // `removeWorkspace`, so a throw from that `rm` would reach the catch with the job
  // already legitimately succeeded. Refusing to clobber a terminal success closes it here,
  // once, for every caller (import re-exports this function).
  it("refuses to clobber a job that already succeeded", async () => {
    const findUniqueOrThrow = vi
      .fn()
      .mockResolvedValue({ stages: initialStages(), status: "succeeded" });
    const update = vi.fn().mockResolvedValue(undefined);
    const prisma = {
      projectJob: { findUniqueOrThrow, update },
    } as unknown as PrismaClient;

    await markJobFailed(prisma, "job-1", "finalizeRecords", "EBUSY: rm workspace");

    expect(update).not.toHaveBeenCalled();
  });
});
