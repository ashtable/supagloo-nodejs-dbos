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
