import { GithubRestError } from "../scaffold-project/github-rest";

/**
 * The publish workflow's one NEW GitHub REST helper: create the release tag.
 *
 * Publish reuses scaffold's `openPullRequest` (422→idempotent lookup) and
 * `mergePullRequest` (405→idempotent already-merged) as-is; the only piece scaffold does not
 * have is a git-tag creator. Raw `fetch` + hand parsing (house style — no Octokit anywhere),
 * `fetchImpl` injectable for unit tests. On real GitHub a duplicate tag ref returns 422
 * "Reference already exists" — treated here as an idempotent success so a replayed
 * `mergePullRequestAndTag` step never fails on its own prior tag. The `GithubRestError`
 * (carrying the HTTP status) is imported from the scaffold module so the shared
 * permanent-vs-transient classifier (`retryUnlessPermanent`) applies unchanged.
 */

export interface GithubRestConfig {
  apiBaseUrl: string;
  /** A minted installation token (`ghs_…`). */
  token: string;
  fetchImpl?: typeof fetch;
}

const trimSlash = (u: string) => u.replace(/\/+$/, "");

function authHeaders(token: string): Record<string, string> {
  return {
    authorization: `token ${token}`,
    accept: "application/vnd.github+json",
  };
}

export interface CreatedTag {
  ref: string;
}

/**
 * Create the annotated-style lightweight tag ref `refs/tags/v<semver>` pointing at `sha`
 * (the merge commit) via `POST /repos/:owner/:repo/git/refs`. 201 → the created ref; 422
 * already-exists → idempotent success (same ref); any other non-2xx → a typed
 * {@link GithubRestError} the step's `shouldRetry` classifies.
 */
export async function createTag(
  cfg: GithubRestConfig,
  args: { owner: string; repo: string; semver: string; sha: string },
): Promise<CreatedTag> {
  const fetchImpl = cfg.fetchImpl ?? fetch;
  const ref = `refs/tags/v${args.semver}`;
  const res = await fetchImpl(
    `${trimSlash(cfg.apiBaseUrl)}/repos/${args.owner}/${args.repo}/git/refs`,
    {
      method: "POST",
      headers: { ...authHeaders(cfg.token), "content-type": "application/json" },
      body: JSON.stringify({ ref, sha: args.sha }),
    },
  );

  if (res.status === 201) {
    return { ref };
  }
  if (res.status === 422) {
    // "Reference already exists" — a replayed tag creation. Idempotent success.
    // Task 62: this is NO LONGER a production-only path. The publish e2e now runs
    // against REAL github.com (the github-stub, which never emitted 422, is deleted),
    // so `publish-version.e2e.ts`'s crash/replay proof exercises this branch for real.
    return { ref };
  }
  throw new GithubRestError(`create tag failed: ${res.status}`, res.status);
}
