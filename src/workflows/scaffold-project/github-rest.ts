/**
 * The GitHub REST half of the scaffold flow: installation-scoped reachability, PR
 * open, PR merge. Raw `fetch` + hand parsing (house style — no Octokit anywhere).
 * `fetchImpl` is injectable for unit tests; every input is passed explicitly.
 *
 * Every request here runs through db-lib's {@link withGithubRetry} (plan row 64,
 * design-delta §11.7 "one implementation, four consumers"), so a throttled GitHub is
 * honoured in-process rather than surfaced as a workflow failure. See
 * {@link isPermanentHttpStatus} for the two-layer rule that keeps that from stacking
 * with the DBOS step budget.
 */

import { withGithubRetry } from "@supagloo/database-lib";

/** Thrown when the installation token genuinely cannot reach the repo — a PERMANENT
 *  failure that must NOT be retried (the step's `shouldRetry` returns false for it). */
export class RepoUnreachableError extends Error {
  readonly code = "REPO_UNREACHABLE" as const;
  constructor(message: string) {
    super(message);
    this.name = "RepoUnreachableError";
  }
}

/**
 * A non-success GitHub REST response on a genuine FAILURE path (not the idempotent
 * 422-already-exists / 405-already-merged paths, which are handled inline as
 * successes). Carries the HTTP status so callers can classify permanent vs transient
 * via {@link isPermanentHttpStatus}.
 */
export class GithubRestError extends Error {
  readonly status: number;
  /**
   * An OPTIONAL machine-readable discriminator for failures the status alone cannot
   * distinguish (plan row 63 / D63.5). Today the only value is `"base_ref_unborn"`.
   * Absent on every other failure, so existing two-argument call sites are unchanged
   * and no classifier keys off it.
   */
  readonly code?: string;
  constructor(message: string, status: number, code?: string) {
    super(message);
    this.name = "GithubRestError";
    this.status = status;
    this.code = code;
  }
}

/** `errors[].code === "invalid"` on `field: "base"` — GitHub's answer when the base ref
 *  named in a `POST /pulls` does not exist (the unborn-`main` case). */
export const BASE_REF_UNBORN = "base_ref_unborn" as const;

interface GithubErrorEnvelope {
  message?: string;
  errors?: Array<{ field?: string; code?: string; message?: string }>;
}

/**
 * Read a non-2xx body ONCE, best-effort. A `Response` body can only be consumed once,
 * so this is called only on the terminal throw path — never before a branch that might
 * still read the body itself.
 */
async function readErrorEnvelope(res: Response): Promise<GithubErrorEnvelope | string> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    return "";
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === "object") return parsed as GithubErrorEnvelope;
  } catch {
    /* not JSON — fall through to the raw text */
  }
  return raw.trim().slice(0, 300);
}

/** GitHub's own words for a failure, so three different 422s stop looking identical. */
function envelopeDetail(envelope: GithubErrorEnvelope | string): string {
  if (typeof envelope === "string") return envelope;
  const detail = (envelope.errors ?? [])
    .map((e) => e.message ?? (e.field && e.code ? `${e.field}: ${e.code}` : undefined))
    .filter((m): m is string => Boolean(m));
  return [envelope.message, ...detail].filter(Boolean).join(" — ");
}

