import { describe, it, expect } from "vitest";
import { DEFAULT_GITHUB_MAX_ATTEMPTS } from "@supagloo/database-lib";
import {
  ensureRepoReachable,
  GithubRestError,
  isPermanentHttpStatus,
  MERGE_SHA_MAX_ATTEMPTS,
  openPullRequest,
  mergePullRequest,
  RepoUnreachableError,
} from "./github-rest";
import { retryUnlessPermanent } from "./retry";

// GitHub REST half of the git-ops flow, driven by an INJECTED fetch (the only
// thing mocked at the unit level — real network is unavailable in unit tests, and
// task 62 keeps it that way: the e2e lanes moved to REAL github.com, the unit lane
// keeps every mock/stub, per HARD RULE 5 / design-delta §10.6).
// Exercises: idempotent reachability across paginated Link pages; a typed,
// non-retryable RepoUnreachableError when the installation cannot reach the repo;
// PR open (incl. the 422-already-exists idempotent fallback that production hits
// but the retired github-stub never emitted); and merge with the 405-on-double-merge
// treated as an idempotent already-merged success.
//
// Task 62 / D18-1 adds the `state=all` block at the bottom: the failure modes that
// only REAL GitHub produces (a replayed open after the PR was already merged, the
// "No commits between" 422 variant, 403 + Retry-After, 429) are covered HERE with an
// injected fetch, never by pushing egress into a unit test.

const API = "http://github.test";
const cfgWith = (fetchImpl: typeof fetch) => ({
  apiBaseUrl: API,
  token: "ghs_stub_inst_42_1",
  fetchImpl,
});

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

/**
 * A cfg whose rate-limit backoff RECORDS its sleeps instead of taking them (plan row
 * 64). Every test that injects a retryable status — `429`, `5xx`, or a `403` carrying a
 * throttle signal — MUST use this: with the real timer the unit lane would honour a 60s
 * `Retry-After` for real, which is both a multi-minute suite and forbidden egress-shaped
 * behaviour (design-delta §10.6). The recorded array is also the assertion surface: it
 * is how a test proves the delay was HONOURED rather than merely skipped.
 */
function cfgWithSleep(fetchImpl: typeof fetch, sleeps: number[]) {
  return {
    ...cfgWith(fetchImpl),
    sleepImpl: async (ms: number) => {
      sleeps.push(ms);
    },
  };
}

describe("ensureRepoReachable", () => {
  it("returns ok when owner/repo is present, sending the installation token", async () => {
    const calls: Array<{ url: string; auth: string | null }> = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({
        url: String(url),
        auth: new Headers(init?.headers).get("authorization"),
      });
      return jsonResponse(200, {
        total_count: 1,
        repositories: [{ full_name: "acme/empty-one", name: "empty-one" }],
      });
    }) as unknown as typeof fetch;

    const res = await ensureRepoReachable(cfgWith(fetchImpl), "acme", "empty-one");
    expect(res.fullName).toBe("acme/empty-one");
    expect(calls[0].url).toContain("/installation/repositories");
    // Must present the minted installation token (ghs_...), not an App JWT.
    expect(calls[0].auth).toMatch(/ghs_/);
  });

  it("follows Link rel=next pagination to find a repo on a later page", async () => {
    const fetchImpl = (async (url: string | URL | Request) => {
      const u = new URL(String(url));
      const page = Number(u.searchParams.get("page") ?? "1");
      if (page === 1) {
        return jsonResponse(
          200,
          { repositories: [{ full_name: "acme/other" }] },
          { link: `<${API}/installation/repositories?page=2>; rel="next"` },
        );
      }
      return jsonResponse(200, { repositories: [{ full_name: "acme/empty-one" }] });
    }) as unknown as typeof fetch;

    const res = await ensureRepoReachable(cfgWith(fetchImpl), "acme", "empty-one");
    expect(res.fullName).toBe("acme/empty-one");
  });

  it("throws a NON-retryable RepoUnreachableError when the repo is not in the installation", async () => {
    const fetchImpl = (async () =>
      jsonResponse(200, { repositories: [{ full_name: "acme/other" }] })) as unknown as typeof fetch;

    await expect(
      ensureRepoReachable(cfgWith(fetchImpl), "acme", "missing"),
    ).rejects.toBeInstanceOf(RepoUnreachableError);
  });

  it("throws (retryable, not RepoUnreachableError) on a 5xx list failure", async () => {
    // plan row 64: a 5xx is retryable in-client, so this MUST use `cfgWithSleep` — with
    // the real timer it would spend ~3.5s actually waiting inside a unit test.
    const sleeps: number[] = [];
    const fetchImpl = (async () =>
      jsonResponse(503, { message: "unavailable" })) as unknown as typeof fetch;

    const err = await ensureRepoReachable(
      cfgWithSleep(fetchImpl, sleeps),
      "acme",
      "empty-one",
    ).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(RepoUnreachableError);
  });
});

