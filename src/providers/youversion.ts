import { ProviderHttpError } from "./errors";

/**
 * YouVersion Data Exchange client (design-delta §7 workflow 5 / §9-Q10). Two calls the
 * generation workflow's `fetchScripturePassage` step composes: "Get a Bible collection"
 * (the licensed translation set for a language — bible ids are NEVER hardcoded, always
 * resolved here) and a passage fetch for a resolved version + reference.
 *
 * ROUTE-SHAPE DISCREPANCY (implementation-time verification — matching the plan's own
 * "Notes" flag). Three sources disagree on the real API's paths and none can be verified
 * from this environment:
 *   - design-delta §9-Q10: `GET /v1/bibles?language_ranges[]=<lang>` (+ a passages endpoint
 *     under the same `/v1` root), base `https://api.youversion.com`, auth `X-YVP-App-Key`.
 *   - supagloo-nodejs-api `src/config/env.ts` comment: a path-based
 *     `/v1/bibles/{id}/passages/{ref}` shape.
 *   - the actual `youversion-stub` (the e2e ground truth): `GET /data-exchange/v1/bibles`
 *     (collection) + `GET /data-exchange/v1/passages?version=&reference=`.
 * This client is built to the STUB's routes so the e2e is real and passes; the
 * `X-YVP-App-Key` header + `language_ranges[]` query are still sent (real-API-correct, the
 * stub ignores them). Reconcile against YouVersion's live API when app licensing is wired.
 *
 * Injectable `fetch`, closes over the base URL — mirrors the api-side clients. Typed
 * PERMANENT content errors (unsupported version 400 / passage not found 404) extend
 * `ProviderHttpError` so the shared `retryUnlessPermanent` classifier fails them fast; a
 * 5xx surfaces as a transient `ProviderHttpError` and is retried by the step.
 */

const trimSlash = (u: string) => u.replace(/\/+$/, "");

/** A requested translation is not in the app's licensed collection for this language. */
export class YouVersionUnsupportedVersionError extends ProviderHttpError {
  constructor(version: string) {
    super(
      `YouVersion does not license version "${version}" for generation`,
      400,
    );
    this.name = "YouVersionUnsupportedVersionError";
  }
}

/** The reference has no passage in the requested version. */
export class YouVersionPassageNotFoundError extends ProviderHttpError {
  constructor(reference: string) {
    super(`YouVersion has no passage for reference "${reference}"`, 404);
    this.name = "YouVersionPassageNotFoundError";
  }
}

export interface BibleCollectionEntry {
  /** The version id used downstream in the passage fetch (never hardcoded — from here). */
  id: string;
  /** The abbreviation the user selects/sees (e.g. "KJV", "NIV"). */
  abbreviation: string;
  name?: string;
  language?: { iso_639_3?: string; name?: string };
  public_domain?: boolean;
}

export interface GetBibleCollectionArgs {
  /** e.g. `https://api.youversion.com` (the data-exchange path is appended). */
  youversionBaseUrl: string;
  /** The real API's `X-YVP-App-Key`; sent when configured (the stub ignores it). */
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

/** "Get a Bible collection" — the translations licensed to the app for a language. */
export async function getBibleCollection(
  args: GetBibleCollectionArgs,
): Promise<BibleCollectionEntry[]> {
  const fetchImpl = args.fetchImpl ?? fetch;
  const url = new URL(`${trimSlash(args.youversionBaseUrl)}/data-exchange/v1/bibles`);
  // Real-API-correct scoping (`?language_ranges[]=<lang>`, without all_available); the
  // stub's path-only matcher ignores the query.
  url.searchParams.append("language_ranges[]", args.language);

  const res = await fetchImpl(url.toString(), { headers: headers(args.appKey) });
  if (!res.ok) {
    throw new ProviderHttpError(
      `YouVersion collection lookup failed: ${res.status}`,
      res.status,
      await res.text().catch(() => undefined),
    );
  }
  const body = (await res.json()) as { data?: BibleCollectionEntry[] };
  return body.data ?? [];
}

export interface FetchPassageArgs {
  youversionBaseUrl: string;
  appKey?: string;
  /** The collection-resolved version id (e.g. "kjv"), never hardcoded upstream. */
  version: string;
  /** e.g. "John 3:16". */
  reference: string;
  fetchImpl?: typeof fetch;
}

export interface FetchedPassage {
  reference: string;
  /** The translation abbreviation the text is in (uppercased). */
  translation: string;
  /** The joined passage text. */
  text: string;
}

/** Fetch the passage text for a resolved version + reference. */
export async function fetchPassage(
  args: FetchPassageArgs,
): Promise<FetchedPassage> {
  const fetchImpl = args.fetchImpl ?? fetch;
  const url = new URL(`${trimSlash(args.youversionBaseUrl)}/data-exchange/v1/passages`);
  url.searchParams.set("version", args.version);
  url.searchParams.set("reference", args.reference);

  const res = await fetchImpl(url.toString(), { headers: headers(args.appKey) });
  if (res.status === 400) throw new YouVersionUnsupportedVersionError(args.version);
  if (res.status === 404) throw new YouVersionPassageNotFoundError(args.reference);
  if (!res.ok) {
    throw new ProviderHttpError(
      `YouVersion passage fetch failed: ${res.status}`,
      res.status,
      await res.text().catch(() => undefined),
    );
  }

  const body = (await res.json()) as {
    version?: string;
    reference?: string;
    passages?: Array<{ reference?: string; text?: string }>;
  };
  const passages = body.passages ?? [];
  const text = passages
    .map((p) => p.text ?? "")
    .filter(Boolean)
    .join("\n\n");
  return {
    reference: passages[0]?.reference ?? body.reference ?? args.reference,
    translation: (body.version ?? args.version).toUpperCase(),
    text,
  };
}
