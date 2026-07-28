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
      provider: "openrouter",
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

  it("U-GI6: ACCEPTS the gloo provider and carries it onto the request", () => {
    // Genesis-1 D1. Gloo really does generate images (11 catalogue models; a real PNG
    // was produced on 2026-07-28) — they just route through `POST /ai/v2/responses`
    // instead of chat/completions. The workflow now implements both paths, so the
    // parser must let both through AND tell the workflow which one to take.
    const req = parseImageRequest({ ...baseRow, provider: "gloo" });
    expect(req.provider).toBe("gloo");
    expect(req.prompt).toBe("a serene sunrise over hills");
  });

  it("U-GI8: still rejects any OTHER provider as a permanent failure", () => {
    // The parser gates on what the WORKFLOW implements, which is a different (and
    // deliberately narrower) statement than the enqueue-time compatibility matrix. It
    // must not silently trust the upstream guard.
    for (const provider of ["anthropic", "", "OPENROUTER", "gloo-ai"]) {
      expect(
        () => parseImageRequest({ ...baseRow, provider: provider as never }),
        provider,
      ).toThrow(GenerationRequestInvalidError);
    }
  });

  it("U-GI7: a VALID faithAlignment on the input becomes the wire `tradition`", () => {
    // It rides in `input` rather than as a new top-level create field because every
    // kind's input schema is already `.passthrough()` — so this needs no change to
    // `CreateAiGenerationRequestSchema` and no api-side release dependency.
    const req = parseImageRequest({
      ...baseRow,
      provider: "gloo",
      input: { prompt: "x", faithAlignment: "catholic" },
    });
    expect(req.tradition).toBe("catholic");
  });

  it("U-GI7b: an INVALID faithAlignment is DROPPED, never forwarded", () => {
    // Gloo answers 200 for a bogus tradition and silently degrades to neutral — there is
    // no 422 to catch it. Dropping is deliberately not throwing: a bad value must not
    // fail a generation, it must fall back to the same neutral result Gloo would have
    // produced anyway. `protestant` and `orthodox` are the two plausible wrong guesses.
    for (const bad of ["protestant", "orthodox", "Catholic", "", null, 7]) {
      const req = parseImageRequest({
        ...baseRow,
        provider: "gloo",
        input: { prompt: "x", faithAlignment: bad },
      });
      expect(req.tradition, JSON.stringify(bad)).toBeUndefined();
    }
  });

  it("U-GI7c: no faithAlignment at all leaves `tradition` absent", () => {
    expect(parseImageRequest(baseRow).tradition).toBeUndefined();
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
