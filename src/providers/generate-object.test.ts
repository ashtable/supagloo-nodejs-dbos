import { describe, it, expect } from "vitest";
import { z } from "zod";
import { retryUnlessPermanent } from "./errors";
import { callLlmStructured } from "./generate-object";

// The generateObject wrapper: structured text via an OpenAI-compatible provider
// (OpenRouter directly; Gloo via its chat-completions surface). The wrapper is a
// THIN pass-through — it calls generateObject with the caller's Zod schema and
// surfaces pass/fail; it never retries or repairs (the workflow's bounded repair
// loop owns that, design §6d). Injected fetch returns hand-built OpenAI
// chat-completion responses — no live provider, no mocking library.

const schema = z.object({ headline: z.string(), scenes: z.number() });

function chatFetch(
  content: string,
  capture?: { url?: string; auth?: string | null },
): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    if (capture) {
      capture.url = String(url);
      capture.auth = new Headers(init?.headers).get("authorization");
    }
    return new Response(
      JSON.stringify({
        id: "chatcmpl_1",
        object: "chat.completion",
        model: "test-model",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as unknown as typeof fetch;
}

function errorFetch(status: number): typeof fetch {
  return (async () =>
    new Response(JSON.stringify({ error: { message: "boom" } }), {
      status,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;
}

/** A single OpenAI chat-completion `Response` carrying `content` (a 200 body). */
function chatOk(content: string): Response {
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

/** A non-2xx `Response` (error envelope). */
function errStatus(status: number): Response {
  return new Response(JSON.stringify({ error: { message: "boom" } }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/**
 * A fetch that returns a DIFFERENT response per call (shift-per-invocation), plus a
 * live call counter. Models the sequence `DBOS.runStep` drives across a retry:
 * invoke → transient throw → shouldRetry → re-invoke against the next response.
 */
function sequenceFetch(steps: Array<() => Response>): {
  fetch: typeof fetch;
  count: () => number;
} {
  let i = 0;
  const f = (async () => {
    const step = steps[Math.min(i, steps.length - 1)];
    i += 1;
    return step();
  }) as unknown as typeof fetch;
  return { fetch: f, count: () => i };
}

describe("callLlmStructured", () => {
  it("returns the schema-parsed object (OpenRouter provider hits /api/v1/chat/completions)", async () => {
    const capture: { url?: string; auth?: string | null } = {};
    const object = await callLlmStructured({
      provider: "openrouter",
      baseUrl: "https://openrouter.ai",
      apiKey: "sk-or-test",
      modelId: "resolved/text-model",
      schema,
      prompt: "storyboard please",
      fetchImpl: chatFetch(
        JSON.stringify({ headline: "Refuge", scenes: 3 }),
        capture,
      ),
    });

    expect(object).toEqual({ headline: "Refuge", scenes: 3 });
    expect(capture.url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(capture.auth).toBe("Bearer sk-or-test");
  });

  it("targets Gloo's chat-completions surface at /ai/v2/chat/completions with the minted bearer", async () => {
    const capture: { url?: string; auth?: string | null } = {};
    await callLlmStructured({
      provider: "gloo",
      baseUrl: "https://platform.ai.gloo.com",
      apiKey: "gloo_stub_1",
      modelId: "gloo-resolved-model",
      schema,
      prompt: "storyboard please",
      fetchImpl: chatFetch(
        JSON.stringify({ headline: "Shelter", scenes: 2 }),
        capture,
      ),
    });
    expect(capture.url).toBe(
      "https://platform.ai.gloo.com/ai/v2/chat/completions",
    );
    expect(capture.auth).toBe("Bearer gloo_stub_1");
  });

  it("surfaces a Zod-validation failure (bad shape) as a NON-retryable error → workflow repair loop", async () => {
    let thrown: unknown;
    try {
      await callLlmStructured({
        provider: "openrouter",
        baseUrl: "https://openrouter.ai",
        apiKey: "k",
        modelId: "m",
        schema,
        prompt: "x",
        // valid JSON, wrong shape for `schema` → generateObject rejects
        fetchImpl: chatFetch(JSON.stringify({ not: "the schema" })),
      });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeDefined();
    // The wrapper does NOT retry/repair; the step classifier hands this back to the
    // workflow (does not burn the backoff budget).
    expect(retryUnlessPermanent(thrown)).toBe(false);
  });

  it("classifies a permanent 4xx as non-retryable and a transient 5xx as retryable", async () => {
    let permanent: unknown;
    try {
      await callLlmStructured({
        provider: "openrouter",
        baseUrl: "https://openrouter.ai",
        apiKey: "k",
        modelId: "m",
        schema,
        prompt: "x",
        fetchImpl: errorFetch(401),
      });
    } catch (e) {
      permanent = e;
    }
    expect(retryUnlessPermanent(permanent)).toBe(false);

    let transient: unknown;
    try {
      await callLlmStructured({
        provider: "openrouter",
        baseUrl: "https://openrouter.ai",
        apiKey: "k",
        modelId: "m",
        schema,
        prompt: "x",
        fetchImpl: errorFetch(503),
      });
    } catch (e) {
      transient = e;
    }
    expect(retryUnlessPermanent(transient)).toBe(true);
  });
});

// §10.6 reclassification (task 34-E1): the 503-then-200 retry SEQUENCE that was proven
// only by the now-deleted generateScript e2e ("retry (503 → 200)"). The AI SDK runs with
// maxRetries:0, so a single call throws on the 503; DBOS's runStep re-invokes the step
// (its LLM_STRUCTURED_RETRY.shouldRetry classified the 503 as transient). We reproduce
// that here at the call-function level: invoke twice over a sequenced fetch, proving the
// classified-transient 503 is followed by a clean success on the 200 — no DBOS needed.
describe("callLlmStructured — 503-then-200 retry sequence (§10.6, was generateScript e2e)", () => {
  it("throws a retryable error on the 503, then returns the schema-parsed object on the re-invoked 200", async () => {
    const seq = sequenceFetch([
      () => errStatus(503),
      () => chatOk(JSON.stringify({ headline: "Refuge", scenes: 3 })),
    ]);
    const call = () =>
      callLlmStructured({
        provider: "openrouter",
        baseUrl: "https://openrouter.ai",
        apiKey: "sk-or-test",
        modelId: "resolved/text-model",
        schema,
        prompt: "storyboard please",
        fetchImpl: seq.fetch,
      });

    // Attempt 1 consumes the 503: throws, and the step classifier says "retry".
    const transient = await call().catch((e) => e);
    expect(transient).toBeDefined();
    expect(retryUnlessPermanent(transient)).toBe(true);

    // Attempt 2 (the runStep re-invocation) consumes the 200 and succeeds.
    const object = await call();
    expect(object).toEqual({ headline: "Refuge", scenes: 3 });

    // The sequence advanced exactly two HTTP calls (503 → 200).
    expect(seq.count()).toBe(2);
  });
});