describe("openPullRequest", () => {
  it("POSTs {title,head,base} and parses number + html_url", async () => {
    let sentBody: unknown;
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toContain("/repos/acme/empty-one/pulls");
      expect(init?.method).toBe("POST");
      sentBody = JSON.parse(String(init?.body));
      return jsonResponse(201, {
        number: 7,
        html_url: "http://github.test/acme/empty-one/pull/7",
        state: "open",
      });
    }) as unknown as typeof fetch;

    const pr = await openPullRequest(cfgWith(fetchImpl), {
      owner: "acme",
      repo: "empty-one",
      head: "v0.0.0",
      base: "main",
      title: "Initial Supagloo scaffold (v0.0.0)",
      body: "scaffold",
    });
    expect(pr).toEqual({ number: 7, url: "http://github.test/acme/empty-one/pull/7" });
    expect(sentBody).toMatchObject({ head: "v0.0.0", base: "main" });
  });

  it("treats a 422 already-exists as idempotent, resolving the existing PR via a lookup", async () => {
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      if (init?.method === "POST") {
        return jsonResponse(422, {
          message: "Validation Failed",
          errors: [{ message: "A pull request already exists for acme:v0.0.0." }],
        });
      }
      // GET existing open PR for head.
      return jsonResponse(200, [
        { number: 7, html_url: "http://github.test/acme/empty-one/pull/7" },
      ]);
    }) as unknown as typeof fetch;

    const pr = await openPullRequest(cfgWith(fetchImpl), {
      owner: "acme",
      repo: "empty-one",
      head: "v0.0.0",
      base: "main",
      title: "t",
      body: "b",
    });
    expect(pr.number).toBe(7);
  });
});

describe("mergePullRequest", () => {
  it("PUTs a squash merge and returns the merge sha, with NO follow-up read", async () => {
    const urls: string[] = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      urls.push(String(url));
      expect(String(url)).toContain("/repos/acme/empty-one/pulls/7/merge");
      expect(init?.method).toBe("PUT");
      expect(JSON.parse(String(init?.body))).toMatchObject({ merge_method: "squash" });
      return jsonResponse(200, { merged: true, sha: "abc123" });
    }) as unknown as typeof fetch;

    const res = await mergePullRequest(cfgWith(fetchImpl), {
      owner: "acme",
      repo: "empty-one",
      number: 7,
    });
    expect(res.merged).toBe(true);
    expect(res.sha).toBe("abc123");
    // Plan row 50 item (1): the re-fetch is reached ONLY when the merge response could
    // not carry a sha. A 200 already has one, so the happy path costs zero extra calls.
    expect(urls).toHaveLength(1);
  });
});

/**
 * Plan row 50 item (1) / D50.1 + D50.2 — the TRUE merge-commit sha on the idempotent
 * `405 already-merged` replay path.
 *
 * Until now `mergePullRequest` returned `{ merged: true }` with NO sha there, and both
 * call sites papered over it with `merged.sha ?? <pre-merge branch tip>`
 * (`scaffold-project.ts` → `baseSha`, `publish-version.ts` → `workingHead`). Under a
 * SQUASH merge the merge commit is a brand-new commit, so that fallback is wrong every
 * time it fires — and the wrong value is not transient: it becomes the release tag's
 * target AND the permanently stored `ProjectVersion.headCommitSha`. design-delta
 * §11.5:2235-2239 names the class ("on a merged PR, re-read — never fall back to a stale
 * value"); §11.6:2263-2269's `state=open` → `state=all` fix was the second instance.
 *
 * D50.1: the re-fetch lives INSIDE this helper, not in a new DBOS step — a new step
 * would shift every downstream `functionID` and stale the existing crash/replay
 * step-count assertions. It is also unnecessary: the 405 branch is reached only when the
 * step is GENUINELY re-executing (a checkpointed step returns its memo and never calls
 * GitHub), so the in-helper re-fetch runs exactly when it is needed.
 *
 * D50.2: if the re-fetch cannot produce a `merge_commit_sha`, THROW. There is no
 * fallback to reintroduce.
 */
