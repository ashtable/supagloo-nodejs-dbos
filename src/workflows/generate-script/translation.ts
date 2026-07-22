import type { BibleCollectionEntry } from "../../providers/youversion";
import { TranslationNotLicensedError } from "./errors";

export type { BibleCollectionEntry };

/**
 * The translation-licensing gate (design-delta §9-Q10). Generation sources whatever
 * translation YouVersion licenses to the app for the user's language — resolved against the
 * live "Get a Bible collection" call, never hardcoded. Given the requested abbreviation and
 * the collection (or `null` when the live API was unavailable), returns the version id +
 * canonical label to fetch/persist, or throws when the request asks for a translation the
 * app is not licensed for.
 *
 * FALLBACK (the ONLY place bible ids are literal, justified by the §9-Q10 fallback clause):
 * when the collection call is unavailable, restrict to the public-domain KJV/BSB rather than
 * guessing another translation's licensing — keeping a requested KJV/BSB, otherwise defaulting
 * to BSB (the design's new-project default).
 */

export interface ResolvedTranslation {
  /** The version id used in the passage fetch. */
  versionId: string;
  /** The translation abbreviation the text is in (persisted onto the result). */
  label: string;
}

/** The public-domain fallback translations (label → literal version id), §9-Q10 fallback. */
export const FALLBACK_VERSION_IDS: Record<string, string> = {
  KJV: "kjv",
  BSB: "bsb",
};
export const FALLBACK_TRANSLATIONS = Object.keys(FALLBACK_VERSION_IDS);
const DEFAULT_FALLBACK = "BSB";

export interface ResolveTranslationArgs {
  requested: string;
  /** The licensed collection, or `null` when the live collection call was unavailable. */
  collection: BibleCollectionEntry[] | null;
}

export function resolveTranslation(
  args: ResolveTranslationArgs,
): ResolvedTranslation {
  const requested = args.requested.trim();

  if (args.collection === null) {
    // Live API unavailable → restrict to public domain; never guess a non-KJV/BSB license.
    const label =
      FALLBACK_TRANSLATIONS.find(
        (t) => t.toLowerCase() === requested.toLowerCase(),
      ) ?? DEFAULT_FALLBACK;
    return { versionId: FALLBACK_VERSION_IDS[label], label };
  }

  const match = args.collection.find(
    (entry) =>
      entry.abbreviation.toLowerCase() === requested.toLowerCase() ||
      entry.id.toLowerCase() === requested.toLowerCase(),
  );
  if (!match) throw new TranslationNotLicensedError(requested);
  return { versionId: match.id, label: match.abbreviation };
}
