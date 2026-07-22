import type { AiGenerationKind, GenerateScriptInput } from "@supagloo/database-lib";

/**
 * Pure prompt builders for the generation workflow (design-delta §7 workflow 5). The
 * workflow feeds the request brief + (optionally) the fetched scripture passage into
 * `buildGenerationPrompt`, and the bounded repair loop calls `appendValidationErrors` to
 * re-prompt with the Zod validation failures. Kept pure so the prompt shape is unit-testable
 * without the LLM/DBOS. Model ids are NOT chosen here (resolved at enqueue, read off the row).
 */

/** The scripture passage `fetchScripturePassage` resolved for a generation. */
export interface ResolvedPassage {
  reference: string;
  translation: string;
  text: string;
}

const STORYBOARD_SYSTEM =
  "You are a scripture-to-video storyboard writer. Break the passage into an ordered " +
  "sequence of short vertical-video scenes. Respond ONLY with structured JSON matching the " +
  "provided schema: an array of scenes (each with name, scriptText, reference, translation, " +
  "visualPrompt, suggestedDurationSeconds) plus a whole-video narratorVoice and musicStyle. " +
  "Preserve the exact scripture wording of the provided translation — never paraphrase verses.";

const SCRIPT_SYSTEM =
  "You are a scripture-video script writer. Produce the single-scene narration text for the " +
  "given passage. Respond ONLY with structured JSON matching the provided schema: scriptText, " +
  "reference, and translation. Preserve the exact scripture wording of the provided " +
  "translation — never paraphrase verses.";

export interface BuildGenerationPromptArgs {
  kind: AiGenerationKind;
  input: GenerateScriptInput;
  passage: ResolvedPassage | null;
}

export interface BuiltPrompt {
  system: string;
  prompt: string;
}

export function buildGenerationPrompt(
  args: BuildGenerationPromptArgs,
): BuiltPrompt {
  const system = args.kind === "script" ? SCRIPT_SYSTEM : STORYBOARD_SYSTEM;

  const parts: string[] = [`Brief:\n${args.input.brief}`];
  if (args.passage) {
    parts.push(
      `Scripture passage (${args.passage.reference} · ${args.passage.translation}):\n` +
        args.passage.text,
    );
  }
  return { system, prompt: parts.join("\n\n") };
}

/**
 * Re-prompt for a repair attempt: append the Zod validation errors from the failed attempt
 * plus a corrective instruction, preserving the original prompt so the model has full context.
 */
export function appendValidationErrors(
  prompt: string,
  validationErrors: string,
): string {
  return (
    `${prompt}\n\n` +
    "Your previous response did not match the required schema. Validation errors:\n" +
    `${validationErrors}\n` +
    "Return corrected JSON that satisfies the schema exactly."
  );
}