describe("mergePullRequest — 405 already-merged re-fetch (row 50 item 1)", () => {
  it("re-fetches the PR and returns its TRUE merge_commit_sha", async () => {
    const urls: string[] = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      urls.push(String(url));
      if (init?.method === "PUT") {
        return jsonResponse(405, { message: "Pull Request is not mergeable" });
      }
      return jsonResponse(200, {
        number: 7,
        merged: true,
        merge_commit_sha: "true-merge-sha",
      });
    }) as unknown as typeof fetch;

    const res = await mergePullRequest(cfgWith(fetchImpl), {
      owner: "acme",
      repo: "empty-one",
      number: 7,
    });
    expect(res.merged).toBe(true);
    expect(res.sha).toBe("true-merge-sha");
    // The follow-up read is the PR itself, not a list — precise, and unaffected by the
    // pulls index's near-real-time-but-not-transactional behaviour.
    expect(urls[1]).toContain("/repos/acme/empty-one/pulls/7");
    expect(urls[1]).not.toContain("/merge");
  });

  it("waits out GitHub's asynchronous merge_commit_sha population, bounded", async () => {
    // Real GitHub populates `merge_commit_sha` a moment AFTER the merge lands, so a
    // 200 whose value is still null is a WAIT, not a failure (§7.2 constraint 3).
    const sleeps: number[] = [];
    const shas: Array<string | null> = [null, null, "true-merge-sha"];
    let gets = 0;
    const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
      if (init?.method === "PUT") {
        return jsonResponse(405, { message: "Pull Request is not mergeable" });
      }
      return jsonResponse(200, { number: 7, merged: true, merge_commit_sha: shas[gets++] });
    }) as unknown as typeof fetch;

    const res = await mergePullRequest(cfgWithSleep(fetchImpl, sleeps), {
      owner: "acme",
      repo: "empty-one",
      number: 7,
    });
    expect(res.sha).toBe("true-merge-sha");
    expect(gets).toBe(3);
    // Honoured, not skipped — the recorded delays are the proof (plan row 64's technique).
    expect(sleeps).toEqual([500, 1_000]);
  });

  it("THROWS a permanent GithubRestError when the re-fetch 404s — never a fallback sha", async () => {
    const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
      if (init?.method === "PUT") {
        return jsonResponse(405, { message: "Pull Request is not mergeable" });
      }
      return jsonResponse(404, { message: "Not Found" });
    }) as unknown as typeof fetch;

    const err = await mergePullRequest(cfgWith(fetchImpl), {
      owner: "acme",
      repo: "empty-one",
      number: 7,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(GithubRestError);
    expect(err.status).toBe(404);
    expect(retryUnlessPermanent(err)).toBe(false);
  });

  it("THROWS (transiently) when merge_commit_sha never appears, after a bounded number of reads", async () => {
    const sleeps: number[] = [];
    let gets = 0;
    const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
      if (init?.method === "PUT") {
        return jsonResponse(405, { message: "Pull Request is not mergeable" });
      }
      gets += 1;
      return jsonResponse(200, { number: 7, merged: true, merge_commit_sha: null });
    }) as unknown as typeof fetch;

    const err = await mergePullRequest(cfgWithSleep(fetchImpl, sleeps), {
      owner: "acme",
      repo: "empty-one",
      number: 7,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(String(err.message)).toMatch(/merge commit sha/i);
    expect(gets).toBe(MERGE_SHA_MAX_ATTEMPTS);
    // Transient by classification: DBOS re-runs the whole step, which re-enters the 405
    // branch and reads again. That is the only correct recovery — a stale sha is not.
    expect(retryUnlessPermanent(err)).toBe(true);
  });

  /**
   * Step-11 item 2 (R4850-1) — `PUT /merge` returns **405 for two different states**:
   * "already merged" (the idempotent replay this branch exists for) and "not mergeable"
   * (an OPEN PR with a conflict, a failing required check, or a blocked branch
   * protection). GitHub's message text is the same string in both cases.
   *
   * On an OPEN pull request `merge_commit_sha` is not the merge commit at all — it is
   * GitHub's speculative **test-merge** commit under `refs/pull/N/merge`, which is not
   * reachable from the base branch and disappears when the PR is updated. Returning it
   * makes it the release tag's target and the permanently-stored
   * `ProjectVersion.headCommitSha` while the workflow reports SUCCESS: exactly the "green
   * lie" class D50.2 exists to forbid, one layer deeper than the fallback it removed.
   *
   * So the re-read must check `merged` (GitHub also sends `merged_at`), and a not-merged
   * PR is a PERMANENT failure — row 50's widened catch then records a truthful terminal
   * `ProjectJob.error` instead of shipping a wrong sha.
   */
  it("THROWS permanently on a 405 for an UNMERGED PR — never returns the test-merge sha", async () => {
    const sleeps: number[] = [];
    let gets = 0;
    const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
      if (init?.method === "PUT") {
        // Byte-identical to the already-merged 405 body: the status and the message
        // cannot distinguish the two states, which is the whole defect.
        return jsonResponse(405, { message: "Pull Request is not mergeable" });
      }
      gets += 1;
      return jsonResponse(200, {
        number: 7,
        state: "open",
        merged: false,
        merged_at: null,
        // `refs/pull/7/merge` — a real sha that is NOT on the base branch.
        merge_commit_sha: "test-merge-sha-not-on-main",
      });
    }) as unknown as typeof fetch;

    const err = await mergePullRequest(cfgWithSleep(fetchImpl, sleeps), {
      owner: "acme",
      repo: "empty-one",
      number: 7,
    }).catch((e) => e);

    expect(err).toBeInstanceOf(GithubRestError);
    expect(err.status).toBe(405);
    expect(String(err.message)).toMatch(/not merged/i);
    // The failure must name the PR so the recorded ProjectJob.error is actionable.
    expect(String(err.message)).toContain("acme/empty-one#7");
    // The poisoned value never escapes, in the message or as a return.
    expect(String(err.message)).not.toContain("test-merge-sha-not-on-main");
    // Permanent: re-reading an unmerged PR cannot make it merged, so burning the DBOS
    // step budget on it only delays the truthful terminal failure.
    expect(retryUnlessPermanent(err)).toBe(false);
    // Fails on the FIRST read — no bounded wait, no backoff. The wait exists only for
    // GitHub's asynchronous population of the sha on an actually-merged PR.
    expect(gets).toBe(1);
    expect(sleeps).toEqual([]);
  });

  it("still accepts the merged-405 replay when `merged_at` is set but `merged` is absent", async () => {
    // Defensive: the two fields are redundant on real GitHub, and keying off only one of
    // them would turn a legitimate idempotent replay into a permanent failure.
    const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
      if (init?.method === "PUT") {
        return jsonResponse(405, { message: "Pull Request is not mergeable" });
      }
      return jsonResponse(200, {
        number: 7,
        merged_at: "2026-07-27T00:00:00Z",
        merge_commit_sha: "true-merge-sha",
      });
    }) as unknown as typeof fetch;

    const res = await mergePullRequest(cfgWith(fetchImpl), {
      owner: "acme",
      repo: "empty-one",
      number: 7,
    });
    expect(res).toEqual({ merged: true, sha: "true-merge-sha" });
  });
});

