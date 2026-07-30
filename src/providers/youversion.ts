import { ProviderHttpError } from "./errors";

/**
 * YouVersion Platform / Data Exchange client (design-delta §7 workflow 5 / §9-Q10 / §10.4a).
 * Two calls the generation workflow's `fetchScripturePassage` step composes: "Get a Bible
 * collection" (the licensed translation set for a language — bible ids are NEVER hardcoded,
 * always resolved here) and a passage fetch for a resolved version + reference.
 *
 * VERIFIED LIVE CONTRACT (task 34-E5, probed 2026-07-23 against https://api.youversion.com
 * with the real X-YVP-App-Key). The prior three documented shapes each disagreed; the real
 * API is a hybrid of two of them and the stub's `/data-exchange/**` routes 404:
 *   - collection: `GET /v1/bibles?language_ranges[]=<lang>` → `{ data: [ { id:<NUMBER>,
 *     abbreviation, title, language_tag, … } ] }`. The `id` is a NUMBER on the wire — we
 *     stringify it (it is both the passage-fetch path segment and resolveTranslation's key).
 *   - passage: `GET /v1/bibles/<numericId>/passages/<USFM_REF>` (PATH-based, not a query) →
 *     `{ id:<usfm>, content:<text>, reference:<human> }`. The reference MUST be USFM
 *     (e.g. "JHN.3.16"); a human reference ("John 3:16") 404s.
 *   - auth: header `x-yvp-app-key` (case-insensitive), REQUIRED on BOTH endpoints. A missing
 *     or wrong key → 401 (a gateway OAuth check that fires before backend routing). This is
 *     what makes a misconfigured app key fail the workflow DETERMINISTICALLY: the swallowed
 *     collection 401 falls back to KJV/BSB, but the passage fetch sends the same bad key and
 *     401s → a permanent ProviderHttpError → fail-fast (§10.4a deterministic-failure req).
 *
 * Injectable `fetch`, closes over the base URL — mirrors the api-side clients. Typed PERMANENT
 * content errors (unsupported/unparseable version 422 / passage-or-version not found 404)
 * extend `ProviderHttpError` so the shared `retryUnlessPermanent` classifier fails them fast;
 * any other non-ok surfaces as a `ProviderHttpError` carrying the status (401/403/… permanent,
 * 5xx/429 transient → retried by the step).
 */

const trimSlash = (u: string) => u.replace(/\/+$/, "");

/**
 * A requested version id the API cannot serve as a bible id — in practice a non-integer id
 * (HTTP 422 `int_parsing`), e.g. the public-domain fallback literal reaching the live host.
 */
export class YouVersionUnsupportedVersionError extends ProviderHttpError {
  constructor(version: string) {
    super(
      `YouVersion cannot serve version "${version}" (not a valid bible id)`,
      422,
    );
    this.name = "YouVersionUnsupportedVersionError";
  }
}

/** The requested version id or reference has no passage in the collection (HTTP 404). */
export class YouVersionPassageNotFoundError extends ProviderHttpError {
  constructor(reference: string) {
    super(`YouVersion has no passage for reference "${reference}"`, 404);
    this.name = "YouVersionPassageNotFoundError";
  }
}

export interface BibleCollectionEntry {
  /** The numeric YouVersion bible id, STRINGIFIED — the passage-fetch path segment + the
   *  resolveTranslation match key (never hardcoded upstream — always resolved from here). */
  id: string;
  /** The abbreviation the user selects/sees (e.g. "ASV", "BSB"). */
  abbreviation: string;
  /** The full version title (real field: `title`), e.g. "Berean Standard Bible". */
  name?: string;
  /** BCP-47 language tag (real field: `language_tag`), e.g. "en". */
  languageTag?: string;
}

/** The raw wire shape of a collection entry (before we stringify the numeric id). */
interface RawBibleCollectionEntry {
  id: number | string;
  abbreviation: string;
  title?: string;
  language_tag?: string;
}

/**
 * The page size the collection walk requests.
 *
 * 50 because the live host rejects 100 with a 400 — measured, and recorded the same way in
 * nextjs's own client (`lib/youversion/client.ts`), which this now matches. The provider's
 * DEFAULT page is smaller still (25, measured 2026-07-30: `language_ranges[]=*` returns 25 of
 * a reported `total_size: 1472`), which is what made the un-paginated version a silent cap.
 */
export const COLLECTION_PAGE_SIZE = "50";

export interface GetBibleCollectionArgs {
  /** e.g. `https://api.youversion.com` (the `/v1/bibles` path is appended). */
  youversionBaseUrl: string;
  /** The real API's `x-yvp-app-key`; sent when configured (required by the live host). */
  appKey?: string;
  /** ISO language range scoping the licensed set (e.g. "eng"). */
  language: string;
  fetchImpl?: typeof fetch;
}

function headers(appKey?: string): Record<string, string> {
  const h: Record<string, string> = { accept: "application/json" };
  if (appKey) h["x-yvp-app-key"] = appKey;
  return h;
}