/**
 * A permanent HTTP failure: a 4xx that is NOT 429. 429 (rate-limit) and 5xx (server
 * error) are transient and get a durable DBOS step retry with backoff.
 *
 * **The two-layer rule (plan row 64 / D64.1). `403` stays PERMANENT here, and that is a
 * decision, not an oversight.** This doc-comment used to claim a blanket *"4xx (bad
 * credential, forbidden, gone, unprocessable) will not change on retry"* — and for
 * `forbidden` that was simply false: GitHub returns its **secondary (abuse) rate limit**
 * as `403 + Retry-After`, which absolutely does change on retry. (design-delta §6(d) and
 * §7 carried the same error in prose; row 64 corrects all three.)
 *
 * The fix is not to reclassify 403 here — it is to honour the delay one layer down:
 *
 *   - **The CLIENT sleeps.** Every request in this module goes through
 *     {@link withGithubRetry}, which honours `Retry-After` / `x-ratelimit-reset` with a
 *     bounded budget capped at 60s per wait. It is the only layer that *can*: the DBOS
 *     step budget is `NETWORK_RETRY {maxAttempts: 4, intervalSeconds: 1, backoffRate: 2}`
 *     ≈ **7 s total**, against a secondary-limit `Retry-After` that is typically **60 s**.
 *     Four DBOS attempts in 7 s honour nothing; they burn the budget and fail anyway.
 *   - **This classifier keeps `403 ⇒ permanent`,** so the step budget does not stack four
 *     more attempts on top of a delay the client already waited out.
 *
 * And a **bare** 403 — no `Retry-After`, no exhausted `x-ratelimit-remaining` — is not
 * retried by either layer, because it is a genuine permission denial. §11.3:1832-1834
 * makes that load-bearing: the installation deliberately holds **no `administration`
 * scope**, so permission-denial 403s are an expected behaviour of the credential split.
 *
 * `429` stays transient at BOTH layers: a primary rate limit that outlives the
 * in-process budget is worth a durable, crash-safe re-attempt.
 */
export function isPermanentHttpStatus(status: number): boolean {
  return status >= 400 && status < 500 && status !== 429;
}

export interface GithubRestConfig {
  apiBaseUrl: string;
  /** A minted installation token (`ghs_…`). */
  token: string;
  fetchImpl?: typeof fetch;
  /**
   * Injectable sleep for the bounded rate-limit backoff (plan row 64). Defaults to a
   * real timer, which is what production wants; the unit lane passes a recording spy so
   * nothing ever actually waits (design-delta §10.6).
   */
  sleepImpl?: (ms: number) => Promise<void>;
}

const trimSlash = (u: string) => u.replace(/\/+$/, "");

/**
 * Run one GitHub request under the shared bounded, capped, rate-limit-aware backoff.
 *
 * `withGithubRetry` RETURNS the final `Response` and never throws, so every branch below
 * — the idempotent `422`/`405` successes just as much as the failures — still sees a real
 * response and decides for itself. That is what keeps a generic retry wrapper from
 * swallowing this module's semantic status branches. `fn` must issue a FRESH request each
 * call; never hand it a `Response`.
 */
function retrying(
  cfg: GithubRestConfig,
  fn: () => Promise<Response>,
): Promise<Response> {
  return withGithubRetry(fn, { sleepImpl: cfg.sleepImpl });
}

function authHeaders(token: string): Record<string, string> {
  return {
    authorization: `token ${token}`,
    accept: "application/vnd.github+json",
  };
}

/** Extract the `rel="next"` URL from an RFC 5988 `Link` header, if present. */
function nextPageUrl(link: string | null): string | null {
  if (!link) return null;
  for (const part of link.split(",")) {
    const m = part.match(/<([^>]+)>\s*;\s*rel="next"/);
    if (m) return m[1];
  }
  return null;
}

/**
 * Idempotent reachability check — replaces the earlier `createGithubRepo` step. The
 * repo already exists (created pre-enqueue via the JIT user-token hop); here we
 * confirm the INSTALLATION token can reach it by listing the installation's
 * accessible repositories (`GET /installation/repositories`, following pagination)
 * and finding `owner/repo`. Absent ⇒ {@link RepoUnreachableError} (non-retryable);
 * a non-2xx list ⇒ a plain Error (retryable transient).
 */
