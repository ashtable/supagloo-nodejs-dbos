import { describe, it, expect } from "vitest";
import {
  GeneratedScriptSchema,
  GeneratedStoryboardSchema,
} from "@supagloo/database-lib";
import { selectResultSchema } from "./schema-selection";
import { UnsupportedGenerationKindError } from "./errors";

// Task #30: the workflow handles BOTH text kinds, selecting the target Zod schema by the
// AiGeneration row's `kind` (design-delta §7 workflow 5). Media kinds are NOT this
// workflow's concern (#32–34) and must be rejected loudly rather than silently mishandled.

describe("selectResultSchema", () => {
  it("selects GeneratedStoryboardSchema for the storyboard kind", () => {
    expect(selectResultSchema("storyboard")).toBe(GeneratedStoryboardSchema);
  });

  it("selects GeneratedScriptSchema for the script kind", () => {
    expect(selectResultSchema("script")).toBe(GeneratedScriptSchema);
  });

  it("throws UnsupportedGenerationKindError for a non-text kind", () => {
    for (const kind of ["image", "narration", "music", "video"] as const) {
      expect(() => selectResultSchema(kind)).toThrow(UnsupportedGenerationKindError);
    }
  });
});
