import { describe, expect, it } from "vitest";
import { PUBLISH_STAGES, JobStagesSchema } from "@supagloo/database-lib";
import { initialPublishStages } from "./stages";

// Publish reuses the generic stage helpers (markStageDone/markJobRunning) from the scaffold
// module; the only publish-specific piece is the seven-stage initial log the API/e2e seeds.

describe("initialPublishStages", () => {
  it("seeds all seven publish stages pending and round-trips the schema", () => {
    const stages = initialPublishStages();
    expect(stages).toHaveLength(PUBLISH_STAGES.length);
    expect(stages.every((s) => s.state === "pending")).toBe(true);
    expect(stages.map((s) => s.key)).toEqual(PUBLISH_STAGES.map((s) => s.key));
    expect(() => JobStagesSchema.parse(stages)).not.toThrow();
  });
});
