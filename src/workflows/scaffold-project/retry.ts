import { GitCommandError } from "./git";
import {
  GithubRestError,
  isPermanentHttpStatus,
  RepoUnreachableError,
} from "./github-rest";

/**
 * Retry classification shared by the git-ops workflow's network/git steps.
 *
 * The Task-17 plan promised: `shouldRetry` returns `false` for typed PERMANENT
 * failures (unreachable repo, permanent 4xx, git auth/permission/not-found) across
 * every network/git step, so a permanently broken credential or permission fails
 * fast instead of burning the whole exponential-backoff budget. Everything else —
 * 5xx, 429, network blips, and any error we cannot positively identify — stays
 * transient and is retried. Defaulting the unknown case to transient guarantees we
 * never mark something permanent by accident.
 */

/** True if a scaffold network/git-step error is a PERMANENT failure retrying can't fix. */
export function isPermanentScaffoldFailure(e: unknown): boolean {
  if (e instanceof RepoUnreachableError) return true;
  if (e instanceof GithubRestError) return isPermanentHttpStatus(e.status);
  if (e instanceof GitCommandError) return e.permanent;
  return false;
}

/** DBOS `shouldRetry`: retry everything EXCEPT typed permanent failures. */
export function retryUnlessPermanent(e: unknown): boolean {
  return !isPermanentScaffoldFailure(e);
}
