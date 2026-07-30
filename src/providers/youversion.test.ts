import { describe, it, expect } from "vitest";
import { ProviderHttpError, retryUnlessPermanent } from "./errors";
import {
  fetchPassage,
  getBibleCollection,
  YouVersionPassageNotFoundError,
  YouVersionUnsupportedVersionError,
} from "./youversion";
import { resolveTranslation } from "../workflows/generate-script/translation";

// YouVersion Platform / Data Exchange client (design-delta §7 workflow 5 / §9-Q10 / §10.4a).
// Fixtures below are REAL response shapes CAPTURED LIVE from https://api.youversion.com on
// 2026-07-23 with the real X-YVP-App-Key (task 34-E5) — not the old stub's invented shapes.
// Injected fetch + hand-built Response, no mocking library.
//
// The real API (verified):
//   collection: GET /v1/bibles?language_ranges[]=<lang>  -> { data: [ { id:<NUMBER>, abbreviation, title, language_tag, … } ] }
//   passage:    GET /v1/bibles/<numericId>/passages/<USFM>  -> { id:<usfm>, content:<text>, reference:<human> }
//   auth header x-yvp-app-key required on BOTH; missing/wrong key -> 401.

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

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

// --- REAL captured collection body (two representative entries: ASV=12, BSB=3034). The `id`
// is a NUMBER on the wire; `books` truncated for readability (the client never reads it). ---
const COLLECTION_BODY = {
  data: [
    {
      id: 12,
      abbreviation: "ASV",
      language_tag: "en",
      localized_abbreviation: "ASV",
      localized_title: "American Standard Version",
      title: "American Standard Version",
      books: ["GEN", "JHN", "REV"],
      youversion_deep_link: "https://www.bible.com/versions/12",
      organization_id: null,
    },
    {
      id: 3034,
      abbreviation: "BSB",
      language_tag: "en",
      localized_abbreviation: "BSB",
      localized_title: "Berean Standard Bible",
      title: "Berean Standard Bible",
      books: ["GEN", "JHN", "REV"],
      youversion_deep_link: "https://www.bible.com/versions/3034",
      organization_id: "c3187cfe-a191-4088-9fb2-24c306d9eb38",
    },
  ],
};

// Real 401 fault body (missing/wrong app key), captured live.
const INVALID_KEY_BODY = {
  fault: {
    faultstring: "Invalid ApiKey",
    detail: { errorcode: "oauth.v2.InvalidApiKey" },
  },
};

