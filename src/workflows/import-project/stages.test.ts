import { describe, expect, it, vi } from "vitest";
import {
  IMPORT_STAGES,
  JobStagesSchema,
  type PrismaClient,
} from "@supagloo/database-lib";
import { initialImportStages, markJobFailed } from "./stages";

// Import reuses the generic stage helpers (mergeStage/markStageDone/markJobRunning) from
// the scaffold module; this suite pins the two import-specific pieces: the six-stage
// initial log, and `markJobFailed`, which records the 12b "NOT A SUPAGLOO PROJECT"
// terminal state (status=failed + the offending stage `failed` + the error message).

describe("initialImportStages", () => {
  it("seeds all six import stages pending and round-trips the schema", () => {
    const stages = initialImportStages();
    expect(stages).toHaveLength(IMPORT_STAGES.length);
    expect(stages.every((s) => s.state === "pending")).toBe(true);
    expect(stages.map((s) => s.key)).toEqual(IMPORT_STAGES.map((s) => s.key));
    expect(() => JobStagesSchema.parse(stages)).not.toThrow();
  });
});

describe("markJobFailed", () => {
  it("sets status=failed, marks the failed stage, and records the error", async () => {
    const findUniqueOrThrow = vi
      .fn()
      .mockResolvedValue({ stages: initialImportStages() });
    const update = vi.fn().mockResolvedValue(undefined);
    const prisma = {
      projectJob: { findUniqueOrThrow, update },
    } as unknown as PrismaClient;

    await markJobFailed(
      prisma,
      "job-1",
      "verifySupaglooProject",
      "NOT A SUPAGLOO PROJECT: remotion.config.ts is missing",
    );

    expect(update).toHaveBeenCalledTimes(1);
    const arg = update.mock.calls[0][0];
    expect(arg.where).toEqual({ id: "job-1" });
    expect(arg.data.status).toBe("failed");
    expect(arg.data.error).toContain("NOT A SUPAGLOO PROJECT");
    expect(arg.data.completedAt).toBeInstanceOf(Date);

    const stages = arg.data.stages as Array<{ key: string; state: string }>;
    expect(stages.find((s) => s.key === "verifySupaglooProject")?.state).toBe(
      "failed",
    );
    // Earlier stages are untouched by the failure write.
    expect(stages.find((s) => s.key === "mintInstallationToken")?.state).toBe(
      "pending",
    );
  });
});
