import { describe, it, expect } from "vitest";
import { NoObjectGeneratedError } from "ai";
import { z } from "zod";
import {
  MAX_REPAIR_ATTEMPTS,
  runStructuredWithRepair,
  type AttemptResult,
} from "./repair";
import { RepairExhaustedError } from "./errors";
import { callLlmStructured } from "../../providers/generate-object";

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

// §10.6 reclassification (task 34-E1): the malformed-then-valid REPAIR sequence that was
// proven only by the now-deleted generateScript e2e ("repair (malformed → valid)"). Above,
// the loop is driven by fake {ok}/{ok:false} attempts. Here we drive it through the REAL
// callLlmStructured over an INJECTED FETCH SEQUENCE, with an `attempt` that mirrors the
// production workflow's adapter (a schema-validation failure surfaces as {ok:false} — a
// bounded repair, not a step retry). This reproduces the HTTP-level stitch at unit level.

const REPAIR_SCHEMA = z.object({ headline: z.string(), scenes: z.number() });

/** A 200 chat-completion `Response` carrying `content` as the assistant message. */
function chatResponse(content: string): Response {
  return new Response(
    JSON.stringify({
      id: "chatcmpl_1",
      object: "chat.completion",
      model: "test-model",
      choices: [
        { index: 0, message: { role: "assistant", content }, finish_reason: "stop" },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

/** A fetch that returns a different chat body per call (shift-per-invocation) + a counter. */
function sequenceFetch(bodies: Array<() => Response>): {
  fetch: typeof fetch;
  count: () => number;
} {
  let i = 0;
  const f = (async () => {
    const step = bodies[Math.min(i, bodies.length - 1)];
    i += 1;
    return step();
  }) as unknown as typeof fetch;
  return { fetch: f, count: () => i };
}

/**
 * The production repair adapter (generate-script.ts): call the LLM, and translate a
 * schema-validation failure into {ok:false} so the loop re-prompts (HTTP failures would
 * rethrow to the step's LLM_STRUCTURED_RETRY — not exercised here).
 */
function llmAttempt(fetchImpl: typeof fetch) {
  return async (prompt: string): Promise<AttemptResult<unknown>> => {
    try {
      const object = await callLlmStructured({
        provider: "openrouter",
        baseUrl: "https://openrouter.ai",
        apiKey: "sk-or-test",
        modelId: "resolved/text-model",
        schema: REPAIR_SCHEMA,
        prompt,
        fetchImpl,
      });
      return { ok: true, object };
    } catch (e) {
      if (NoObjectGeneratedError.isInstance(e)) {
        return { ok: false, validationText: (e as Error).message };
      }
      throw e;
    }
  };
}

describe("runStructuredWithRepair over a real callLlmStructured attempt (injected-fetch, §10.6)", () => {
  it("repairs malformed → valid across two real LLM HTTP calls, returning the repaired object", async () => {
    const seq = sequenceFetch([
      () => chatResponse(JSON.stringify({ not: "the schema" })), // fails REPAIR_SCHEMA
      () => chatResponse(JSON.stringify({ headline: "Refuge", scenes: 3 })), // valid
    ]);
    const result = await runStructuredWithRepair<unknown>({
      initialPrompt: "BASE",
      attempt: llmAttempt(seq.fetch),
    });
    expect(result.object).toEqual({ headline: "Refuge", scenes: 3 });
    expect(result.attempts).toBe(2);
    // Exactly two chat calls (the malformed 200 + the repaired 200) — the e2e's
    // `chatCompletions===2`, now proven without a stub.
    expect(seq.count()).toBe(2);
  });

  it("throws RepairExhaustedError when every HTTP attempt returns a malformed object (4 calls)", async () => {
    const seq = sequenceFetch([() => chatResponse(JSON.stringify({ not: "the schema" }))]);
    const err = await runStructuredWithRepair<unknown>({
      initialPrompt: "BASE",
      attempt: llmAttempt(seq.fetch),
    }).catch((e) => e);
    expect(err).toBeInstanceOf(RepairExhaustedError);
    expect((err as RepairExhaustedError).attempts).toBe(MAX_REPAIR_ATTEMPTS + 1);
    // 1 initial + 3 repairs = 4 real LLM HTTP calls before exhaustion.
    expect(seq.count()).toBe(4);
  });
});
