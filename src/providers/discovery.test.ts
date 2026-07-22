import { beforeEach, describe, it, expect } from "vitest";
import { ProviderHttpError } from "./errors";
import {
  clearDiscoveryCache,
  discoverModels,
  discoverVideoModels,
} from "./discovery";

// Model discovery: ids are NEVER hardcoded — the layer resolves them at call time
// from OpenRouter's discovery endpoints (`GET /api/v1/models?output_modalities=…`
// for text/speech, `GET /api/v1/videos/models` for video). A process-level TTL
// cache avoids re-listing on every generation; the clock is injectable so expiry
// is testable without real time.

interface Spy {
  urls: string[];
  fetch: typeof fetch;
}

function spyFetch(body: unknown, status = 200): Spy {
  const urls: string[] = [];
  const fetchImpl = (async (url: string | URL | Request) => {
    urls.push(String(url));
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { urls, fetch: fetchImpl };
}

const MODELS_BODY = {
  data: [
    { id: "acme/text-model", output_modalities: ["text"] },
    { id: "acme/speech-model", output_modalities: ["audio"] },
  ],
};

beforeEach(() => {
  clearDiscoveryCache();
});

describe("discoverModels", () => {
  it("builds the output_modalities query and parses data[].id", async () => {
    const spy = spyFetch(MODELS_BODY);
    const ids = await discoverModels(
      { openrouterBaseUrl: "https://openrouter.ai", fetchImpl: spy.fetch },
      { outputModalities: ["text"] },
    );
    expect(ids).toEqual(["acme/text-model", "acme/speech-model"]);
    expect(spy.urls[0]).toBe(
      "https://openrouter.ai/api/v1/models?output_modalities=text",
    );
  });

  it("joins multiple modalities with a comma", async () => {
    const spy = spyFetch(MODELS_BODY);
    await discoverModels(
      { openrouterBaseUrl: "https://openrouter.ai", fetchImpl: spy.fetch },
      { outputModalities: ["text", "image"] },
    );
    expect(spy.urls[0]).toContain("output_modalities=text%2Cimage");
  });

  it("caches within the TTL (no second fetch) and re-fetches after it expires", async () => {
    const spy = spyFetch(MODELS_BODY);
    let clock = 1_000;
    const cfg = {
      openrouterBaseUrl: "https://openrouter.ai",
      fetchImpl: spy.fetch,
      now: () => clock,
      ttlMs: 60_000,
    };

    await discoverModels(cfg, { outputModalities: ["text"] });
    await discoverModels(cfg, { outputModalities: ["text"] });
    expect(spy.urls).toHaveLength(1); // second call served from cache

    clock += 60_001; // past the TTL
    await discoverModels(cfg, { outputModalities: ["text"] });
    expect(spy.urls).toHaveLength(2); // re-listed after expiry
  });

  it("clearDiscoveryCache() forces a re-fetch", async () => {
    const spy = spyFetch(MODELS_BODY);
    const cfg = { openrouterBaseUrl: "https://openrouter.ai", fetchImpl: spy.fetch };
    await discoverModels(cfg, { outputModalities: ["text"] });
    clearDiscoveryCache();
    await discoverModels(cfg, { outputModalities: ["text"] });
    expect(spy.urls).toHaveLength(2);
  });

  it("surfaces a non-2xx as a ProviderHttpError", async () => {
    const spy = spyFetch({ error: "nope" }, 500);
    await expect(
      discoverModels(
        { openrouterBaseUrl: "https://openrouter.ai", fetchImpl: spy.fetch },
        { outputModalities: ["text"] },
      ),
    ).rejects.toBeInstanceOf(ProviderHttpError);
  });
});

describe("discoverVideoModels", () => {
  it("lists the video discovery endpoint and parses ids", async () => {
    const spy = spyFetch({ data: [{ id: "acme/video-model" }] });
    const ids = await discoverVideoModels({
      openrouterBaseUrl: "https://openrouter.ai",
      fetchImpl: spy.fetch,
    });
    expect(ids).toEqual(["acme/video-model"]);
    expect(spy.urls[0]).toBe("https://openrouter.ai/api/v1/videos/models");
  });
});
