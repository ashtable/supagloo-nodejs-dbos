import { describe, it, expect } from "vitest";
import {
  FALLBACK_TRANSLATIONS,
  resolveTranslation,
  type BibleCollectionEntry,
} from "./translation";
import { TranslationNotLicensedError } from "./errors";

// Task #30 licensing gate (design-delta §9-Q10). Generation sources whatever translation
// YouVersion licenses to the app for the user's language, resolved via the live "Get a Bible
// collection" call — bible ids never hardcoded. FALLBACK: if the collection call is
// unavailable (null), restrict to KJV/BSB (public domain) rather than guessing.

const COLLECTION: BibleCollectionEntry[] = [
  { id: "kjv", abbreviation: "KJV", name: "King James Version" },
  { id: "bsb", abbreviation: "BSB", name: "Berean Standard Bible" },
];

const WITH_NIV: BibleCollectionEntry[] = [
  ...COLLECTION,
  { id: "111", abbreviation: "NIV", name: "New International Version" },
];

describe("resolveTranslation — collection available", () => {
  it("resolves a licensed translation to its collection version id + label", () => {
    expect(resolveTranslation({ requested: "KJV", collection: COLLECTION })).toEqual({
      versionId: "kjv",
      label: "KJV",
    });
  });

  it("resolves any licensed translation (not just KJV/BSB) — §9-Q10 broadening", () => {
    expect(resolveTranslation({ requested: "NIV", collection: WITH_NIV })).toEqual({
      versionId: "111",
      label: "NIV",
    });
  });

  it("matches the requested abbreviation case-insensitively", () => {
    expect(resolveTranslation({ requested: "niv", collection: WITH_NIV })).toEqual({
      versionId: "111",
      label: "NIV",
    });
  });

  it("throws TranslationNotLicensedError when the requested translation is not in the collection", () => {
    expect(() =>
      resolveTranslation({ requested: "NIV", collection: COLLECTION }),
    ).toThrow(TranslationNotLicensedError);
  });
});

describe("resolveTranslation — collection unavailable (fallback to KJV/BSB)", () => {
  it("keeps a requested KJV/BSB when the live API is unavailable", () => {
    const resolved = resolveTranslation({ requested: "KJV", collection: null });
    expect(resolved.label).toBe("KJV");
    expect(FALLBACK_TRANSLATIONS).toContain(resolved.label);
    expect(resolved.versionId).toBe("kjv");
  });

  it("falls back to a public-domain default for a non-KJV/BSB request when unavailable", () => {
    const resolved = resolveTranslation({ requested: "NIV", collection: null });
    // No silent NIV: unavailable ⇒ restrict to public domain (KJV/BSB), never guess NIV's licensing.
    expect(FALLBACK_TRANSLATIONS).toContain(resolved.label);
  });
});
