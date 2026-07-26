import { describe, it, expect } from "vitest";
import { DEFAULT_GITHUB_MAX_ATTEMPTS } from "@supagloo/database-lib";
import { GithubRestError } from "../scaffold-project/github-rest";
import { retryUnlessPermanent } from "../scaffold-project/retry";
import { createTag } from "./github-rest";

// Publish adds ONE new GitHub REST helper on top of scaffold's openPullRequest /
// mergePullRequest (which publish reuses as-is): createTag, which stamps the release tag
// via `POST /repos/:owner/:repo/git/refs`. Driven by an INJECTED fetch (the only thing
// mocked at the unit level). Exercises: the correct ref (`refs/tags/v<semver>`) + sha
// payload; the 422-already-exists idempotent success (a replayed tag is safe); and the
// permanent-vs-transient classification shared with every other git-ops REST step.

const API = "http://github.test";
const cfgWith = (fetchImpl: typeof fetch) => ({
  apiBaseUrl: API,
  token: "ghs_stub_inst_42_1",
  fetchImpl,
});

function jsonResponse(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

/** plan row 64: record the backoff instead of taking it — the unit lane never waits. */
function cfgWithSleep(fetchImpl: typeof fetch, sleeps: number[]) {
  return {
    ...cfgWith(fetchImpl),
    sleepImpl: async (ms: number) => {
      sleeps.push(ms);
    },
  };
}

describe("createTag", () => {
  it("POSTs refs/tags/v<semver> + sha to git/refs and returns the created ref", async () => {
    let sentUrl = "";
    let sentBody: any;
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      sentUrl = String(url);
      expect(init?.method).toBe("POST");
      sentBody = JSON.parse(String(init?.body));
      return jsonResponse(201, {
        ref: sentBody.ref,
        object: { sha: sentBody.sha, type: "commit" },
      });
    }) as unknown as typeof fetch;

    const res = await createTag(cfgWith(fetchImpl), {
      owner: "acme",
      repo: "psalm-91",
      semver: "0.0.1",
      sha: "a".repeat(40),
    });

    expect(sentUrl).toContain("/repos/acme/psalm-91/git/refs");
    expect(sentBody).toEqual({ ref: "refs/tags/v0.0.1", sha: "a".repeat(40) });
    expect(res.ref).toBe("refs/tags/v0.0.1");
  });

  it("treats a 422 already-exists as an idempotent success (replayed tag is safe)", async () => {
    const fetchImpl = (async () =>
      jsonResponse(422, {
        message: "Reference already exists",
      })) as unknown as typeof fetch;

    const res = await createTag(cfgWith(fetchImpl), {
      owner: "acme",
      repo: "psalm-91",
      semver: "0.0.1",
      sha: "b".repeat(40),
    });
    expect(res.ref).toBe("refs/tags/v0.0.1");
  });

  it("throws a TRANSIENT GithubRestError on 500 (shouldRetry → true)", async () => {
    // plan row 64: the client backs a 5xx off first, so the COUNT is the bounded budget;
    // the classification is unchanged.
    const sleeps: number[] = [];
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return jsonResponse(500, { message: "boom" });
    }) as unknown as typeof fetch;
    const err = await createTag(cfgWithSleep(fetchImpl, sleeps), {
      owner: "acme",
      repo: "psalm-91",
      semver: "0.0.1",
      sha: "c".repeat(40),
    }).catch((e) => e);
    expect(err).toBeInstanceOf(GithubRestError);
    expect(err.status).toBe(500);
    expect(retryUnlessPermanent(err)).toBe(true);
    expect(calls).toBe(DEFAULT_GITHUB_MAX_ATTEMPTS);
    expect(sleeps).toEqual([500, 1_000, 2_000]);
  });

  it("throws a PERMANENT GithubRestError on a BARE 403, on the first attempt (shouldRetry → false)", async () => {
    const sleeps: number[] = [];
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return jsonResponse(403, { message: "Forbidden" });
    }) as unknown as typeof fetch;
    const err = await createTag(cfgWithSleep(fetchImpl, sleeps), {
      owner: "acme",
      repo: "psalm-91",
      semver: "0.0.1",
      sha: "d".repeat(40),
    }).catch((e) => e);
    expect(err).toBeInstanceOf(GithubRestError);
    expect(err.status).toBe(403);
    expect(retryUnlessPermanent(err)).toBe(false);
    expect(calls).toBe(1);
    expect(sleeps).toEqual([]);
  });

  // ------------------------------------------------------------- plan row 64 / D64.1
  // `createTag` imports `GithubRestError` from the scaffold module ON PURPOSE, so it
  // inherits the shared permanent-vs-transient classifier. Row 64 extends that sharing
  // to the BACKOFF: the same `withGithubRetry` primitive, the same bounded budget, the
  // same injected sleep. What must NOT be shared away is this function's live
  // 422-is-not-an-error branch.
  it("honours a 403 + Retry-After with client-side backoff, then creates the tag", async () => {
    const sleeps: number[] = [];
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      if (calls === 1) {
        return jsonResponse(
          403,
          { message: "You have exceeded a secondary rate limit" },
          { "retry-after": "23" },
        );
      }
      return jsonResponse(201, { ref: "refs/tags/v0.0.1" });
    }) as unknown as typeof fetch;

    const res = await createTag(cfgWithSleep(fetchImpl, sleeps), {
      owner: "acme",
      repo: "psalm-91",
      semver: "0.0.1",
      sha: "e".repeat(40),
    });
    expect(res.ref).toBe("refs/tags/v0.0.1");
    expect(calls).toBe(2);
    expect(sleeps).toEqual([23_000]);
  });

  it("still treats 201 as created and 422 as the existing-tag branch, with NO retry on either", async () => {
    // [GUARD, not RED] — the branch a generic retry wrapper is most likely to swallow.
    // 201 is a success and 422 is an IDEMPOTENT success (a replayed tag), so neither may
    // enter the retry loop: a retried 201 would double-request, and a retried 422 would
    // turn `publish-version.e2e.ts`'s crash/replay proof into four pointless requests
    // and three sleeps before reaching the same answer.
    for (const status of [201, 422] as const) {
      const sleeps: number[] = [];
      let calls = 0;
      const fetchImpl = (async () => {
        calls += 1;
        return jsonResponse(status, {
          ref: "refs/tags/v0.0.1",
          message: "Reference already exists",
        });
      }) as unknown as typeof fetch;

      const res = await createTag(cfgWithSleep(fetchImpl, sleeps), {
        owner: "acme",
        repo: "psalm-91",
        semver: "0.0.1",
        sha: "f".repeat(40),
      });
      expect(res.ref).toBe("refs/tags/v0.0.1");
      expect(calls).toBe(1);
      expect(sleeps).toEqual([]);
    }
  });
});
