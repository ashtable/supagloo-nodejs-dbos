import { describe, expect, it } from "vitest";
import {
  COMMIT_STAGES,
  JobStagesSchema,
} from "@supagloo/database-lib";
import { initialCommitStages } from "./stages";

// Commit reuses the generic stage helpers (markStageDone/markJobRunning) from the scaffold
// module; the only commit-specific piece is the five-stage initial log the e2e seeds.

describe("initialCommitStages", () => {
  it("seeds all five commit stages pending and round-trips the schema", () => {
    const stages = initialCommitStages();
    expect(stages).toHaveLength(COMMIT_STAGES.length);
    expect(stages.every((s) => s.state === "pending")).toBe(true);
    expect(stages.map((s) => s.key)).toEqual(COMMIT_STAGES.map((s) => s.key));
    expect(() => JobStagesSchema.parse(stages)).not.toThrow();
  });
});
