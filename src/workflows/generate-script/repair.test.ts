import { describe, it, expect } from "vitest";
import {
  MAX_REPAIR_ATTEMPTS,
  runStructuredWithRepair,
  type AttemptResult,
} from "./repair";
import { RepairExhaustedError } from "./errors";

// Task #30 bounded re-prompt loop (design-delta §6d / §7 workflow 5). The loop is a PURE
// async function over an injected `attempt(prompt, index)` — so the invalid→valid and
// exhaustion→failure sequences are unit-testable WITHOUT the LLM or DBOS. The real workflow
// injects a DBOS-step-backed attempt; here we inject fakes. Max 3 repairs = up to 4 attempts.

describe("runStructuredWithRepair", () => {
  it("returns on the FIRST attempt when it validates (no repair prompt built)", async () => {
    const prompts: string[] = [];
    const result = await runStructuredWithRepair<{ ok: 1 }>({
      initialPrompt: "BASE",
      attempt: async (prompt) => {
        prompts.push(prompt);
        return { ok: true, object: { ok: 1 }, usage: { totalTokens: 5 } };
      },
    });
    expect(result.object).toEqual({ ok: 1 });
    expect(result.attempts).toBe(1);
    expect(result.usage).toEqual({ totalTokens: 5 });
    expect(prompts).toEqual(["BASE"]);
  });

  it("repairs invalid → valid, feeding the prior validation errors into the repair prompt", async () => {
    const prompts: string[] = [];
    const script: AttemptResult<{ n: number }>[] = [
      { ok: false, validationText: "scenes: Required" },
      { ok: true, object: { n: 2 } },
    ];
    let i = 0;
    const result = await runStructuredWithRepair<{ n: number }>({
      initialPrompt: "BASE",
      attempt: async (prompt) => {
        prompts.push(prompt);
        return script[i++];
      },
    });
    expect(result.object).toEqual({ n: 2 });
    expect(result.attempts).toBe(2);
    // The repair prompt carries the base + the first attempt's validation errors.
    expect(prompts[0]).toBe("BASE");
    expect(prompts[1]).toContain("BASE");
    expect(prompts[1]).toContain("scenes: Required");
  });

  it("throws RepairExhaustedError after the initial attempt + 3 repairs all fail (4 total)", async () => {
    let calls = 0;
    const err = await runStructuredWithRepair({
      initialPrompt: "BASE",
      attempt: async () => {
        calls += 1;
        return { ok: false, validationText: `bad #${calls}` };
      },
    }).catch((e) => e);
    expect(err).toBeInstanceOf(RepairExhaustedError);
    expect(calls).toBe(MAX_REPAIR_ATTEMPTS + 1);
    expect(calls).toBe(4);
    // The error carries the attempt count + the last validation errors for the failed generation.
    expect((err as RepairExhaustedError).attempts).toBe(4);
    expect((err as RepairExhaustedError).message).toContain("bad #4");
  });
});
