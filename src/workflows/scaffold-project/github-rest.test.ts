import { describe, it, expect } from "vitest";
import {
  ensureRepoReachable,
  GithubRestError,
  isPermanentHttpStatus,
  openPullRequest,
  mergePullRequest,
  RepoUnreachableError,
} from "./github-rest";
import { retryUnlessPermanent } from "./retry";

// GitHub REST half of the git-ops flow, driven by an INJECTED fetch (the only
// thing mocked at the unit level — real network is unavailable in unit tests).
// Exercises: idempotent reachability across paginated Link pages; a typed,
// non-retryable RepoUnreachableError when the installation cannot reach the repo;
// PR open (incl. the 422-already-exists idempotent fallback that production hits
// but the stub never emits); and merge with the stub's 405-on-double-merge treated
// as an idempotent already-merged success.

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
    const fetchImpl = (async () =>
      jsonResponse(503, { message: "unavailable" })) as unknown as typeof fetch;

    const err = await ensureRepoReachable(cfgWith(fetchImpl), "acme", "empty-one").catch(
      (e) => e,
    );
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
  it("PUTs a squash merge and returns the merge sha", async () => {
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
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
  });

  it("treats the stub's 405 double-merge as an idempotent already-merged success", async () => {
    const fetchImpl = (async () =>
      jsonResponse(405, { message: "Pull Request is not mergeable" })) as unknown as typeof fetch;

    const res = await mergePullRequest(cfgWith(fetchImpl), {
      owner: "acme",
      repo: "empty-one",
      number: 7,
    });
    expect(res.merged).toBe(true);
  });
});

// The retry-classification promised by the Task-17 plan: PR open / merge / repo-list
// failures throw a typed GithubRestError carrying the HTTP status, so a step's
// `shouldRetry` fails fast on permanent 4xx (bad credential / gone / forbidden) and
// still retries transient 5xx / 429 / network blips. The 422-already-exists and
// 405-already-merged idempotent paths above are unaffected — they are NOT failures.
describe("failure classification (permanent vs transient)", () => {
  it("isPermanentHttpStatus: 4xx except 429 are permanent; 5xx and 429 are transient", () => {
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

  it("openPullRequest throws a PERMANENT GithubRestError on 403 (shouldRetry → false)", async () => {
    const fetchImpl = (async () =>
      jsonResponse(403, { message: "Forbidden" })) as unknown as typeof fetch;
    const err = await openPullRequest(cfgWith(fetchImpl), {
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
  });

  it("openPullRequest throws a TRANSIENT GithubRestError on 500 (shouldRetry → true)", async () => {
    const fetchImpl = (async () =>
      jsonResponse(500, { message: "boom" })) as unknown as typeof fetch;
    const err = await openPullRequest(cfgWith(fetchImpl), {
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
    const fetchImpl = (async () =>
      jsonResponse(503, { message: "unavailable" })) as unknown as typeof fetch;
    const err = await mergePullRequest(cfgWith(fetchImpl), {
      owner: "acme",
      repo: "empty-one",
      number: 7,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(GithubRestError);
    expect(retryUnlessPermanent(err)).toBe(true);
  });

  it("ensureRepoReachable throws a PERMANENT GithubRestError on a 401 list failure", async () => {
    const fetchImpl = (async () =>
      jsonResponse(401, { message: "Bad credentials" })) as unknown as typeof fetch;
    const err = await ensureRepoReachable(cfgWith(fetchImpl), "acme", "empty-one").catch(
      (e) => e,
    );
    expect(err).toBeInstanceOf(GithubRestError);
    expect(err.status).toBe(401);
    expect(retryUnlessPermanent(err)).toBe(false);
  });
});