export async function ensureRepoReachable(
  cfg: GithubRestConfig,
  owner: string,
  repo: string,
): Promise<{ fullName: string }> {
  const fetchImpl = cfg.fetchImpl ?? fetch;
  const fullName = `${owner}/${repo}`;
  let url: string | null =
    `${trimSlash(cfg.apiBaseUrl)}/installation/repositories?per_page=100`;

  while (url) {
    const pageUrl = url;
    const res = await retrying(cfg, () =>
      fetchImpl(pageUrl, { headers: authHeaders(cfg.token) }),
    );
    if (!res.ok) {
      // A 401/403 here (bad/insufficient installation token) is permanent; a 5xx is
      // transient. Typed so the step's `shouldRetry` can tell them apart.
      throw new GithubRestError(
        `installation repositories list failed: ${res.status}`,
        res.status,
      );
    }
    const body = (await res.json()) as {
      repositories?: Array<{ full_name?: string }>;
    };
    if ((body.repositories ?? []).some((r) => r.full_name === fullName)) {
      return { fullName };
    }
    url = nextPageUrl(res.headers.get("link"));
  }

  throw new RepoUnreachableError(
    `installation token cannot reach ${fullName} (not in the installation's accessible repositories)`,
  );
}

export interface OpenedPr {
  number: number;
  url: string;
}

/**
 * Resolve an existing PR for `head`, in ANY state.
 *
 * `state=all` is load-bearing, not a widening for its own sake (task 62 D18-1). The
 * caller reaches this only after real GitHub 422'd a duplicate open. On a
 * crash/replay of `pushOpenMergeBasePr` AFTER the base PR was opened *and merged* —
 * precisely what `scaffold-project.e2e.ts`'s crash/replay proof exercises, and what
 * any retried step can hit — the PR is `closed`, so a `state=open` lookup returned
 * nothing and the 422 was re-thrown as a PERMANENT {@link GithubRestError}, killing a
 * fully recoverable workflow. Querying every state makes the open genuinely
 * idempotent. The `head=<owner>:<branch>` filter keeps it precise, so widening the
 * state cannot resolve an unrelated PR.
 */
async function findPrByHead(
  cfg: GithubRestConfig,
  owner: string,
  repo: string,
  head: string,
): Promise<OpenedPr | null> {
  const fetchImpl = cfg.fetchImpl ?? fetch;
  const url =
    `${trimSlash(cfg.apiBaseUrl)}/repos/${owner}/${repo}/pulls` +
    `?head=${owner}:${head}&state=all`;
  // This lookup fails SOFT (a non-2xx yields `null`), which is exactly why it needs the
  // shared backoff as much as the open itself does (plan row 64): a THROTTLED lookup
  // would return `null`, making an idempotent replay indistinguishable from a genuine
  // "No commits between" 422 — re-introducing, via a rate limit, the very
  // recoverable-workflow kill that D18-1 fixed.
  const res = await retrying(cfg, () =>
    fetchImpl(url, { headers: authHeaders(cfg.token) }),
  );
  if (!res.ok) return null;
  const list = (await res.json()) as Array<{ number: number; html_url: string }>;
  const first = list[0];
  return first ? { number: first.number, url: first.html_url } : null;
}

/**
 * Open the base PR (`head` → `base`). Real GitHub returns 422 for a duplicate head
 * ("A pull request already exists"); we treat that as idempotent and resolve the
 * existing PR via {@link findPrByHead}.
 *
 * Since task 62 the e2e lanes run against REAL github.com (the github-stub is
 * deleted), so this path is exercised for real on every replay — it is NOT
 * production-only any more, and the old "the stub never emits 422" caveat is gone.
 * The OTHER real 422 — "No commits between <base> and <head>" — resolves no PR and
 * therefore still surfaces as a permanent, attributable {@link GithubRestError};
 * widening the lookup state must never swallow it.
 */
