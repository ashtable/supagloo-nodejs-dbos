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

/**
 * The project's EXISTING narrator voice, read structurally off the passthrough input.
 *
 * Why this exists: `GeneratedStoryboardSchema` REQUIRES a `narratorVoice`, so every
 * storyboard generation produces one — and this builder never told the model that the
 * project already had a voice the user had written. The result was that "re-plan all
 * scenes", a button about SCENES, silently replaced a descriptor the user owned with
 * whatever the model invented. Naming the current voice and asking the model to keep it
 * makes the re-plan non-destructive.
 *
 * `voiceId` is deliberately NOT sent: it is a machine value from the studio's curated
 * per-model list, and an LLM has no business inventing a provider voice id. The studio
 * preserves it across a re-plan on the way back in.
 *
 * Forward-typed over the `.passthrough()` input. DELETE THE CAST AT THE db-lib BUMP.
 */
function existingNarratorVoice(
  input: unknown,
): { description: string; label?: string } | null {
  const raw = (input as { narratorVoice?: unknown } | null | undefined)?.narratorVoice;
  if (!raw || typeof raw !== "object") return null;
  const { description, label } = raw as { description?: unknown; label?: unknown };
  if (typeof description !== "string" || description.length === 0) return null;
  return {
    description,
    ...(typeof label === "string" && label.length > 0 ? { label } : {}),
  };
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
  // Storyboard only: the `script` kind returns {scriptText, reference, translation} and
  // has no narratorVoice to overwrite, so mentioning one there is noise in the prompt.
  if (args.kind !== "script") {
    const voice = existingNarratorVoice(args.input);
    if (voice) {
      parts.push(
        "This project already has a narrator voice the user chose. Keep it EXACTLY as " +
          "given — return it unchanged as `narratorVoice`, do not rewrite or improve it:\n" +
          `description: ${voice.description}` +
          (voice.label ? `\nlabel: ${voice.label}` : ""),
      );
    }
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
