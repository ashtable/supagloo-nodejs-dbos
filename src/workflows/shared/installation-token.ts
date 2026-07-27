import {
  decryptSecret,
  encryptSecret,
  mintInstallationToken,
} from "@supagloo/database-lib";
import { getProviderConfig } from "../../providers/config";

/**
 * The SEALED installation token (plan row 48).
 *
 * THE DEFECT THIS CLOSES. `mintInstallationToken` is invoked inside a DBOS **step**, and
 * DBOS durably persists a step's return value into `<schema>.operation_outputs.output`.
 * Returning the raw `ghs_…` token therefore wrote a live GitHub credential to Postgres at
 * rest, for the lifetime of the workflow row, in FIVE workflows — scaffold, import,
 * commit, publish and render. (The plan row lists four; brief §9 S7 corrects it. The old
 * comment in `scaffold-project.ts` compounded the error by claiming render minted twice;
 * render has exactly one mint step.) The design's "never persisted" language
 * (current-design §2.3:122-124, §2.5:222-224, §2.6:276) is about the app-level
 * `GithubConnection` row and never anticipated DBOS's own checkpointing mechanics, so
 * wireframe 10b's rendered, unqualified "🔒 All tokens & secrets are encrypted at rest"
 * was false as written. It is now true as written.
 *
 * THE SHAPE, AND WHY NOT THE OBVIOUS ONE. Row 48 offers "(a) accept-and-document" or
 * "(b) each consuming step re-mints **or derives** its own token". This is (b) by
 * derivation: the step returns AES-256-GCM ciphertext and the workflow body opens it
 * in-memory. Naive per-step RE-MINTING was rejected on evidence:
 *
 *   • the token is consumed by 3-5 steps per workflow and is baked into `ctx.cloneUrl`
 *     (and threaded through render's `ensureClonedWorkspace` self-heal ladder), and
 *     db-lib's `mintInstallationToken` does NO caching — so re-minting means 3-5 extra
 *     token exchanges per workflow;
 *   • those land in GitHub's SECONDARY (abuse) limits, which are account-scoped and far
 *     tighter than the verified core limit, and the DBOS classifier keeps `403 ⇒
 *     permanent` — so a throttled mint inside a consuming step becomes a PERMANENT step
 *     failure, manufacturing precisely the terminal-failure defect plan row 50 fixes;
 *   • it would break the flagship durability proof: four e2e specs assert exactly ONE
 *     recorded execution of `mintInstallationToken` per workflow.
 *
 * WHY DECRYPTING IN THE WORKFLOW BODY IS LEGAL. Workflow bodies must be deterministic.
 * `decryptSecret(ciphertext, key)` is a pure function of a CHECKPOINTED input plus
 * process config — no I/O, no clock, no randomness — so a replay derives the identical
 * token. Workflow-body locals are never checkpointed; only step return values are.
 * `encryptSecret` draws a fresh random nonce, but it runs INSIDE the step, and a replayed
 * step returns its memoized ciphertext rather than re-encrypting.
 *
 * WHAT DELIBERATELY DOES NOT CHANGE (brief §10 R11): the step NAME (the
 * `countStepExecutions` witness), the step COUNT and every `functionID` (so
 * `RENDER_STEP_SEQUENCE` and the crash/replay step-count assertions stand, and no
 * in-flight workflow is stranded across a restart), the absence of a `shouldRetry`
 * classifier on the mint steps (plan row 64 / D64.5 — a survivable secondary
 * `403 + Retry-After` must not become an immediate FATAL at step 1), and GitHub call
 * volume (so no new rate-limit or classifier interaction).
 *
 * THE KEY is the one `SECRETS_ENCRYPTION_KEY` already injected at launch via
 * `setProviderConfig` — the same key the per-user provider credentials use, the same
 * trust boundary, the same process. Nothing new is configured, and row 43 already
 * validates it at boot (and rejects the all-zeros value with the recorded incident).
 */

/** The arguments db-lib's `mintInstallationToken` takes, re-exported for the call sites. */
export interface MintInstallationTokenArgs {
  appId: string;
  privateKey: string;
  installationId: string;
  apiBaseUrl: string;
}

/**
 * Mint an installation token and SEAL it. Call this INSIDE the `mintInstallationToken`
 * step — its return value is exactly what DBOS checkpoints, so it must never be the
 * plaintext token.
 *
 * A mint failure propagates unchanged: the step's retry budget and the workflow's
 * terminal-failure record (row 50) both key off the real error.
 */
export async function mintEncryptedInstallationToken(
  args: MintInstallationTokenArgs,
): Promise<string> {
  const minted = await mintInstallationToken(args);
  return encryptSecret(minted.token, getProviderConfig().secretsEncryptionKey);
}

/**
 * Open a sealed token. Call this in the WORKFLOW BODY, on the value the step returned —
 * body locals are never checkpointed, so the plaintext exists only in memory for the
 * duration of the execution attempt.
 *
 * Fails LOUDLY on a wrong or rotated key (AES-GCM's auth tag makes silent garbage
 * impossible), rather than handing a broken credential to a clone URL where it would
 * surface as a confusing git auth failure three steps later.
 */
export function openInstallationToken(sealed: string): string {
  return decryptSecret(sealed, getProviderConfig().secretsEncryptionKey);
}
