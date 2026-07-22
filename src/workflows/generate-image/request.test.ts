import { describe, it, expect } from "vitest";
import { GenerationRequestInvalidError } from "./errors";
import { parseImageRequest } from "./request";

// Task #32 — the pure request validator the loadRequestAndCredentials step wraps. An
// image generation MUST be project-scoped (design §8 defines no project-less asset S3
// layout) and MUST carry a prompt (the real GenerateImageInputSchema). A row that fails
// any of these is a PERMANENT GenerationRequestInvalidError (row → failed, not retried).

const baseRow = {
  userId: "u1",
  kind: "image" as const,
  provider: "openrouter" as const,
  model: "stub/image-model",
  projectId: "proj-1",
  input: { prompt: "a serene sunrise over hills" },
};

describe("parseImageRequest", () => {
  it("returns the checkpoint-safe request for a valid image row", () => {
    expect(parseImageRequest(baseRow)).toEqual({
      userId: "u1",
      model: "stub/image-model",
      projectId: "proj-1",
      prompt: "a serene sunrise over hills",
    });
  });

  it("tolerates passthrough extras in the input", () => {
    const req = parseImageRequest({
      ...baseRow,
      input: { prompt: "x", size: "1024x1024" },
    });
    expect(req.prompt).toBe("x");
  });

  it("rejects a non-image kind", () => {
    expect(() => parseImageRequest({ ...baseRow, kind: "script" as never })).toThrow(
      GenerationRequestInvalidError,
    );
  });

  it("rejects a non-openrouter provider (defense-in-depth on the workflow's own invariant)", () => {
    expect(() => parseImageRequest({ ...baseRow, provider: "gloo" as never })).toThrow(
      GenerationRequestInvalidError,
    );
  });

  it("rejects a null projectId (an image asset has nowhere to live without a project)", () => {
    expect(() => parseImageRequest({ ...baseRow, projectId: null })).toThrow(
      GenerationRequestInvalidError,
    );
  });

  it("rejects a missing/empty prompt", () => {
    expect(() => parseImageRequest({ ...baseRow, input: {} })).toThrow(
      GenerationRequestInvalidError,
    );
    expect(() => parseImageRequest({ ...baseRow, input: { prompt: "" } })).toThrow(
      GenerationRequestInvalidError,
    );
  });
});
