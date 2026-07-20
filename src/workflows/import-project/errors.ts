/**
 * Typed PERMANENT (non-retryable) content failures for the import-verify workflow.
 *
 * Unlike scaffold's transport failures (git auth, HTTP 4xx — classified by `retry.ts`),
 * these are CONTENT-validation failures: the repo's bytes are what they are, so
 * retrying re-clones the identical content and fails identically. Both carry
 * `permanent = true` so the shared import retry classifier (see `retry.ts`) fails them
 * fast — "no retries burned" — and the workflow's failure recorder writes the
 * corresponding 12b stage state.
 */

/**
 * The repo is NOT a Supagloo project — it is missing `remotion.config.ts` at the root
 * and/or has no `vN.N.N` version branch (design-delta §7 workflow 2). The message
 * begins `NOT A SUPAGLOO PROJECT:` so the API/UI can surface the 12b stage state
 * verbatim.
 */
export class NotASupaglooProjectError extends Error {
  readonly code = "NOT_A_SUPAGLOO_PROJECT" as const;
  readonly permanent = true as const;
  constructor(message: string) {
    super(message);
    this.name = "NotASupaglooProjectError";
  }
}

/**
 * The repo looks like a Supagloo project (config + version branch) but its
 * `supagloo.project.json` is missing, is not valid JSON, or does not satisfy
 * `ProjectManifestSchema` (design-delta §2.11 — the manifest is validated at
 * import-verify).
 */
export class ManifestInvalidError extends Error {
  readonly code = "MANIFEST_INVALID" as const;
  readonly permanent = true as const;
  constructor(message: string) {
    super(message);
    this.name = "ManifestInvalidError";
  }
}
