import { isPermanentScaffoldFailure } from "../scaffold-project/retry";
import { ManifestInvalidError, NotASupaglooProjectError } from "./errors";

/**
 * Retry classification for the import-verify workflow's network/git steps.
 *
 * Import reuses scaffold's transport classifier (git auth/permission/not-found + HTTP
 * 4xx = permanent; 5xx/429/network = transient; unknown = transient) and EXTENDS it
 * with import's two typed CONTENT failures, which are permanent: a repo that is not a
 * Supagloo project, and a malformed manifest. Retrying either re-clones identical bytes
 * and fails identically, so they fail fast — the "no retries burned" property the
 * fast-fail e2e relies on. Defaulting the unknown case to transient (via the scaffold
 * classifier) still guarantees nothing is marked permanent by accident.
 */
export function isPermanentImportFailure(e: unknown): boolean {
  if (e instanceof NotASupaglooProjectError) return true;
  if (e instanceof ManifestInvalidError) return true;
  return isPermanentScaffoldFailure(e);
}

/** DBOS `shouldRetry`: retry everything EXCEPT typed permanent failures. */
export function retryUnlessPermanentImport(e: unknown): boolean {
  return !isPermanentImportFailure(e);
}