describe("getBibleCollection", () => {
  it("GETs /v1/bibles scoped by language_ranges[] and maps data[] to string ids + abbreviations", async () => {
    const captured: Captured[] = [];
    const collection = await getBibleCollection({
      youversionBaseUrl: "https://api.youversion.com",
      appKey: "app-key-123",
      language: "eng",
      fetchImpl: capturingFetch(captured, jsonResponse(COLLECTION_BODY)),
    });

    // The real API returns numeric ids on the wire; the client MUST stringify them so they
    // work both as the passage-fetch path segment and in resolveTranslation's string compare.
    expect(collection.map((c) => c.id)).toEqual(["12", "3034"]);
    expect(collection.map((c) => c.abbreviation)).toEqual(["ASV", "BSB"]);

    const req = captured[0];
    expect(req.method ?? "GET").toBe("GET");
    expect(req.url).toContain("/v1/bibles");
    // The stub's /data-exchange prefix 404s on the real host — it must be gone.
    expect(req.url).not.toContain("/data-exchange");
    expect(req.url).toContain("language_ranges");
    expect(req.url).toContain("eng");
    // The real API requires x-yvp-app-key (case-insensitive); sent when configured.
    expect(req.appKey).toBe("app-key-123");
  });

  it("resolves a licensed translation's numeric version id from the live collection shape", async () => {
    // version-id resolution end-to-end on the REAL shape: the parsed collection feeds
    // resolveTranslation, which must yield the numeric id (as a string) for the path fetch.
    const collection = await getBibleCollection({
      youversionBaseUrl: "https://api.youversion.com",
      language: "eng",
      fetchImpl: (async () => jsonResponse(COLLECTION_BODY)) as unknown as typeof fetch,
    });
    expect(resolveTranslation({ requested: "BSB", collection })).toEqual({
      versionId: "3034",
      label: "BSB",
    });
  });

  it("omits the app-key header when none is configured", async () => {
    const captured: Captured[] = [];
    await getBibleCollection({
      youversionBaseUrl: "https://api.youversion.com",
      language: "eng",
      fetchImpl: capturingFetch(captured, jsonResponse(COLLECTION_BODY)),
    });
    expect(captured[0].appKey).toBeNull();
  });

  it("surfaces a 401 (bad/missing app key) as a permanent ProviderHttpError", async () => {
    const fetchImpl = (async () =>
      jsonResponse(INVALID_KEY_BODY, 401)) as unknown as typeof fetch;
    const err = await getBibleCollection({
      youversionBaseUrl: "https://api.youversion.com",
      language: "eng",
      fetchImpl,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(ProviderHttpError);
    expect((err as ProviderHttpError).status).toBe(401);
    expect(retryUnlessPermanent(err)).toBe(false);
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

  /**
   * PAGINATION (2026-07-30).
   *
   * This call sent NO `page_size` and never read `next_page_token`, so it saw exactly one
   * page. Measured live the same day: the default page is **25** rows
   * (`language_ranges[]=*` returns 25 of a reported `total_size: 1472`, with a
   * `next_page_token`). Today's largest single-language grant is English at 20, so the
   * truncation is LATENT rather than live — but the failure mode when it fires is the worst
   * available one: `resolveTranslation` throws `TranslationNotLicensedError` for a
   * translation the user was shown and did pick, and the whole generation fails permanently
   * with a message blaming licensing. One more licensed English Bible is all it takes.
   *
   * nextjs's own client already pages (`lib/youversion/client.ts`), and its measured note
   * records that `page_size` caps at 50 and that repeated `language_ranges[]` do not union —
   * so pagination is the only way through. This brings the two clients into agreement.
   */
  it("U-YV1: follows next_page_token to the end and unions every page", async () => {
    const captured: Captured[] = [];
    const pages = [
      {
        data: [{ id: 12, abbreviation: "ASV", title: "American Standard Version" }],
        next_page_token: "tok-2",
      },
      {
        data: [{ id: 111, abbreviation: "NIV11", title: "New International Version" }],
        next_page_token: "tok-3",
      },
      {
        data: [{ id: 3034, abbreviation: "BSB", title: "Berean Standard Bible" }],
        next_page_token: null,
      },
    ];
    let n = 0;
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      captured.push({ url: String(url), method: init?.method, appKey: headers.get("x-yvp-app-key") });
      return jsonResponse(pages[n++]);
    }) as unknown as typeof fetch;

    const collection = await getBibleCollection({
      youversionBaseUrl: "https://api.youversion.com",
      appKey: "app-key-123",
      language: "eng",
      fetchImpl,
    });

    expect(captured).toHaveLength(3);
    expect(collection.map((c) => c.abbreviation)).toEqual(["ASV", "NIV11", "BSB"]);
    // The token from page 1 has to reach request 2, or the walk is an infinite loop over
    // the first page rather than a walk.
    expect(captured[1].url).toContain("page_token=tok-2");
    expect(captured[2].url).toContain("page_token=tok-3");
    // ...and the FIRST request must not carry one.
    expect(captured[0].url).not.toContain("page_token");
    // The language scope has to be re-sent on every page.
    for (const req of captured) expect(req.url).toContain("language_ranges");
  });

  it("U-YV2: sends an explicit page_size so the provider's default page cannot silently cap the walk", async () => {
    const captured: Captured[] = [];
    await getBibleCollection({
      youversionBaseUrl: "https://api.youversion.com",
      language: "eng",
      fetchImpl: capturingFetch(captured, jsonResponse(COLLECTION_BODY)),
    });
    expect(captured[0].url).toContain("page_size=");
  });

  it("U-YV3: one page with no token is exactly ONE request — no loop, no extra egress", async () => {
    const captured: Captured[] = [];
    const collection = await getBibleCollection({
      youversionBaseUrl: "https://api.youversion.com",
      language: "eng",
      // COLLECTION_BODY has no next_page_token at all (the live shape when the whole
      // collection fits on one page — `{data, next_page_token: null, total_size}`).
      fetchImpl: capturingFetch(captured, jsonResponse(COLLECTION_BODY)),
    });
    expect(captured).toHaveLength(1);
    expect(collection).toHaveLength(2);
  });
});

describe("fetchPassage", () => {
  it("GETs the path-based /v1/bibles/{id}/passages/{USFM} and returns {reference, text} from content", async () => {
    const captured: Captured[] = [];
    // Real captured 200 body for GET /v1/bibles/3034/passages/JHN.3.16.
    const body = {
      id: "JHN.3.16",
      content:
        "For God so loved the world that He gave His one and only Son, that everyone who believes in Him shall not perish but have eternal life.",
      reference: "John 3:16",
    };
    const passage = await fetchPassage({
      youversionBaseUrl: "https://api.youversion.com",
      appKey: "app-key-123",
      version: "3034",
      reference: "JHN.3.16",
      fetchImpl: capturingFetch(captured, jsonResponse(body)),
    });

    expect(passage.reference).toBe("John 3:16");
    expect(passage.text).toContain("For God so loved the world");

    const req = captured[0];
    // Path-based: id + USFM ref are path SEGMENTS, not query params.
    expect(req.url).toContain("/v1/bibles/3034/passages/JHN.3.16");
    expect(req.url).not.toContain("/data-exchange");
    expect(req.url).not.toContain("version=");
    expect(req.url).not.toContain("/passages?");
    expect(req.appKey).toBe("app-key-123");
  });

  it("maps a 422 (non-integer version id) to a PERMANENT YouVersionUnsupportedVersionError", async () => {
    // Real captured 422 body (e.g. a non-numeric version id like the fallback literal "kjv").
    const body = {
      detail: [
        {
          type: "int_parsing",
          loc: ["path", "bible_id"],
          msg: "Input should be a valid integer, unable to parse string as an integer",
          input: "kjv",
        },
      ],
    };
    const fetchImpl = (async () =>
      jsonResponse(body, 422)) as unknown as typeof fetch;
    const err = await fetchPassage({
      youversionBaseUrl: "https://api.youversion.com",
      appKey: "app-key-123",
      version: "kjv",
      reference: "JHN.3.16",
      fetchImpl,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(YouVersionUnsupportedVersionError);
    expect(retryUnlessPermanent(err)).toBe(false);
  });

  it("maps a 404 (version-or-passage not found) to a PERMANENT YouVersionPassageNotFoundError", async () => {
    // Real captured 404 body for a bad USFM ref.
    const body = { message: "Bible passage NOWHERE.9.9 for version 12 not found" };
    const fetchImpl = (async () =>
      jsonResponse(body, 404)) as unknown as typeof fetch;
    const err = await fetchPassage({
      youversionBaseUrl: "https://api.youversion.com",
      appKey: "app-key-123",
      version: "12",
      reference: "NOWHERE.9.9",
      fetchImpl,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(YouVersionPassageNotFoundError);
    expect(retryUnlessPermanent(err)).toBe(false);
  });

  it("surfaces a 401 (bad/missing app key) as a permanent ProviderHttpError — deterministic-failure proof", async () => {
    const fetchImpl = (async () =>
      jsonResponse(INVALID_KEY_BODY, 401)) as unknown as typeof fetch;
    const err = await fetchPassage({
      youversionBaseUrl: "https://api.youversion.com",
      appKey: "wrong-key",
      version: "3034",
      reference: "JHN.3.16",
      fetchImpl,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(ProviderHttpError);
    expect((err as ProviderHttpError).status).toBe(401);
    expect(retryUnlessPermanent(err)).toBe(false);
  });

  it("surfaces a 5xx as a transient ProviderHttpError", async () => {
    const fetchImpl = (async () =>
      new Response("boom", { status: 502 })) as unknown as typeof fetch;
    const err = await fetchPassage({
      youversionBaseUrl: "https://api.youversion.com",
      appKey: "app-key-123",
      version: "3034",
      reference: "JHN.3.16",
      fetchImpl,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(ProviderHttpError);
    expect(retryUnlessPermanent(err)).toBe(true);
  });
});