// The retry-classification promised by the Task-17 plan: PR open / merge / repo-list
// failures throw a typed GithubRestError carrying the HTTP status, so a step's
// `shouldRetry` fails fast on permanent 4xx (bad credential / gone / forbidden) and
// still retries transient 5xx / 429 / network blips. The 422-already-exists and
// 405-already-merged idempotent paths above are unaffected — they are NOT failures.
describe("failure classification (permanent vs transient)", () => {
  it("isPermanentHttpStatus: 4xx except 429 are permanent; 5xx and 429 are transient", () => {
    // plan row 64 / D64.1 — THIS TABLE IS UNCHANGED ON PURPOSE, and `403 ⇒ permanent`
    // in particular is the load-bearing entry. The client now honours a secondary-limit
    // `403 + Retry-After` in-process (see `withGithubRetry` below), so by the time an
    // error reaches this classifier the delay has ALREADY been waited out up to the
    // client's bounded budget. Re-classifying 403 as transient here would stack the DBOS
    // step budget on top of that — and it structurally cannot help anyway: the step
    // budget is `{maxAttempts: 4, intervalSeconds: 1, backoffRate: 2}` ≈ 7s total,
    // against a secondary-limit `Retry-After` that is typically 60s. Four more attempts
    // in 7s honour nothing; they just burn the budget and fail anyway.
    //
    // `429` stays TRANSIENT because a primary rate limit is worth a durable, out-of-
    // process re-attempt that a workflow can survive a crash across.
    expect(isPermanentHttpStatus(400)).toBe(true);
    expect(isPermanentHttpStatus(401)).toBe(true);
    expect(isPermanentHttpStatus(403)).toBe(true);
    expect(isPermanentHttpStatus(404)).toBe(true);
    expect(isPermanentHttpStatus(422)).toBe(true);
    expect(isPermanentHttpStatus(429)).toBe(false); // rate-limit → transient
    expect(isPermanentHttpStatus(500)).toBe(false);
    expect(isPermanentHttpStatus(502)).toBe(false);
    expect(isPermanentHttpStatus(503)).toBe(false);
  });

  it("openPullRequest throws a PERMANENT GithubRestError on a BARE 403, with no retry (shouldRetry → false)", async () => {
    // plan row 64: a 403 with NO throttle header is a genuine permission denial, and
    // §11.3:1832-1834 makes that an EXPECTED behaviour of the credential split (the
    // installation deliberately holds no `administration` scope). It must fail on the
    // first attempt — no sleep, no second request.
    const sleeps: number[] = [];
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return jsonResponse(403, { message: "Forbidden" });
    }) as unknown as typeof fetch;
    const err = await openPullRequest(cfgWithSleep(fetchImpl, sleeps), {
      owner: "acme",
      repo: "empty-one",
      head: "v0.0.0",
      base: "main",
      title: "t",
      body: "b",
    }).catch((e) => e);
    expect(err).toBeInstanceOf(GithubRestError);
    expect(err.status).toBe(403);
    expect(retryUnlessPermanent(err)).toBe(false);
    expect(calls).toBe(1);
    expect(sleeps).toEqual([]);
  });

  it("openPullRequest throws a TRANSIENT GithubRestError on 500, after the client's own bounded backoff", async () => {
    // plan row 64: a 5xx is retryable in-client too, so the COUNT here moved from 1 to
    // the client budget. The CLASSIFICATION did not: an upstream outage that outlives
    // the client's ~3.5s of backoff is still worth a durable DBOS step retry.
    const sleeps: number[] = [];
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return jsonResponse(500, { message: "boom" });
    }) as unknown as typeof fetch;
    const err = await openPullRequest(cfgWithSleep(fetchImpl, sleeps), {
      owner: "acme",
      repo: "empty-one",
      head: "v0.0.0",
      base: "main",
      title: "t",
      body: "b",
    }).catch((e) => e);
    expect(err).toBeInstanceOf(GithubRestError);
    expect(err.status).toBe(500);
    expect(retryUnlessPermanent(err)).toBe(true);
    expect(calls).toBe(DEFAULT_GITHUB_MAX_ATTEMPTS);
    // No throttle headers ⇒ the blind exponential fallback, capped at 30s.
    expect(sleeps).toEqual([500, 1_000, 2_000]);
  });

  it("mergePullRequest throws a PERMANENT GithubRestError on 404 (shouldRetry → false)", async () => {
    const fetchImpl = (async () =>
      jsonResponse(404, { message: "Not Found" })) as unknown as typeof fetch;
    const err = await mergePullRequest(cfgWith(fetchImpl), {
      owner: "acme",
      repo: "empty-one",
      number: 7,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(GithubRestError);
    expect(err.status).toBe(404);
    expect(retryUnlessPermanent(err)).toBe(false);
  });

  it("mergePullRequest throws a TRANSIENT GithubRestError on 503 (shouldRetry → true)", async () => {
    const sleeps: number[] = [];
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return jsonResponse(503, { message: "unavailable" });
    }) as unknown as typeof fetch;
    const err = await mergePullRequest(cfgWithSleep(fetchImpl, sleeps), {
      owner: "acme",
      repo: "empty-one",
      number: 7,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(GithubRestError);
    expect(retryUnlessPermanent(err)).toBe(true);
    expect(calls).toBe(DEFAULT_GITHUB_MAX_ATTEMPTS);
  });

  it("ensureRepoReachable throws a PERMANENT GithubRestError on a 401 list failure, first attempt", async () => {
    const sleeps: number[] = [];
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return jsonResponse(401, { message: "Bad credentials" });
    }) as unknown as typeof fetch;
    const err = await ensureRepoReachable(
      cfgWithSleep(fetchImpl, sleeps),
      "acme",
      "empty-one",
    ).catch((e) => e);
    expect(err).toBeInstanceOf(GithubRestError);
    expect(err.status).toBe(401);
    expect(retryUnlessPermanent(err)).toBe(false);
    // A bad credential is deterministic: retrying it is pure latency.
    expect(calls).toBe(1);
    expect(sleeps).toEqual([]);
  });

  it("ensureRepoReachable retries a 403 + Retry-After mid-pagination and completes the walk", async () => {
    // plan row 64: the reachability check walks `Link: rel=next`, and a throttle can
    // land on ANY page. Backing off must resume the walk, not restart or truncate it —
    // a truncated walk would report a perfectly reachable repo as unreachable, which
    // `retryUnlessPermanent` classifies PERMANENT and would kill the workflow.
    const sleeps: number[] = [];
    let page2Attempts = 0;
    const fetchImpl = (async (url: string | URL | Request) => {
      const u = String(url);
      if (!u.includes("page=2")) {
        return jsonResponse(
          200,
          { total_count: 2, repositories: [{ full_name: "acme/other" }] },
          { link: `<${API}/installation/repositories?per_page=100&page=2>; rel="next"` },
        );
      }
      page2Attempts += 1;
      if (page2Attempts === 1) {
        return jsonResponse(
          403,
          { message: "You have exceeded a secondary rate limit" },
          { "retry-after": "9" },
        );
      }
      return jsonResponse(200, {
        total_count: 2,
        repositories: [{ full_name: "acme/empty-one" }],
      });
    }) as unknown as typeof fetch;

    const res = await ensureRepoReachable(
      cfgWithSleep(fetchImpl, sleeps),
      "acme",
      "empty-one",
    );
    expect(res.fullName).toBe("acme/empty-one");
    expect(page2Attempts).toBe(2);
    expect(sleeps).toEqual([9_000]);
  });
});

