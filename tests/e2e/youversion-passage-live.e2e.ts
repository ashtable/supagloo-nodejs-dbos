import { describe, expect, it } from "vitest";

import {
  COLLECTION_PAGE_SIZE,
  YouVersionPassageNotFoundError,
  fetchPassage,
  getBibleCollection,
} from "../../src/providers/youversion";

/**
 * The LIVE YouVersion contract for the two calls `fetchScripturePassage` composes
 * (2026-07-30). Real `api.youversion.com`, real app key, no stub, **no DBOS runtime** —
 * same integration-style posture as `providers.e2e.ts`: the provider helpers are called
 * directly, because what is under test is the provider contract and not a workflow.
 *
 * ── Why this file exists ────────────────────────────────────────────────────────────
 * A user created a project by choosing NIV11 / Psalms / 23 in the wizard, opened the
 * studio, generated a storyboard, and got Genesis 1 in ASV. The first cause was on the
 * nextjs side (no `scripture` block was sent at all, so the model was left to invent one),
 * but fixing that alone would have traded a wrong passage for a hard failure, because of
 * two defects on THIS side of the wire — and neither had any live coverage:
 *
 *  1. **The passage endpoint only accepts a provider-issued USFM id.** The manifest's
 *     `reference` is a HUMAN string ("Psalm 23"), and `sceneScriptureContext` fed it
 *     straight in. A human reference 404s, `fetchPassage` raises a PERMANENT
 *     `YouVersionPassageNotFoundError`, and the whole generation fails. That was already
 *     live in production for every "rewrite this line" against a real project — it just
 *     had no test that ever sent a human reference. E-YVL3 is that test.
 *
 *  2. **The collection call read one page.** It sent no `page_size` and never followed
 *     `next_page_token`, and the provider's default page is small — so a translation the
 *     picker showed the user could be absent from the collection, and
 *     `resolveTranslation` would throw `TranslationNotLicensedError` about a translation
 *     that IS licensed. E-YVL1 is that test, and it calibrates itself.
 *
 * E-YVL2 pins the shape the fix depends on: the range id the wizard now persists must be
 * re-fetchable here, at generation time, months later.
 *
 * §10.8: the app key THROWS with an actionable message rather than skipping. A gating
 * suite that silently skips its provider is a green lie.
 */

const BASE_URL = process.env.YOUVERSION_BASE_URL ?? "https://api.youversion.com";
const APP_KEY = process.env.YOUVERSION_APP_KEY ?? "";

if (!APP_KEY) {
  throw new Error(
    "YOUVERSION_APP_KEY is missing. This live-contract suite calls the real YouVersion " +
      "host. Set YOUVERSION_APP_KEY in the ROOT repo's untracked .env (see its " +
      ".env.example) — the e2e lane loads it into each worker via tests/e2e/load-root-env.ts.",
  );
}

if (BASE_URL.includes("stub")) {
  throw new Error(
    `YOUVERSION_BASE_URL points at a stub (${BASE_URL}). The provider stubs were deleted ` +
      "in task 34-E8; this suite must reach the real host or it proves nothing.",
  );
}

const args = { youversionBaseUrl: BASE_URL, appKey: APP_KEY };

/**
 * ONE page of the collection, requested exactly as the client requests its first page —
 * `COLLECTION_PAGE_SIZE` and all.
 *
 * The page size is IMPORTED rather than written down, and that is the whole design of this
 * baseline. A first draft omitted it, and the resulting assertion survived a mutation that
 * replaced the token loop with `while (false)`: the client's single page (50) still beat the
 * provider's default page (25), so the test was measuring `page_size` while claiming to
 * measure the WALK. Holding the page size equal on both sides leaves following the token as
 * the only thing that can make a difference.
 */
async function oneClientPage(
  language: string,
): Promise<{ count: number; hasNext: boolean }> {
  const url = new URL(`${BASE_URL}/v1/bibles`);
  url.searchParams.append("language_ranges[]", language);
  url.searchParams.set("page_size", COLLECTION_PAGE_SIZE);
  const res = await fetch(url.toString(), {
    headers: { accept: "application/json", "x-yvp-app-key": APP_KEY },
  });
  expect(res.ok, `raw collection probe returned ${res.status}`).toBe(true);
  const body = (await res.json()) as {
    data?: unknown[];
    next_page_token?: string | null;
  };
  return {
    count: (body.data ?? []).length,
    hasNext: Boolean(body.next_page_token),
  };
}

