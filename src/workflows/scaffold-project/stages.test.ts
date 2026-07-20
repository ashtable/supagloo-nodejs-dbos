import { describe, it, expect, vi } from "vitest";
import type { PrismaClient } from "@supagloo/database-lib";
import {
  SCAFFOLD_STAGES,
  initialStages,
  mergeStage,
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
