import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// Design invariant (design-delta §7): model ids are NEVER hardcoded in source —
// every concrete id (text/speech/image/video) is resolved at call time via the
// discovery endpoints. This lint-style test fails if any provider-layer source
// file contains a string that looks like a model id, so the invariant can't rot.
//
// It scans the shipping provider source only (not tests, which legitimately use
// fixture ids). The patterns target `vendor/model` slugs and vendor-qualified id
// shapes — NOT API paths (`/api/v1/models`), modality tokens (`"text"`, `"audio"`),
// or provider keys (`"openrouter"`, `"gloo"`).

// CommonJS build (see tsconfig `module: node16`) — `__dirname` is the provider dir.
const PROVIDERS_DIR = __dirname;

const MODEL_ID_PATTERNS: Array<{ label: string; re: RegExp }> = [
  {
    label: "vendor/model slug",
    re: /\b(openai|anthropic|google|meta-llama|mistralai|x-ai|deepseek|qwen|cohere|perplexity)\/[a-z0-9._-]+/i,
  },
  {
    // Real Gloo ids are vendor-qualified: `gloo-openai-gpt-5-mini`,
    // `gloo-anthropic-claude-sonnet-4.5` (supagloo-nextjs CLAUDE.md). Constrain to
    // known vendors so it doesn't trip on incidental `gloo-<word>` prose/paths.
    label: "gloo vendor-qualified id",
    re: /\bgloo-(openai|anthropic|google|meta|mistral|cohere|xai|deepseek|qwen|llama)-[a-z0-9]/i,
  },
  { label: "stub model id", re: /\bstub\/(text|speech|video)-model\b/ },
  { label: "gpt-N", re: /\bgpt-[0-9]/i },
  { label: "claude-...N", re: /\bclaude-[a-z0-9]*[0-9]/i },
  { label: "gemini-N", re: /\bgemini-[0-9]/i },
];

function providerSourceFiles(): string[] {
  return readdirSync(PROVIDERS_DIR)
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
    .map((f) => join(PROVIDERS_DIR, f));
}

describe("no hardcoded model ids in the provider layer", () => {
  it("finds provider source files to scan", () => {
    // Guard against the scan silently passing because it matched nothing.
    expect(providerSourceFiles().length).toBeGreaterThan(0);
  });

  it("contains zero literal model ids", () => {
    const offenders: string[] = [];
    for (const file of providerSourceFiles()) {
      const text = readFileSync(file, "utf8");
      for (const { label, re } of MODEL_ID_PATTERNS) {
        const m = text.match(re);
        if (m) offenders.push(`${file}: ${label} → "${m[0]}"`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