describe("YouVersion live contract — the collection call is fully paginated", () => {
  it("E-YVL1: getBibleCollection returns MORE than ONE page requested the same way", async () => {
    // Self-calibrating on purpose: no page size and no catalogue size is written down.
    // `language_ranges[]=*` is simply a scope large enough that one page cannot hold it, and
    // the probe above measures what one page holds TODAY at the client's own page size.
    const first = await oneClientPage("*");
    expect(
      first.hasNext,
      "the whole-catalogue scope fitted on one page, so this test cannot discriminate — " +
        "widen the scope rather than deleting the assertion",
    ).toBe(true);

    const all = await getBibleCollection({ ...args, language: "*" });
    expect(all.length).toBeGreaterThan(first.count);
    // Every entry is usable as a passage-fetch path segment + a resolveTranslation key.
    for (const entry of all.slice(0, 50)) {
      expect(entry.id.length).toBeGreaterThan(0);
      expect(entry.abbreviation.length).toBeGreaterThan(0);
    }
    // No page was emitted twice (the classic token-loop bug: the same page forever).
    expect(new Set(all.map((e) => e.id)).size).toBe(all.length);
  }, 120_000);

  it("E-YVL1b: a single-page language scope still resolves, and BCP-47 works as well as ISO-639-3", async () => {
    // `ScripturePassageRequestSchema.language` defaults to `"eng"` while the picker's tags
    // are BCP-47 (`"en"`). Both were measured to return the same collection, so the
    // default is not the defect the read-side analysis suspected — pinned here so a future
    // change to either form is caught on the provider, not in a user's failed generation.
    const [iso, bcp47] = await Promise.all([
      getBibleCollection({ ...args, language: "eng" }),
      getBibleCollection({ ...args, language: "en" }),
    ]);
    expect(iso.length).toBeGreaterThan(0);
    expect(new Set(bcp47.map((b) => b.abbreviation))).toEqual(
      new Set(iso.map((b) => b.abbreviation)),
    );
  }, 60_000);
});

describe("YouVersion live contract — what fetchPassage accepts", () => {
  it("E-YVL2: the verse-RANGE id the wizard persists is re-fetchable at generation time", async () => {
    const english = await getBibleCollection({ ...args, language: "en" });
    const asv = english.find((b) => b.abbreviation === "ASV");
    expect(asv, "ASV was not in the live English collection").toBeDefined();

    // Enumerating verses is nextjs's job (it owns the picker's read surface), so the ids
    // are collected raw here rather than by adding an unused client method to dbos.
    const versesRes = await fetch(
      `${BASE_URL}/v1/bibles/${asv!.id}/books/PSA/chapters/121/verses`,
      { headers: { accept: "application/json", "x-yvp-app-key": APP_KEY } },
    );
    expect(versesRes.ok).toBe(true);
    const verseIds = (
      (await versesRes.json()) as { data?: { passage_id?: string }[] }
    ).data!.map((v) => v.passage_id!).filter(Boolean);
    expect(verseIds.length).toBeGreaterThan(1);

    // Exactly what the wizard sends: the first min(5, n) ECHOED ids, `+`-joined.
    const request = verseIds.slice(0, Math.min(5, verseIds.length)).join("+");
    const ranged = await fetchPassage({ ...args, version: asv!.id, reference: request });
    expect(ranged.text.length).toBeGreaterThan(0);
    expect(ranged.reference).toContain(":");

    // And the CANONICAL id the host echoes for that request — which is the value the
    // manifest actually stores — is itself fetchable. This is the round trip the whole
    // carry-through depends on: the wizard persists it, dbos re-fetches it later.
    const canonicalRes = await fetch(
      `${BASE_URL}/v1/bibles/${asv!.id}/passages/${encodeURIComponent(request)}`,
      { headers: { accept: "application/json", "x-yvp-app-key": APP_KEY } },
    );
    const canonicalId = ((await canonicalRes.json()) as { id?: string }).id!;
    expect(canonicalId).not.toBe(request); // the host normalised the list into a range
    const again = await fetchPassage({
      ...args,
      version: asv!.id,
      reference: canonicalId,
    });
    expect(again.text).toBe(ranged.text);
  }, 90_000);

  it("E-YVL3: a HUMAN reference is a PERMANENT typed 404 — the defect this run fixed", async () => {
    // The exact value `sceneScriptureContext` used to send. Every "rewrite this line"
    // against a real project failed the whole generation on this, and no test had ever
    // sent a non-USFM reference to prove it.
    const english = await getBibleCollection({ ...args, language: "en" });
    const asv = english.find((b) => b.abbreviation === "ASV")!;

    for (const human of ["Psalm 23", "Genesis 1:1", "Psalms 121:1-5"]) {
      const err = await fetchPassage({
        ...args,
        version: asv.id,
        reference: human,
      }).catch((e: unknown) => e);
      expect(err, human).toBeInstanceOf(YouVersionPassageNotFoundError);
      expect((err as YouVersionPassageNotFoundError).status).toBe(404);
    }

    // …while the USFM form of the same chapter is a 200.
    const ok = await fetchPassage({ ...args, version: asv.id, reference: "PSA.23" });
    expect(ok.text.length).toBeGreaterThan(0);
  }, 60_000);
});
