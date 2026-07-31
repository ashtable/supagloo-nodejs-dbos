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

// ---------------------------------------------------------------------------
// Feature 1 (secondary bug) — a re-plan must not overwrite the narrator voice
// ---------------------------------------------------------------------------
//
// The storyboard system directive asks the model to PRODUCE a `narratorVoice`
// (`GeneratedStoryboardSchema` requires one), and this builder never told it about the
// voice the project already has. So every "re-plan all scenes" silently replaced a
// descriptor the user had written with whatever the model invented — a destructive edit
// to a field the user owns, triggered by a button about SCENES.
//
// The prompt carries the existing voice when there is one; the machine-readable
// `voiceId` is preserved by the studio on the way back in (an LLM has no business
// inventing a provider voice id).

describe("buildGenerationPrompt — existing narrator voice", () => {
  // The trailing `as GenerateScriptInput` is gone (2026-07-30). Be clear about what that
  // did and did NOT buy, because it is the opposite of the manifest fixtures': the schema
  // is `.passthrough()` and `narratorVoice` is UNDECLARED, so the key type-checks only as
  // `unknown` via the index signature. Nothing here is validated by the type — a misspelt
  // `narratorVoice` still compiles, and U-P1 is what catches it. That is exactly why
  // `existingNarratorVoice`'s runtime guards are load-bearing and stay.
  const withVoice: GenerateScriptInput = {
    ...INPUT,
    narratorVoice: {
      description: "warm, weathered baritone — unhurried, reverent",
      label: "JEJ-STYLE",
    },
  };

  it("U-P1: a re-plan tells the model to KEEP the project's existing narrator voice", () => {
    const { prompt } = buildGenerationPrompt({
      kind: "storyboard",
      input: withVoice,
      passage: PASSAGE,
    });
    expect(prompt).toContain("warm, weathered baritone — unhurried, reverent");
    expect(prompt).toContain("JEJ-STYLE");
    expect(prompt.toLowerCase()).toContain("keep");
  });

  it("U-P2: a first-time generation (no voice yet) is byte-identical to before", () => {
    const before = buildGenerationPrompt({
      kind: "storyboard",
      input: INPUT,
      passage: PASSAGE,
    });
    expect(before.prompt).not.toContain("narrator voice");
  });

  it("U-P3: the SCRIPT kind never carries it — a script regeneration returns no voice", () => {
    // `GeneratedScriptSchema` is {scriptText, reference, translation}; there is no
    // narratorVoice for the model to overwrite, so mentioning one is noise in the prompt.
    const { prompt } = buildGenerationPrompt({
      kind: "script",
      input: withVoice,
      passage: PASSAGE,
    });
    expect(prompt).not.toContain("JEJ-STYLE");
  });
});
