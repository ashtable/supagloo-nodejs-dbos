/**
 * The wire vocabulary for Gloo's `tradition` request field (genesis-1 Inspector, D-B).
 *
 * ── Why this is validated HERE, at the wire, and not trusted from upstream ──────────
 *
 * Gloo does **not** validate `tradition`. Measured against the live host on 2026-07-28:
 * `orthodox`, `protestant`, `reformed`, `pentecostal`, `buddhist`, `null` and a garbage
 * sentinel ALL returned **200** and silently collapsed to the same neutral baseline that
 * omitting the field produces (757 injected prompt tokens, versus 11253 for `catholic`,
 * 11289 for `evangelical`, 11275 for `mainline`). There is no 422 and nothing in the
 * response envelope distinguishes "honoured" from "ignored".
 *
 * So the failure mode of a wrong value is not an error anyone sees. It is a user who
 * picked a faith alignment, watched the generation succeed, and got a video that is not
 * faith-aligned. The only place that can be caught is on our side of the wire — which is
 * this function.
 *
 * **There is no `protestant` and no `orthodox`.** `evangelical` and `mainline` are the
 * two Protestant-family values Gloo offers. The task's own phrasing said "catholic,
 * protestant, etc.", which is exactly the wrong guess this guard exists to stop.
 *
 * ── Why this duplicates db-lib's `FaithAlignmentSchema` ─────────────────────────────
 *
 * They are two different contracts that happen to share a value set today. db-lib's enum
 * is the **manifest** vocabulary — what may be persisted into the user's GitHub repo.
 * This one is the **wire** vocabulary — what Gloo accepts. If Gloo ever adds a value we
 * do not want in a committed manifest (or vice versa), these must be able to move apart
 * without one of them dragging the other. Each side names the other, and each is pinned
 * by its own test.
 *
 * ── Why it DROPS rather than throws ────────────────────────────────────────────────
 *
 * A bad value must degrade to "send nothing", which is byte-identical to what Gloo does
 * with it anyway. Throwing would fail a generation that would otherwise have produced a
 * usable (if neutral) result, after the user had already spent it.
 */

/** The four values Gloo's `tradition` field actually honours. Frozen so nothing can
 *  widen the wire vocabulary at runtime. */
export const GLOO_TRADITIONS = Object.freeze([
  "evangelical",
  "catholic",
  "mainline",
  "not_faith_specific",
] as const);

export type GlooTradition = (typeof GLOO_TRADITIONS)[number];

/**
 * Narrow an untrusted value (it arrives as JSON off an `AiGeneration.input` column) to a
 * real `tradition`, or `undefined`.
 *
 * Case-sensitive on purpose. Gloo itself is case-insensitive, but accepting `"Catholic"`
 * here would mean two spellings of the same choice can reach the wire, which makes the
 * manifest's persisted value and the request body disagree about their own vocabulary —
 * and makes any later "which alignments are in use?" question ambiguous. The UI only ever
 * emits the canonical lowercase form.
 */
export function coerceTradition(value: unknown): GlooTradition | undefined {
  if (typeof value !== "string") return undefined;
  return (GLOO_TRADITIONS as readonly string[]).includes(value)
    ? (value as GlooTradition)
    : undefined;
}
