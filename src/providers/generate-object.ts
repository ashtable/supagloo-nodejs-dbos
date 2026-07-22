import {
  generateObject,
  type LanguageModel,
  type LanguageModelUsage,
} from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import type { z } from "zod";

/**
 * The structured-text wrapper (design-delta §7 "provider call patterns"): generate a
 * Zod-validated object via the Vercel AI SDK's `generateObject` through an
 * OpenAI-compatible provider.
 *
 * BOTH providers use `createOpenAI({ baseURL }).chat(modelId)` — the `.chat()` path
 * emits `response_format: { type: "json_schema" }`, the structured-output shape both
 * OpenRouter and Gloo honor. We deliberately do NOT use the bare `openai(id)` /
 * default Responses-API path: Gloo's Responses endpoint ignores structured-output
 * formatting (verified — see supagloo-nextjs CLAUDE.md "LLM Provider: Gloo").
 *
 * Provider → chat-completions surface:
 *   - openrouter: `{baseUrl}/api/v1`  → POST `{baseUrl}/api/v1/chat/completions`
 *   - gloo:       `{baseUrl}/ai/v2`   → POST `{baseUrl}/ai/v2/chat/completions`
 *
 * CONTRACT: the wrapper is a thin pass-through. It surfaces pass/fail and NEVER
 * retries or repairs — the calling workflow owns the bounded re-prompt/repair loop
 * (design §6d). `maxRetries: 0` disables the AI SDK's own internal retry so the DBOS
 * step is the single source of retry truth (its `shouldRetry`/backoff classifies the
 * surfaced `APICallError`/`NoObjectGeneratedError`). Model ids are resolved via
 * discovery and passed in — never hardcoded here.
 */

export type StructuredProvider = "openrouter" | "gloo";

const trimSlash = (u: string) => u.replace(/\/+$/, "");

/** The OpenAI-compatible chat-completions base URL for each provider. */
function chatBaseUrl(provider: StructuredProvider, baseUrl: string): string {
  const root = trimSlash(baseUrl);
  return provider === "gloo" ? `${root}/ai/v2` : `${root}/api/v1`;
}

export interface BuildStructuredModelArgs {
  provider: StructuredProvider;
  /** The provider ROOT (e.g. `https://openrouter.ai`); the surface path is appended. */
  baseUrl: string;
  /** OpenRouter API key, or the freshly-minted Gloo bearer token. */
  apiKey: string;
  modelId: string;
  /** Injectable for unit tests; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
}

/** Build the AI-SDK chat model for a provider (structured-output enabled). */
export function buildStructuredModel(
  args: BuildStructuredModelArgs,
): LanguageModel {
  const provider = createOpenAI({
    baseURL: chatBaseUrl(args.provider, args.baseUrl),
    apiKey: args.apiKey,
    fetch: args.fetchImpl,
  });
  return provider.chat(args.modelId);
}

export interface CallLlmStructuredArgs<T> {
  provider: StructuredProvider;
  baseUrl: string;
  apiKey: string;
  modelId: string;
  schema: z.ZodType<T>;
  system?: string;
  prompt: string;
  fetchImpl?: typeof fetch;
}

export interface StructuredResult<T> {
  object: T;
  /** AI-SDK token usage (`{inputTokens?, outputTokens?, totalTokens?}`) for persistence. */
  usage: LanguageModelUsage;
}

/**
 * Generate a schema-validated object AND surface the token usage. Returns
 * `{object, usage}` on success; throws `NoObjectGeneratedError` (schema mismatch — hand
 * back to the repair loop) or `APICallError` (HTTP failure — classified by the step's
 * `shouldRetry`) on failure. Task #30's generation workflow persists `usage` as
 * `AiGeneration.tokenUsage`.
 */
export async function callLlmStructuredWithUsage<T>(
  args: CallLlmStructuredArgs<T>,
): Promise<StructuredResult<T>> {
  const { object, usage } = await generateObject({
    model: buildStructuredModel(args),
    schema: args.schema,
    system: args.system,
    prompt: args.prompt,
    maxRetries: 0,
  });
  return { object, usage };
}

/**
 * Generate a schema-validated object. Returns the parsed object on success; throws
 * `NoObjectGeneratedError` (schema mismatch — hand back to the repair loop) or
 * `APICallError` (HTTP failure — classified by the step's `shouldRetry`) on failure.
 * Thin wrapper over {@link callLlmStructuredWithUsage} that discards the usage — kept for
 * callers that don't persist token counts.
 */
export async function callLlmStructured<T>(
  args: CallLlmStructuredArgs<T>,
): Promise<T> {
  const { object } = await callLlmStructuredWithUsage(args);
  return object;
}
