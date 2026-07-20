import { git, revParse } from "../scaffold-project/git";

/**
 * Commit-specific git helpers, layered over the scaffold module's hermetic low-level
 * `git()` runner (redaction + classification + hermetic env are inherited).
 *
 * Unlike scaffold's byte-DETERMINISTIC base commit (fixed message + fixed date ⇒
 * reproducible SHA), commit builds a REAL commit from a user-supplied message + the
 * CURRENT time, so its SHA is not reproducible across re-runs. Idempotency instead rides a
 * `Supagloo-Job-Id: <jobId>` trailer embedded in the commit body: a durable, self-
 * describing key in git history that lets a replayed `commitAndPush` recognise its OWN
 * prior push and skip re-committing (see {@link headCommitHasJobId} + workspace.ts).
 */

/** Fixed bot identity for author + committer (a real message + current time otherwise). */
export const COMMIT_AUTHOR = {
  name: "Supagloo",
  email: "bot@supagloo.dev",
} as const;

/** The machine trailer stamped into every commit-version commit body. */
export function commitJobTrailer(jobId: string): string {
  return `Supagloo-Job-Id: ${jobId}`;
}

/**
 * Clone ONLY `branch` at `depth` (default 2). Depth 2 — not 1 — keeps the tip's PARENT
 * present locally, which the changed-file diff (`HEAD~1..HEAD`) and the replay detection
 * both need. Pushing a single fast-forward commit from this shallow clone works: the
 * remote already has the parent (= the cloned tip).
 */
export async function cloneBranch(
  cloneUrl: string,
  dir: string,
  branch: string,
  opts: { depth?: number } = {},
): Promise<void> {
  const depth = opts.depth ?? 2;
  await git([
    "clone",
    "--depth",
    String(depth),
    "--branch",
    branch,
    "--single-branch",
    cloneUrl,
    dir,
  ]);
}

/**
 * Stage everything and commit under the fixed bot identity with the REAL user `message`
 * as the subject and the jobId trailer as the body (current timestamp — a real commit).
 * Returns the new HEAD sha.
 */
export async function commitWithMessage(
  dir: string,
  message: string,
  jobId: string,
): Promise<string> {
  await git(["add", "-A"], { cwd: dir });
  // Two `-m` flags ⇒ subject (the user message) + a blank line + body (the trailer).
  await git(["commit", "-m", message, "-m", commitJobTrailer(jobId)], {
    cwd: dir,
    env: {
      GIT_AUTHOR_NAME: COMMIT_AUTHOR.name,
      GIT_AUTHOR_EMAIL: COMMIT_AUTHOR.email,
      GIT_COMMITTER_NAME: COMMIT_AUTHOR.name,
      GIT_COMMITTER_EMAIL: COMMIT_AUTHOR.email,
    },
  });
  return revParse(dir, "HEAD");
}

/**
 * The tip commit's own change set as `["<status> <path>", ...]` wire descriptors (e.g.
 * `"M src/scenes/Shelter.tsx"`) — design-delta §2.6's `changedFiles` format. Diffs
 * `HEAD~1..HEAD`, so the caller must guarantee HEAD has a parent (true for every commit
 * on a working branch cut from a base). The status letter is taken from the first field
 * (a rename `R100` collapses to `R`); the path is the last field (the new path on rename).
 */
export async function changedFilesForHead(dir: string): Promise<string[]> {
  const out = await git(["diff", "--name-status", "HEAD~1", "HEAD"], { cwd: dir });
  return out
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const fields = line.split("\t");
      const status = fields[0]?.[0] ?? "?";
      const path = fields[fields.length - 1];
      return `${status} ${path}`;
    });
}

/** True when the working tree has uncommitted changes vs HEAD (staged, unstaged, or new). */
export async function workingTreeDirty(dir: string): Promise<boolean> {
  const out = await git(["status", "--porcelain=v1"], { cwd: dir });
  return out.trim().length > 0;
}

/** True when HEAD's commit body carries THIS job's idempotency trailer. */
export async function headCommitHasJobId(
  dir: string,
  jobId: string,
): Promise<boolean> {
  const body = await git(["log", "-1", "--format=%B"], { cwd: dir });
  return body.includes(commitJobTrailer(jobId));
}

/**
 * Hard-reset the workspace back to `sha`, discarding any local commit (and working-tree
 * changes) made past it. Used to roll back a commit whose PUSH failed transiently: if the
 * local commit were left in place, a step retry against the SAME on-disk workspace would
 * see the jobId trailer on HEAD and wrongly take {@link headCommitHasJobId}'s "already
 * pushed" no-op path — recording a SHA that never reached the remote. `applyManifest`
 * regenerates the tree idempotently on the retry, so discarding it here is safe.
 */
export async function resetHard(dir: string, sha: string): Promise<void> {
  await git(["reset", "--hard", sha], { cwd: dir });
}
