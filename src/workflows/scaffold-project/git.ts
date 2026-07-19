import { execFile } from "node:child_process";
import { promisify } from "node:util";

/**
 * Thin, hermetic wrappers over the system `git` CLI (house style: shell out to git,
 * zero npm git deps — matches the task-9 stub git-server itself). Every invocation
 * runs with a hermetic environment so the host's user/system git config cannot
 * perturb behaviour, and commits use a FIXED identity + date so the base commit is
 * byte-deterministic (see {@link commitAll}) — the property the workflow's
 * crash-safe, self-healing workspace rebuild depends on.
 */

const execFileAsync = promisify(execFile);

const HERMETIC_ENV = {
  GIT_TERMINAL_PROMPT: "0",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
} as const;

/**
 * The deterministic base-commit metadata. Fixed identity + fixed author/committer
 * date + fixed message ⇒ given the same tree and the same parent (fetched from the
 * remote), `git commit` produces the IDENTICAL SHA on every re-run. This is what
 * lets a step that re-runs after a crash rebuild `v0.0.0` and re-push it as a clean
 * no-op consistent with the SHA already checkpointed by `commitBaseVersion`.
 */
export const SCAFFOLD_COMMIT = {
  message: "Initial Supagloo scaffold (v0.0.0)",
  authorName: "Supagloo",
  authorEmail: "bot@supagloo.dev",
  date: "2020-01-01T00:00:00Z",
} as const;

export async function git(
  args: string[],
  opts: { cwd?: string; env?: Record<string, string> } = {},
): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd: opts.cwd,
    env: { ...process.env, ...HERMETIC_ENV, ...opts.env },
    maxBuffer: 64 * 1024 * 1024,
  });
  return stdout.toString();
}

/** Clone `cloneUrl` into `dir` (a clean, fresh clone of the default branch). */
export async function clone(cloneUrl: string, dir: string): Promise<void> {
  await git(["clone", cloneUrl, dir]);
}

/**
 * Create-or-reset `branch` at the current HEAD (or from `fromRef` if given) and
 * check it out. `checkout -B` is idempotent — re-running lands on the same branch.
 */
export async function checkoutBranch(
  dir: string,
  branch: string,
  fromRef?: string,
): Promise<void> {
  const args = ["checkout", "-B", branch];
  if (fromRef) args.push(fromRef);
  await git(args, { cwd: dir });
}

/** Stage everything and make the deterministic base commit; returns its SHA. */
export async function commitAll(dir: string): Promise<string> {
  await git(["add", "-A"], { cwd: dir });
  await git(["commit", "-m", SCAFFOLD_COMMIT.message], {
    cwd: dir,
    env: {
      GIT_AUTHOR_NAME: SCAFFOLD_COMMIT.authorName,
      GIT_AUTHOR_EMAIL: SCAFFOLD_COMMIT.authorEmail,
      GIT_COMMITTER_NAME: SCAFFOLD_COMMIT.authorName,
      GIT_COMMITTER_EMAIL: SCAFFOLD_COMMIT.authorEmail,
      GIT_AUTHOR_DATE: SCAFFOLD_COMMIT.date,
      GIT_COMMITTER_DATE: SCAFFOLD_COMMIT.date,
    },
  });
  return revParse(dir, "HEAD");
}

/** Resolve a ref to a full 40-char SHA. */
export async function revParse(dir: string, ref: string): Promise<string> {
  return (await git(["rev-parse", ref], { cwd: dir })).trim();
}

/** Push `branch` to `origin`. Re-pushing the same SHA is a clean no-op. */
export async function pushBranch(dir: string, branch: string): Promise<void> {
  await git(["push", "origin", branch], { cwd: dir });
}
