import { describe, it, expect } from "vitest";
import { parseVideoRequest, type VideoRequestRow } from "./request";
import { GenerationRequestInvalidError } from "./errors";

// Pure validator for the video-generation request row (design-delta §7 workflow 8). A video
// generation MUST be video-kind, MUST be openrouter (defense-in-depth on the 422 matrix), MUST
// be project-scoped (§8 defines no project-less asset S3 layout), and its `input` MUST parse
// against db-lib's GenerateVideoInputSchema (requires a prompt). Any violation is a PERMANENT
// GenerationRequestInvalidError (the workflow marks the row failed, no retry). No DB / no DBOS.
//
// NOTE (in-flight db-lib window): this suite imports the NEW GenerateVideoInputSchema via
// request.ts, so it stays RED until db-lib is released + the dbos submodule is bumped.

function row(overrides: Partial<VideoRequestRow> = {}): VideoRequestRow {
  return {
    userId: "u1",
    kind: "video",
    provider: "openrouter",
    model: "resolved/video-model",
    projectId: "proj-1",
    input: { prompt: "a dove descends over still water" },
    ...overrides,
  };
}

describe("parseVideoRequest", () => {
  it("parses a valid video row into a typed video request", () => {
    const req = parseVideoRequest(row());
    expect(req).toMatchObject({
      kind: "video",
      userId: "u1",
      model: "resolved/video-model",
      projectId: "proj-1",
    });
    expect(req.input.prompt).toBe("a dove descends over still water");
  });

  it("carries optional clip params through (duration/aspect/frameImages/generateAudio/seed)", () => {
    const req = parseVideoRequest(
      row({
        input: {
          prompt: "x",
          durationSeconds: 6,
          aspectRatio: "9:16",
          frameImages: ["projects/p/assets/a"],
          generateAudio: true,
          seed: 7,
        },
      }),
    );
    expect(req.input.durationSeconds).toBe(6);
    expect(req.input.aspectRatio).toBe("9:16");
    expect(req.input.frameImages).toEqual(["projects/p/assets/a"]);
  });

  it("rejects a kind this workflow does not handle (e.g. image)", () => {
    expect(() => parseVideoRequest(row({ kind: "image" }))).toThrow(
      GenerationRequestInvalidError,
    );
  });

  it("rejects a non-openrouter provider (defense-in-depth on the 422 matrix)", () => {
    expect(() => parseVideoRequest(row({ provider: "gloo" }))).toThrow(
      GenerationRequestInvalidError,
    );
  });

  it("rejects a project-less video generation (an asset has nowhere to live)", () => {
    expect(() => parseVideoRequest(row({ projectId: null }))).toThrow(
      GenerationRequestInvalidError,
    );
  });

  it("rejects an input with no prompt", () => {
    expect(() => parseVideoRequest(row({ input: {} }))).toThrow(
      GenerationRequestInvalidError,
    );
    expect(() => parseVideoRequest(row({ input: { prompt: "" } }))).toThrow(
      GenerationRequestInvalidError,
    );
  });

  it("rejects a malformed aspect ratio", () => {
    expect(() =>
      parseVideoRequest(row({ input: { prompt: "x", aspectRatio: "16x9" } })),
    ).toThrow(GenerationRequestInvalidError);
  });
});
