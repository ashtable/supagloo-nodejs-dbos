import { describe, it, expect } from "vitest";
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

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
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
    const fetchImpl = (async () =>
      jsonResponse(500, { message: "boom" })) as unknown as typeof fetch;
    const err = await createTag(cfgWith(fetchImpl), {
      owner: "acme",
      repo: "psalm-91",
      semver: "0.0.1",
      sha: "c".repeat(40),
    }).catch((e) => e);
    expect(err).toBeInstanceOf(GithubRestError);
    expect(err.status).toBe(500);
    expect(retryUnlessPermanent(err)).toBe(true);
  });

  it("throws a PERMANENT GithubRestError on 403 (shouldRetry → false)", async () => {
    const fetchImpl = (async () =>
      jsonResponse(403, { message: "Forbidden" })) as unknown as typeof fetch;
    const err = await createTag(cfgWith(fetchImpl), {
      owner: "acme",
      repo: "psalm-91",
      semver: "0.0.1",
      sha: "d".repeat(40),
    }).catch((e) => e);
    expect(err).toBeInstanceOf(GithubRestError);
    expect(err.status).toBe(403);
    expect(retryUnlessPermanent(err)).toBe(false);
  });
});