// ---------------------------------------------------------------------------
// Task 62 / D18-1: the real-GitHub replay path.
//
// `openPullRequest`'s 422 fallback looked the existing PR up with `state=open`. On a
// crash/replay AFTER the base PR was opened AND merged (exactly what
// `scaffold-project.e2e.ts`'s crash/replay proof does, and what any retried
// `pushOpenMergeBasePr` does), real GitHub 422s the re-open, the `state=open` lookup
// finds NOTHING (the PR is closed), and the 422 is re-thrown as a PERMANENT
// GithubRestError — killing an otherwise recoverable workflow. The retired
// github-stub never emitted 422, so this was invisible.
//
// The fix is `state=all`. These tests pin it.
// ---------------------------------------------------------------------------
describe("openPullRequest — idempotent replay against REAL GitHub (D18-1)", () => {
  /** A fetch that behaves like real GitHub for an already-opened-and-MERGED head. */
  function alreadyMergedFetch(record: { lookupUrls: string[] }) {
    return (async (url: string | URL | Request, init?: RequestInit) => {
      if (init?.method === "POST") {
        return jsonResponse(422, {
          message: "Validation Failed",
          errors: [{ message: "A pull request already exists for acme:v0.0.0." }],
        });
      }
      const u = String(url);
      record.lookupUrls.push(u);
      const state = new URL(u).searchParams.get("state");
      // Real GitHub: a MERGED pr is `closed`, so a state=open query returns [].
      if (state === "open") return jsonResponse(200, []);
      return jsonResponse(200, [
        {
          number: 7,
          html_url: "https://github.com/acme/empty-one/pull/7",
          state: "closed",
          merged_at: "2026-07-25T00:00:00Z",
        },
      ]);
    }) as unknown as typeof fetch;
  }

  const openArgs = {
    owner: "acme",
    repo: "empty-one",
    head: "v0.0.0",
    base: "main",
    title: "Initial Supagloo scaffold (v0.0.0)",
    body: "scaffold",
  };

  it("looks the existing PR up with state=all, never state=open", async () => {
    const record = { lookupUrls: [] as string[] };
    await openPullRequest(cfgWith(alreadyMergedFetch(record)), openArgs).catch(() => {});
    expect(record.lookupUrls.length).toBeGreaterThan(0);
    const params = new URL(record.lookupUrls[0]).searchParams;
    expect(params.get("state")).toBe("all");
    expect(record.lookupUrls[0]).not.toContain("state=open");
    // The head filter must survive the change — it is what makes the lookup precise.
    expect(params.get("head")).toBe("acme:v0.0.0");
  });

  it("resolves the ALREADY-MERGED pull request instead of throwing (crash/replay safe)", async () => {
    const record = { lookupUrls: [] as string[] };
    const pr = await openPullRequest(cfgWith(alreadyMergedFetch(record)), openArgs);
    expect(pr.number).toBe(7);
    expect(pr.url).toBe("https://github.com/acme/empty-one/pull/7");
  });

  it("still throws a typed 422 when the 422 is the 'No commits between' variant (no PR exists)", async () => {
    // Real GitHub's other 422 on POST /pulls: head == base content-wise. There is no
    // PR to resolve, so this must stay a permanent, attributable failure — the
    // state=all widening must NOT swallow it.
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      if (init?.method === "POST") {
        return jsonResponse(422, {
          message: "Validation Failed",
          errors: [{ message: "No commits between main and v0.0.0" }],
        });
      }
      return jsonResponse(200, []);
    }) as unknown as typeof fetch;

    const err = await openPullRequest(cfgWith(fetchImpl), openArgs).catch((e) => e);
    expect(err).toBeInstanceOf(GithubRestError);
    expect(err.status).toBe(422);
    expect(retryUnlessPermanent(err)).toBe(false);
  });

  it("honours a real 403 + Retry-After IN-CLIENT, and — if it never clears — still surfaces a PERMANENT typed error", async () => {
    // TOMBSTONE REPLACED (plan row 64 / D64.8). This test used to be
    // *"surfaces a real 403 + Retry-After as a PERMANENT typed error with NO client-side
    // retry (plan row N2)"* with `expect(calls).toBe(1)`; its body named row N2 as the
    // future contract change. This IS row N2 (plan row 64), so the body is replaced
    // rather than extended, and the row-N2 note is gone.
    //
    // The new contract is the TWO-LAYER RULE (D64.1), and both halves are asserted here
    // because they only make sense together:
    //   1. the CLIENT sleeps — it honours GitHub's own `Retry-After` with a bounded,
    //      capped budget, which is the only layer that CAN honour a 60s delay; and
    //   2. the CLASSIFIER still says PERMANENT — so the DBOS step budget (~7s) does not
    //      stack four more useless attempts on top of the delay the client already
    //      waited out.
    // Weakening either half re-opens the bug the other half exists to prevent.
    const sleeps: number[] = [];
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return jsonResponse(
        403,
        { message: "You have exceeded a secondary rate limit" },
        { "retry-after": "37" },
      );
    }) as unknown as typeof fetch;

    const err = await openPullRequest(cfgWithSleep(fetchImpl, sleeps), openArgs).catch(
      (e) => e,
    );
    expect(err).toBeInstanceOf(GithubRestError);
    expect(err.status).toBe(403);
    // (1) the delay was honoured, once per gap in the budget, at GitHub's own value.
    expect(calls).toBe(DEFAULT_GITHUB_MAX_ATTEMPTS);
    expect(sleeps).toEqual([37_000, 37_000, 37_000]);
    // (2) and the two layers still do not multiply.
    expect(retryUnlessPermanent(err)).toBe(false);
  });

  it("honours a 403 + Retry-After that CLEARS, and opens the PR on the retry", async () => {
    // The other half of the acceptance: "honors the delay then retries" has to actually
    // SUCCEED, not merely delay the same failure.
    const sleeps: number[] = [];
    let calls = 0;
    const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
      if (init?.method !== "POST") return jsonResponse(200, []);
      calls += 1;
      if (calls === 1) {
        return jsonResponse(
          403,
          { message: "You have exceeded a secondary rate limit" },
          { "retry-after": "12" },
        );
      }
      return jsonResponse(201, {
        number: 11,
        html_url: "https://github.com/acme/empty-one/pull/11",
      });
    }) as unknown as typeof fetch;

    const pr = await openPullRequest(cfgWithSleep(fetchImpl, sleeps), openArgs);
    expect(pr.number).toBe(11);
    expect(calls).toBe(2);
    expect(sleeps).toEqual([12_000]);
  });

  it("retries the 422 fallback LOOKUP too, so a throttle cannot fake 'no existing PR'", async () => {
    // The D18-1 replay path depends on `findPrByHead` ANSWERING. A throttled lookup
    // returns `null` (it fails soft by design), which makes an idempotent replay look
    // like a genuine "No commits between" 422 — a PERMANENT error that kills a fully
    // recoverable workflow. That is precisely the bug D18-1 fixed, re-introduced by a
    // rate limit. So the lookup gets the same bounded backoff as everything else.
    const sleeps: number[] = [];
    let lookups = 0;
    const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
      if (init?.method === "POST") {
        return jsonResponse(422, {
          message: "Validation Failed",
          errors: [{ message: "A pull request already exists for acme:v0.0.0." }],
        });
      }
      lookups += 1;
      if (lookups === 1) {
        return jsonResponse(429, { message: "Too Many Requests" }, { "retry-after": "4" });
      }
      return jsonResponse(200, [
        { number: 7, html_url: "https://github.com/acme/empty-one/pull/7" },
      ]);
    }) as unknown as typeof fetch;

    const pr = await openPullRequest(cfgWithSleep(fetchImpl, sleeps), openArgs);
    expect(pr.number).toBe(7);
    expect(lookups).toBe(2);
    expect(sleeps).toEqual([4_000]);
  });

  // ------------------------------------------------------------- plan row 63 / D63.5
  // Until now `openPullRequest` threw `open pull request failed: 422` WITHOUT ever
  // reading the response body, so three completely different real-GitHub 422s —
  // "base is invalid" (an unborn `main`), "No commits between <base> and <head>", and
  // "A pull request already exists" — produced byte-identical messages and were
  // therefore unattributable in a log or a job's `error` column.
  //
  // Discrimination is on the BODY (`errors[].field` / `errors[].code`), never on the
  // status: the standing invariant above ("widening the lookup state must never
  // swallow the no-commits-between 422") means status alone cannot tell them apart.
  it("openPullRequest surfaces a typed unborn-base-ref error when GitHub 422s with field=base, code=invalid", async () => {
    const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
      if (init?.method === "POST") {
        return jsonResponse(422, {
          message: "Validation Failed",
          errors: [{ resource: "PullRequest", field: "base", code: "invalid" }],
          documentation_url:
            "https://docs.github.com/rest/pulls/pulls#create-a-pull-request",
        });
      }
      return jsonResponse(200, []); // findPrByHead resolves nothing
    }) as unknown as typeof fetch;

    const err = await openPullRequest(cfgWith(fetchImpl), openArgs).catch((e) => e);
    expect(err).toBeInstanceOf(GithubRestError);
    expect(err.status).toBe(422);
    expect(err.code).toBe("base_ref_unborn");
    expect(err.message).toContain("main");
  });

  it("does NOT classify the 'No commits between' 422 as unborn-base, and surfaces GitHub's own message", async () => {
    const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
      if (init?.method === "POST") {
        return jsonResponse(422, {
          message: "Validation Failed",
          errors: [
            {
              resource: "PullRequest",
              field: "base",
              code: "custom",
              message: "No commits between main and v0.0.0",
            },
          ],
        });
      }
      return jsonResponse(200, []);
    }) as unknown as typeof fetch;

    const err = await openPullRequest(cfgWith(fetchImpl), openArgs).catch((e) => e);
    expect(err).toBeInstanceOf(GithubRestError);
    expect(err.status).toBe(422);
    expect(err.code).toBeUndefined();
    expect(err.message).toContain("No commits between main and v0.0.0");
    expect(retryUnlessPermanent(err)).toBe(false);
  });

  it("classifies a real 429 as TRANSIENT so the DBOS step retries it with backoff", async () => {
    // plan row 64: the COUNT moved (1 → the client's bounded budget) because the client
    // now backs off first; the CLASSIFICATION is unchanged and deliberate. A primary
    // rate limit that outlives the in-process budget is worth a durable, crash-safe
    // DBOS step retry — unlike a 403, where the two layers would stack for nothing.
    const sleeps: number[] = [];
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return jsonResponse(429, { message: "Too Many Requests" }, { "retry-after": "60" });
    }) as unknown as typeof fetch;

    const err = await openPullRequest(cfgWithSleep(fetchImpl, sleeps), openArgs).catch(
      (e) => e,
    );
    expect(err).toBeInstanceOf(GithubRestError);
    expect(err.status).toBe(429);
    expect(retryUnlessPermanent(err)).toBe(true);
    expect(calls).toBe(DEFAULT_GITHUB_MAX_ATTEMPTS);
    expect(sleeps).toEqual([60_000, 60_000, 60_000]);
  });

  it("caps the honoured delay at 60s even when GitHub asks for an hour (D64.6)", async () => {
    // A `Retry-After: 3600` taken literally would hold a `ProjectJob` in `running` for an
    // hour per attempt, and §2.9's git-ops guard 409s any retry-from-UI for that whole
    // window. The cap is what bounds it.
    const sleeps: number[] = [];
    const fetchImpl = (async () =>
      jsonResponse(
        429,
        { message: "Too Many Requests" },
        { "retry-after": "3600" },
      )) as unknown as typeof fetch;

    await openPullRequest(cfgWithSleep(fetchImpl, sleeps), openArgs).catch(() => {});
    expect(sleeps).toEqual([60_000, 60_000, 60_000]);
  });
});
