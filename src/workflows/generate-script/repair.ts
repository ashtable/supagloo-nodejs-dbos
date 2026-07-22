import { RepairExhaustedError } from "./errors";
import { appendValidationErrors } from "./prompt";

/**
 * The bounded static re-prompt loop (design-delta §6d / §7 workflow 5). A plain `for` loop
 * over an injected `attempt(prompt, index)` — pure control flow, so the invalid→valid and
 * exhaustion→failure sequences unit-test WITHOUT the LLM or DBOS. The real workflow injects
 * a DBOS-step-backed `attempt` (each attempt a registered `callLlmStructured` step whose
 * schema-validation failure is surfaced as `{ok:false}` rather than thrown — see the workflow
 * for why that keeps replay exactly-once).
 *
 * Semantics: 1 initial attempt + up to `MAX_REPAIR_ATTEMPTS` (3) repairs = up to 4 attempts.
 * Each failed attempt appends its Zod validation errors to the prompt for the next attempt.
 */

export const MAX_REPAIR_ATTEMPTS = 3;

export type AttemptResult<T> =
  | { ok: true; object: T; usage?: unknown }
  | { ok: false; validationText: string };

export interface RunStructuredWithRepairArgs<T> {
  initialPrompt: string;
  attempt: (prompt: string, attemptIndex: number) => Promise<AttemptResult<T>>;
  maxRepairs?: number;
}

export interface RepairedResult<T> {
  object: T;
  usage?: unknown;
  /** How many attempts were made (1 = first-try success). */
  attempts: number;
}

export async function runStructuredWithRepair<T>(
  args: RunStructuredWithRepairArgs<T>,
): Promise<RepairedResult<T>> {
  const maxRepairs = args.maxRepairs ?? MAX_REPAIR_ATTEMPTS;
  let prompt = args.initialPrompt;
  let lastValidationText = "";

  for (let i = 0; i <= maxRepairs; i++) {
    const result = await args.attempt(prompt, i);
    if (result.ok) {
      return { object: result.object, usage: result.usage, attempts: i + 1 };
    }
    lastValidationText = result.validationText;
    // Re-prompt the NEXT attempt with the failed attempt's validation errors appended.
    prompt = appendValidationErrors(args.initialPrompt, result.validationText);
  }

  throw new RepairExhaustedError(maxRepairs + 1, lastValidationText);
}
