import { describe, it, expect } from "vitest";
import { ProviderHttpError, retryUnlessPermanent } from "./errors";
import {
  fetchPassage,
  getBibleCollection,
  YouVersionPassageNotFoundError,
  YouVersionUnsupportedVersionError,
} from "./youversion";

// The YouVersion Data Exchange client (design-delta §7 workflow 5 / §9-Q10). Built to the
// ACTUAL youversion-stub routes so the e2e is real (the three documented shapes conflict —
// see youversion.ts). Injected fetch, hand-built Response — no mocking library.

interface Captured {
  url: string;
  method?: string;
  appKey: string | null;
}

function capturingFetch(captured: Captured[], response: Response): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    captured.push({
      url: String(url),
      method: init?.method,
      appKey: headers.get("x-yvp-app-key"),
    });
    return response;
  }) as unknown as typeof fetch;
}

const COLLECTION_BODY = {
  data: [
    { id: "kjv", abbreviation: "KJV", name: "King James Version" },
    { id: "bsb", abbreviation: "BSB", name: "Berean Standard Bible" },
  ],
};

describe("getBibleCollection", () => {
  it("GETs the data-exchange collection scoped by language and parses data[]", async () => {
    const captured: Captured[] = [];
    const fetchImpl = capturingFetch(
      captured,
      new Response(JSON.stringify(COLLECTION_BODY), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    const collection = await getBibleCollection({
      youversionBaseUrl: "https://api.youversion.com",
      appKey: "app-key-123",
      language: "eng",
      fetchImpl,
    });

    expect(collection.map((c) => c.id)).toEqual(["kjv", "bsb"]);
    const req = captured[0];
    expect(req.method ?? "GET").toBe("GET");
    expect(req.url).toContain("/data-exchange/v1/bibles");
    expect(req.url).toContain("language_ranges");
    expect(req.url).toContain("eng");
    // The real API requires X-YVP-App-Key; sent when configured.
    expect(req.appKey).toBe("app-key-123");
  });

  it("omits the app-key header when none is configured", async () => {
    const captured: Captured[] = [];
    const fetchImpl = capturingFetch(
      captured,
      new Response(JSON.stringify(COLLECTION_BODY), { status: 200 }),
    );
    await getBibleCollection({
      youversionBaseUrl: "https://api.youversion.com",
      language: "eng",
      fetchImpl,
    });
    expect(captured[0].appKey).toBeNull();
  });

  it("surfaces a 5xx as a transient ProviderHttpError", async () => {
    const fetchImpl = (async () =>
      new Response("boom", { status: 503 })) as unknown as typeof fetch;
    const err = await getBibleCollection({
      youversionBaseUrl: "https://api.youversion.com",
      language: "eng",
      fetchImpl,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(ProviderHttpError);
    expect((err as ProviderHttpError).status).toBe(503);
    expect(retryUnlessPermanent(err)).toBe(true);
  });
});

describe("fetchPassage", () => {
  it("GETs the passage by version + reference and returns {reference, translation, text}", async () => {
    const captured: Captured[] = [];
    const fetchImpl = capturingFetch(
      captured,
      new Response(
        JSON.stringify({
          version: "KJV",
          reference: "John 3:16",
          copyright: "Public Domain",
          passages: [
            {
              reference: "John 3:16",
              text: "For God so loved the world.",
              verses: [{ number: 16, reference: "John 3", text: "For God so loved the world." }],
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    const passage = await fetchPassage({
      youversionBaseUrl: "https://api.youversion.com",
      version: "kjv",
      reference: "John 3:16",
      fetchImpl,
    });

    expect(passage.reference).toBe("John 3:16");
    expect(passage.translation).toBe("KJV");
    expect(passage.text).toContain("For God so loved the world");
    const req = captured[0];
    expect(req.url).toContain("/data-exchange/v1/passages");
    expect(req.url).toContain("version=kjv");
    expect(req.url).toContain("reference=John+3%3A16");
  });

  it("maps a 400 unsupported_version to a PERMANENT typed error", async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ error: "unsupported_version" }), {
        status: 400,
      })) as unknown as typeof fetch;
    const err = await fetchPassage({
      youversionBaseUrl: "https://api.youversion.com",
      version: "niv",
      reference: "John 3:16",
      fetchImpl,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(YouVersionUnsupportedVersionError);
    expect(retryUnlessPermanent(err)).toBe(false);
  });

  it("maps a 404 passage_not_found to a PERMANENT typed error", async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ error: "passage_not_found" }), {
        status: 404,
      })) as unknown as typeof fetch;
    const err = await fetchPassage({
      youversionBaseUrl: "https://api.youversion.com",
      version: "kjv",
      reference: "Nowhere 9:9",
      fetchImpl,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(YouVersionPassageNotFoundError);
    expect(retryUnlessPermanent(err)).toBe(false);
  });

  it("surfaces a 5xx as a transient ProviderHttpError", async () => {
    const fetchImpl = (async () =>
      new Response("boom", { status: 502 })) as unknown as typeof fetch;
    const err = await fetchPassage({
      youversionBaseUrl: "https://api.youversion.com",
      version: "kjv",
      reference: "John 3:16",
      fetchImpl,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(ProviderHttpError);
    expect(retryUnlessPermanent(err)).toBe(true);
  });
});