/**
 * "Get a Bible collection" — every translation licensed to the app for a language.
 *
 * PAGINATED (fixed 2026-07-30). This used to send no `page_size` and never look at
 * `next_page_token`, so it saw exactly one page of the provider's choosing — 25 rows,
 * measured. Today's largest single-language grant is English at 20, so the truncation was
 * latent rather than live, but the failure mode it produces is the worst kind available:
 * `resolveTranslation` throws `TranslationNotLicensedError` for a translation the picker
 * showed the user and the user did choose, and the whole generation fails permanently with a
 * message blaming licensing. One more licensed Bible in any language is all that was
 * required, and nothing would have pointed here.
 *
 * `page_size` caps at 50 upstream and repeated `language_ranges[]` values do not union
 * (both measured, both recorded in nextjs's client too), so walking the tokens is the only
 * way through a large scope.
 */
export async function getBibleCollection(
  args: GetBibleCollectionArgs,
): Promise<BibleCollectionEntry[]> {
  const fetchImpl = args.fetchImpl ?? fetch;
  const out: BibleCollectionEntry[] = [];
  let pageToken: string | null = null;

  do {
    const url = new URL(`${trimSlash(args.youversionBaseUrl)}/v1/bibles`);
    url.searchParams.append("language_ranges[]", args.language);
    url.searchParams.set("page_size", COLLECTION_PAGE_SIZE);
    if (pageToken) url.searchParams.set("page_token", pageToken);

    const res = await fetchImpl(url.toString(), { headers: headers(args.appKey) });
    if (!res.ok) {
      throw new ProviderHttpError(
        `YouVersion collection lookup failed: ${res.status}`,
        res.status,
        await res.text().catch(() => undefined),
      );
    }
    const body = (await res.json()) as {
      data?: RawBibleCollectionEntry[];
      next_page_token?: string | null;
    };
    for (const raw of body.data ?? []) {
      out.push({
        // The wire `id` is a NUMBER — stringify so it is a valid path segment and so
        // resolveTranslation's string comparison works.
        id: String(raw.id),
        abbreviation: raw.abbreviation,
        name: raw.title,
        languageTag: raw.language_tag,
      });
    }
    pageToken = body.next_page_token ?? null;
  } while (pageToken);

  return out;
}

export interface FetchPassageArgs {
  youversionBaseUrl: string;
  appKey?: string;
  /** The collection-resolved NUMERIC version id (e.g. "3034"), never hardcoded upstream. */
  version: string;
  /**
   * A **provider-issued USFM passage id** — the ONLY format this endpoint accepts. A human
   * reference is a 404: measured live 2026-07-30,
   * `GET /v1/bibles/111/passages/Psalm%2023` → `{"message":"Bible passage Psalm23 for
   * version 111 not found"}`, which becomes a PERMANENT `YouVersionPassageNotFoundError` and
   * fails the whole generation. That is not hypothetical — the studio's per-scene "rewrite
   * this line" sent `ManifestScene.reference` (a human string) here until 2026-07-30.
   *
   * Accepted forms, all of them values the enumeration routes hand out (or that this host
   * itself echoed back for such a value), never assembled: a chapter (`"PSA.23"`), a single
   * verse (`"PSA.23.1"`), a canonical range (`"PSA.121.1-5"`), or a `+`-joined list of verse
   * ids (`"PSA.121.1+PSA.121.2"`, which the host normalises into a range id). The
   * both-sides form `"PSA.121.1-PSA.121.4"` is a 404 — nothing may construct one.
   */
  reference: string;
  fetchImpl?: typeof fetch;
}

export interface FetchedPassage {
  /** The human reference the API echoes back (e.g. "John 3:16"). */
  reference: string;
  /** The passage text (from the response `content`). */
  text: string;
}

/** Fetch the passage text for a resolved version + USFM reference. */
export async function fetchPassage(
  args: FetchPassageArgs,
): Promise<FetchedPassage> {
  const fetchImpl = args.fetchImpl ?? fetch;
  // Path-based: both the numeric version id and the USFM reference are path segments.
  const url = new URL(
    `${trimSlash(args.youversionBaseUrl)}/v1/bibles/` +
      `${encodeURIComponent(args.version)}/passages/${encodeURIComponent(args.reference)}`,
  );

  const res = await fetchImpl(url.toString(), { headers: headers(args.appKey) });
  // 422: the version id is not a valid bible id (e.g. a non-numeric fallback literal).
  if (res.status === 422) throw new YouVersionUnsupportedVersionError(args.version);
  // 404: the version id or the reference has no passage.
  if (res.status === 404) throw new YouVersionPassageNotFoundError(args.reference);
  if (!res.ok) {
    throw new ProviderHttpError(
      `YouVersion passage fetch failed: ${res.status}`,
      res.status,
      await res.text().catch(() => undefined),
    );
  }

  const body = (await res.json()) as {
    id?: string;
    content?: string;
    reference?: string;
  };
  return {
    reference: body.reference ?? args.reference,
    text: body.content ?? "",
  };
}
