/**
 * The GitHub REST half of the scaffold flow: installation-scoped reachability, PR
 * open, PR merge. Raw `fetch` + hand parsing (house style — no Octokit anywhere).
 * `fetchImpl` is injectable for unit tests; every input is passed explicitly.
 */

/** Thrown when the installation token genuinely cannot reach the repo — a PERMANENT
 *  failure that must NOT be retried (the step's `shouldRetry` returns false for it). */
export class RepoUnreachableError extends Error {
  readonly code = "REPO_UNREACHABLE" as const;
  constructor(message: string) {
    super(message);
    this.name = "RepoUnreachableError";
  }
}

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
    const res = await fetchImpl(url, { headers: authHeaders(cfg.token) });
    if (!res.ok) {
      throw new Error(`installation repositories list failed: ${res.status}`);
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

async function findOpenPrByHead(
  cfg: GithubRestConfig,
  owner: string,
  repo: string,
  head: string,
): Promise<OpenedPr | null> {
  const fetchImpl = cfg.fetchImpl ?? fetch;
  const url =
    `${trimSlash(cfg.apiBaseUrl)}/repos/${owner}/${repo}/pulls` +
    `?head=${owner}:${head}&state=open`;
  const res = await fetchImpl(url, { headers: authHeaders(cfg.token) });
  if (!res.ok) return null;
  const list = (await res.json()) as Array<{ number: number; html_url: string }>;
  const first = list[0];
  return first ? { number: first.number, url: first.html_url } : null;
}

/**
 * Open the base PR (`head` → `base`). On real GitHub a duplicate head returns 422
 * "A pull request already exists"; we treat that as idempotent and resolve the
 * existing PR via a lookup (the stub never emits 422, so this path is production-
 * only — documented gap: a fully idempotent open needs a stub "get PR by head" route).
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
  const res = await fetchImpl(
    `${trimSlash(cfg.apiBaseUrl)}/repos/${args.owner}/${args.repo}/pulls`,
    {
      method: "POST",
      headers: { ...authHeaders(cfg.token), "content-type": "application/json" },
      body: JSON.stringify({
        title: args.title,
        head: args.head,
        base: args.base,
        body: args.body,
      }),
    },
  );

  if (res.status === 201) {
    const b = (await res.json()) as { number: number; html_url: string };
    return { number: b.number, url: b.html_url };
  }
  if (res.status === 422) {
    const existing = await findOpenPrByHead(cfg, args.owner, args.repo, args.head);
    if (existing) return existing;
  }
  throw new Error(`open pull request failed: ${res.status}`);
}

/**
 * Merge the base PR (squash). The task-9 stub returns 405 on a DOUBLE-merge (and
 * real GitHub returns 405 for an already-merged PR); we treat 405 as an idempotent
 * "already merged" success so a replayed merge is safe. (Scaffold merges are clean
 * fast-forwards, so a FIRST-attempt 405-for-conflict cannot occur.)
 */
export async function mergePullRequest(
  cfg: GithubRestConfig,
  args: { owner: string; repo: string; number: number; mergeMethod?: string },
): Promise<{ merged: boolean; sha?: string }> {
  const fetchImpl = cfg.fetchImpl ?? fetch;
  const res = await fetchImpl(
    `${trimSlash(cfg.apiBaseUrl)}/repos/${args.owner}/${args.repo}/pulls/${args.number}/merge`,
    {
      method: "PUT",
      headers: { ...authHeaders(cfg.token), "content-type": "application/json" },
      body: JSON.stringify({ merge_method: args.mergeMethod ?? "squash" }),
    },
  );

  if (res.ok) {
    const b = (await res.json()) as { merged?: boolean; sha?: string };
    return { merged: b.merged ?? true, sha: b.sha };
  }
  if (res.status === 405) {
    return { merged: true }; // already merged (idempotent replay)
  }
  throw new Error(`merge pull request failed: ${res.status}`);
}
