import { ProviderHttpError } from "./errors";

/**
 * Model discovery (design-delta §7): the hard rule is that model ids are NEVER
 * hardcoded — they are resolved at call time from OpenRouter's discovery endpoints:
 *   - text / speech / image → `GET /api/v1/models?output_modalities=<csv>`
 *   - video                 → `GET /api/v1/videos/models`
 * The generation workflows call these and pick an id (e.g. a configured preference or
 * the first result). `output_modalities` values (`"text"`, `"audio"`, …) are provider
 * QUERY tokens, not model ids.
 *
 * A process-level TTL cache avoids re-listing on every generation (model catalogues
 * change infrequently). The clock is injectable so expiry is testable without real
 * time; `clearDiscoveryCache()` resets it (used per-test and available for a forced
 * refresh).
 */

// Real OpenRouter's TTS/narration modality token is "audio", not "speech" — do not drift.
export interface DiscoveryConfig {
  /** Provider ROOT (e.g. `https://openrouter.ai`); discovery paths are appended. */
  openrouterBaseUrl: string;
  fetchImpl?: typeof fetch;
  /** Injectable clock (ms since epoch); defaults to `Date.now`. */
  now?: () => number;
  /** Cache lifetime in ms; defaults to {@link DEFAULT_TTL_MS}. */
  ttlMs?: number;
}

export interface DiscoverModelsOptions {
  /** Filter to models whose output modalities include these (e.g. `["text"]`). */
  outputModalities: string[];
}

const DEFAULT_TTL_MS = 5 * 60_000;

interface CacheEntry {
  expiresAt: number;
  ids: string[];
}

const cache = new Map<string, CacheEntry>();

const trimSlash = (u: string) => u.replace(/\/+$/, "");

/** Clear the whole discovery cache (test isolation / forced refresh). */
export function clearDiscoveryCache(): void {
  cache.clear();
}

const modelsSchema = (raw: unknown): string[] => {
  const body = raw as { data?: Array<{ id?: unknown }> };
  return (body.data ?? [])
    .map((m) => m.id)
    .filter((id): id is string => typeof id === "string");
};

async function listIds(
  cfg: DiscoveryConfig,
  cacheKey: string,
  url: string,
): Promise<string[]> {
  const now = cfg.now?.() ?? Date.now();
  const cached = cache.get(cacheKey);
  if (cached && now < cached.expiresAt) return cached.ids;

  const fetchImpl = cfg.fetchImpl ?? fetch;
  const res = await fetchImpl(url, {
    method: "GET",
    headers: { accept: "application/json" },
  });
  if (!res.ok) {
    throw new ProviderHttpError(
      `model discovery failed: ${res.status}`,
      res.status,
      await res.text().catch(() => undefined),
    );
  }
  const ids = modelsSchema(await res.json());
  const ttl = cfg.ttlMs ?? DEFAULT_TTL_MS;
  cache.set(cacheKey, { expiresAt: now + ttl, ids });
  return ids;
}

/** List model ids for the given output modalities (`GET /api/v1/models?output_modalities=…`). */
export async function discoverModels(
  cfg: DiscoveryConfig,
  opts: DiscoverModelsOptions,
): Promise<string[]> {
  const root = trimSlash(cfg.openrouterBaseUrl);
  const modalities = opts.outputModalities.join(",");
  const query = new URLSearchParams({ output_modalities: modalities });
  const url = `${root}/api/v1/models?${query.toString()}`;
  const cacheKey = `${root}::models::${opts.outputModalities.slice().sort().join(",")}`;
  return listIds(cfg, cacheKey, url);
}

/** List video model ids (`GET /api/v1/videos/models`). */
export async function discoverVideoModels(
  cfg: DiscoveryConfig,
): Promise<string[]> {
  const root = trimSlash(cfg.openrouterBaseUrl);
  const url = `${root}/api/v1/videos/models`;
  return listIds(cfg, `${root}::videos`, url);
}
