import { describe, it, expect } from "vitest";
import {
  appendValidationErrors,
  buildGenerationPrompt,
  type ResolvedPassage,
} from "./prompt";
import type { GenerateScriptInput } from "@supagloo/database-lib";

// Task #30: the prompt builders are pure — the workflow feeds the brief + (optionally) the
// fetched passage into them, and the repair loop appends the Zod validation errors to
// re-prompt. Kept pure so the prompt shape is unit-testable without the LLM/DBOS.

const INPUT: GenerateScriptInput = {
  brief: "Break this passage into a reverent 3-scene vertical video.",
  scripture: { reference: "John 3:16", translation: "KJV", language: "eng" },
};

const PASSAGE: ResolvedPassage = {
  reference: "John 3:16",
  translation: "KJV",
  text: "For God so loved the world, that he gave his only begotten Son.",
};

describe("buildGenerationPrompt", () => {
  it("embeds the brief and the fetched passage (text + reference + translation)", () => {
    const { system, prompt } = buildGenerationPrompt({
      kind: "storyboard",
      input: INPUT,
      passage: PASSAGE,
    });
    expect(system).toBeTruthy();
    expect(prompt).toContain(INPUT.brief);
    expect(prompt).toContain(PASSAGE.text);
    expect(prompt).toContain("John 3:16");
    expect(prompt).toContain("KJV");
  });

  it("uses a different system directive for storyboard vs script kinds", () => {
    const storyboard = buildGenerationPrompt({ kind: "storyboard", input: INPUT, passage: PASSAGE });
    const script = buildGenerationPrompt({ kind: "script", input: INPUT, passage: PASSAGE });
    expect(storyboard.system).not.toBe(script.system);
  });

  it("builds a valid prompt with no passage (topic-origin generation)", () => {
    const { prompt } = buildGenerationPrompt({
      kind: "storyboard",
      input: { brief: "A video about hope." },
      passage: null,
    });
    expect(prompt).toContain("A video about hope.");
  });
});

describe("appendValidationErrors", () => {
  it("appends the Zod validation errors + a corrective instruction, preserving the original prompt", () => {
    const base = buildGenerationPrompt({ kind: "storyboard", input: INPUT, passage: PASSAGE }).prompt;
    const repaired = appendValidationErrors(base, "scenes: Required");
    expect(repaired).toContain(base);
    expect(repaired).toContain("scenes: Required");
    expect(repaired.length).toBeGreaterThan(base.length);
  });
});