export async function openPullRequest(
  cfg: GithubRestConfig,
  args: {
    owner: string;
    repo: string;
    head: string;
    base: string;
    title: string;
    body: string;
  },
): Promise<OpenedPr> {
  const fetchImpl = cfg.fetchImpl ?? fetch;
  // `withGithubRetry` returns the final `Response` rather than throwing, so the 201 and
  // 422 branches below are untouched: 422 is never retryable, so a duplicate-head open
  // still reaches `findPrByHead` on attempt 1.
  const res = await retrying(cfg, () =>
    fetchImpl(`${trimSlash(cfg.apiBaseUrl)}/repos/${args.owner}/${args.repo}/pulls`, {
      method: "POST",
      headers: { ...authHeaders(cfg.token), "content-type": "application/json" },
      body: JSON.stringify({
        title: args.title,
        head: args.head,
        base: args.base,
        body: args.body,
      }),
    }),
  );

  if (res.status === 201) {
    const b = (await res.json()) as { number: number; html_url: string };
    return { number: b.number, url: b.html_url };
  }
  if (res.status === 422) {
    const existing = await findPrByHead(cfg, args.owner, args.repo, args.head);
    if (existing) return existing;
  }

  // Plan row 63 / D63.5. Until now this threw `open pull request failed: <status>`
  // WITHOUT ever reading the body, so three completely different real-GitHub 422s —
  // "base is invalid" (an unborn base ref), "No commits between <base> and <head>", and
  // "A pull request already exists" — produced byte-identical, unattributable messages.
  //
  // Discrimination is on the BODY (`errors[].field` / `errors[].code`), NEVER on the
  // status: the invariant above requires the "No commits between" 422 to keep surfacing
  // as a permanent, attributable failure, and a status-keyed rule cannot tell the two
  // apart. `code` is set for exactly one shape and left undefined for everything else,
  // so no classifier's behaviour changes: `isPermanentHttpStatus(422)` is still `true`
  // and both 422s still fail fast.
  //
  // The body is read HERE and only here — after the `findPrByHead` fallback, which uses
  // its own `Response` — because a `Response` body can be consumed only once.
  const envelope = await readErrorEnvelope(res);
  const detail = envelopeDetail(envelope);
  const unbornBase =
    res.status === 422 &&
    typeof envelope !== "string" &&
    (envelope.errors ?? []).some((e) => e.field === "base" && e.code === "invalid");
  throw new GithubRestError(
    `open pull request failed: ${res.status}` +
      (detail ? ` — ${detail}` : "") +
      (unbornBase
        ? ` (base ref "${args.base}" does not exist on ${args.owner}/${args.repo} — ` +
          `the repository has no commits on it yet)`
        : ""),
    res.status,
    unbornBase ? BASE_REF_UNBORN : undefined,
  );
}

/**
 * Merge the base PR (squash). Real GitHub returns 405 for an already-merged PR (the
 * retired task-9 stub returned 405 on a DOUBLE-merge for the same reason); we treat
 * 405 as an idempotent "already merged" success so a replayed merge is safe.
 * (Scaffold merges are clean fast-forwards, so a FIRST-attempt 405-for-conflict
 * cannot occur; a genuine 409 conflict would surface as a permanent GithubRestError.)
 */
export async function mergePullRequest(
  cfg: GithubRestConfig,
  args: { owner: string; repo: string; number: number; mergeMethod?: string },
): Promise<{ merged: boolean; sha?: string }> {
  const fetchImpl = cfg.fetchImpl ?? fetch;
  // 405 ("already merged") is a 4xx with no throttle signal, so it is never retryable and
  // the idempotent-replay branch below still runs on attempt 1.
  const res = await retrying(cfg, () =>
    fetchImpl(
      `${trimSlash(cfg.apiBaseUrl)}/repos/${args.owner}/${args.repo}/pulls/${args.number}/merge`,
      {
        method: "PUT",
        headers: { ...authHeaders(cfg.token), "content-type": "application/json" },
        body: JSON.stringify({ merge_method: args.mergeMethod ?? "squash" }),
      },
    ),
  );

  if (res.ok) {
    const b = (await res.json()) as { merged?: boolean; sha?: string };
    return { merged: b.merged ?? true, sha: b.sha };
  }
  if (res.status === 405) {
    return { merged: true }; // already merged (idempotent replay)
  }
  throw new GithubRestError(`merge pull request failed: ${res.status}`, res.status);
}
