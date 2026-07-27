import { createPrismaClient, decryptSecret } from "@supagloo/database-lib";
import {
  DBOS_DEFAULT_SYSTEM_SCHEMA,
  assertLaneSchemaName,
} from "./dbos-lane-isolation";

/**
 * Plan row 48's e2e probe: **no plaintext installation token in any DBOS checkpoint**.
 *
 * WHY THIS FILE EXISTS RATHER THAN A LINE OF SQL IN EACH SPEC. Row 48's E2E criterion
 * reads "inspect `operation_outputs` rows … in Compose `supagloo_dbos`". That is
 * literally true and SCHEMA-WRONG (brief §9 S8, §10 R5): every e2e lane in this repo
 * runs its in-process DBOS runtime against a per-lane `dbos_e2e_*` SCHEMA inside
 * `supagloo_dbos`, so a query against the DEFAULT `dbos` schema from inside a lane finds
 * ZERO rows and passes — vacuously. For a security regression test that is the worst
 * possible failure mode: it would report green forever while the token sat in Postgres.
 *
 * So this probe follows current-design §5.4 item 9:821-823's established pattern —
 * "exists once in the LANE schema and ZERO times in shared `dbos`" — and is built so
 * that every way it could pass vacuously is itself an assertion:
 *
 *   1. the lane schema must hold ≥1 checkpoint row for this workflow;
 *   2. one of them must be the `mintInstallationToken` step;
 *   3. NO row's `output` or `error` may match a GitHub token shape;
 *   4. POSITIVELY, the mint row's `output` must DECRYPT with the lane's key to a value
 *      that IS token-shaped — so "no token found" cannot be an artifact of a step that
 *      quietly stopped returning anything;
 *   5. the shared `dbos` schema (the namespace the Compose worker polls) must hold ZERO
 *      rows for this workflow.
 *
 * Throws on every failure. Never warns, never skips — a lane may not mark itself
 * optional (current-design §5.4 item 9:830).
 */

/**
 * GitHub credential shapes. `ghs_` is the installation token this row is about; the other
 * prefixes are included because a leak-scanner that knows only one is one refactor away
 * from useless.
 *
 * THE TAIL CHARACTER CLASS IS NOT COSMETIC — measured, not assumed. An earlier version of
 * this pattern required `[A-Za-z0-9]{20,}` after the prefix, on the assumption that
 * installation tokens are the classic short alphanumeric shape. Against real
 * api.github.com they are not: a token minted by this App in the render lane measured
 * **383 characters** and contained characters outside `[A-Za-z0-9_]` within the first
 * twenty. So the strict pattern matched some real tokens and not others, purely by where
 * the first separator happened to fall — which for a LEAK DETECTOR is the worst kind of
 * bug, since the failure mode is a silent miss. The tail therefore accepts the full
 * URL-safe/base64url set, and the `{16,}` floor is only there to keep prose like
 * `"ghs_token"` or a doc reference to `ghp_…` from matching.
 */
export const GITHUB_TOKEN_SHAPE =
  /(?:gh[soupr]_[A-Za-z0-9_\-.]{16,}|github_pat_[A-Za-z0-9_\-.]{16,})/;

/** One checkpointed step row, as DBOS stores it. */
export interface CheckpointRow {
  function_id: number;
  function_name: string;
  output: string | null;
  error: string | null;
}

/** The rows whose `output` or `error` carries something token-shaped. */
export function findTokenShapedCheckpoints(rows: CheckpointRow[]): CheckpointRow[] {
  return rows.filter(
    (r) =>
      (r.output !== null && GITHUB_TOKEN_SHAPE.test(r.output)) ||
      (r.error !== null && GITHUB_TOKEN_SHAPE.test(r.error)),
  );
}

/**
 * A checkpointed step result is JSON-enveloped by the SDK's serializer (`{"json":"…"}`).
 * Pull the string back out so it can be handed to `decryptSecret`; falls back to the raw
 * text if the envelope shape ever changes, so a serializer bump degrades to a clear
 * decrypt failure rather than a confusing parse error.
 */
export function unwrapCheckpointString(output: string): string {
  try {
    const parsed = JSON.parse(output) as unknown;
    if (typeof parsed === "string") return parsed;
    if (
      parsed !== null &&
      typeof parsed === "object" &&
      typeof (parsed as { json?: unknown }).json === "string"
    ) {
      return (parsed as { json: string }).json;
    }
  } catch {
    /* fall through */
  }
  return output;
}

export interface SealedTokenProbe {
  /** `DBOS_DATABASE_URL` — the SYSTEM database (`supagloo_dbos`). */
  systemDatabaseUrl: string;
  /** This lane's `dbos_e2e_*` schema. */
  schema: string;
  /** The workflow whose checkpoints are being inspected. */
  workflowID: string;
  /** The `SECRETS_ENCRYPTION_KEY` this lane launched with. */
  encryptionKey: string;
  /**
   * Step-11 item 35 (R4850-5) — set on a FAILURE spec to make check (3)'s `error`-column half
   * non-vacuous.
   *
   * The scan below reads `output` AND `error`, but every existing call site sits on a happy
   * path where every `error` column is `NULL` — so the half that would catch an unredacted
   * `err.message` carrying `x-access-token:ghs_…@github.com` into a checkpointed step error was
   * proven only by a synthetic unit row. With this set, the probe REFUSES to pass unless at
   * least one checkpoint row actually has a populated `error`, exactly as checks (1) and (2)
   * refuse to pass on an empty row set.
   */
  requirePopulatedErrorColumn?: boolean;
}

function leakFailure(detail: string): Error {
  return new Error(
    `Installation-token checkpoint hardening (plan row 48) is NOT in effect: ${detail} ` +
      `A DBOS step's return value is persisted verbatim into <schema>.operation_outputs.output, ` +
      `so a step that returns the raw token writes a live GitHub credential to Postgres at rest. ` +
      `See src/workflows/shared/installation-token.ts.`,
  );
}

/**
 * Assert that every checkpoint this workflow wrote is free of plaintext installation
 * tokens, and that the mint step's checkpoint is a real ciphertext of a real token.
 */
export async function assertCheckpointedTokensSealed({
  systemDatabaseUrl,
  schema,
  workflowID,
  encryptionKey,
  requirePopulatedErrorColumn = false,
}: SealedTokenProbe): Promise<void> {
  assertLaneSchemaName(schema);

  const db = createPrismaClient({ connectionString: systemDatabaseUrl });
  try {
    const rows = await db.$queryRawUnsafe<CheckpointRow[]>(
      `SELECT function_id, function_name, output, error
         FROM "${schema}".operation_outputs
        WHERE workflow_uuid = $1`,
      workflowID,
    );

    // (1) Anti-vacuity. If this lane's schema holds no checkpoints for the workflow, the
    //     probe is looking in the wrong place and every assertion below is meaningless.
    if (rows.length === 0) {
      throw leakFailure(
        `"${schema}".operation_outputs holds NO rows for workflow "${workflowID}", so this probe ` +
          `would pass vacuously. Pass the LANE schema (dbos_e2e_*), not the default ` +
          `"${DBOS_DEFAULT_SYSTEM_SCHEMA}" schema.`,
      );
    }

    // (2) …and the step this row is actually about must be among them.
    const mints = rows.filter((r) => r.function_name === "mintInstallationToken");
    if (mints.length === 0) {
      throw leakFailure(
        `workflow "${workflowID}" recorded ${rows.length} checkpoint(s) in "${schema}" but none ` +
          `named "mintInstallationToken", so nothing about the token was actually inspected.`,
      );
    }

    // (2b) Anti-vacuity for the ERROR-COLUMN half, on failure specs only (item 35). Without
    //      it, "the probe covers checkpointed step errors" is a claim no run has tested: a
    //      happy-path workflow has `error IS NULL` on every row, so check (3)'s error branch
    //      never evaluates a single character.
    if (requirePopulatedErrorColumn && !rows.some((r) => r.error !== null)) {
      throw leakFailure(
        `workflow "${workflowID}" recorded ${rows.length} checkpoint(s) in "${schema}" but NONE ` +
          `with a populated \`error\` column, so this probe's error-column half would pass ` +
          `vacuously. Call it with requirePopulatedErrorColumn only from a spec where a step ` +
          `genuinely fails.`,
      );
    }

    // (3) The headline assertion: nothing token-shaped anywhere, in output OR error.
    const leaked = findTokenShapedCheckpoints(rows);
    if (leaked.length > 0) {
      const where = leaked
        .map((r) => `${r.function_name}#${r.function_id}`)
        .join(", ");
      throw leakFailure(
        `${leaked.length} checkpointed step result(s) in "${schema}" carry a GitHub-token-shaped ` +
          `value: ${where}.`,
      );
    }

    // (4) POSITIVE proof. Absence alone is satisfiable by a step that returns nothing;
    //     this pins that the checkpoint IS the sealed form of a genuine token.
    for (const mint of mints) {
      if (mint.output === null) {
        throw leakFailure(
          `the "mintInstallationToken" checkpoint in "${schema}" has a NULL output, so there is ` +
            `nothing to prove sealed.`,
        );
      }
      const opened = decryptSecret(unwrapCheckpointString(mint.output), encryptionKey);
      if (!GITHUB_TOKEN_SHAPE.test(opened)) {
        throw leakFailure(
          `the "mintInstallationToken" checkpoint in "${schema}" decrypts to a value that is not ` +
            `token-shaped, so the sealed value is not a real installation token.`,
        );
      }
    }

    // (5) And the shared namespace the Compose worker polls never saw this lane's work —
    //     the same both-directions proof `assertWorkflowIsolated` makes for
    //     `workflow_status`, made here for the table that holds the secret.
    const sharedExists = await db.$queryRawUnsafe<Array<{ reg: string | null }>>(
      "SELECT to_regclass($1)::text AS reg",
      `"${DBOS_DEFAULT_SYSTEM_SCHEMA}".operation_outputs`,
    );
    if (sharedExists[0]?.reg == null) return;
    const shared = await db.$queryRawUnsafe<Array<{ n: number }>>(
      `SELECT count(*)::int AS n FROM "${DBOS_DEFAULT_SYSTEM_SCHEMA}".operation_outputs WHERE workflow_uuid = $1`,
      workflowID,
    );
    if (Number(shared[0]?.n ?? 0) !== 0) {
      throw leakFailure(
        `workflow "${workflowID}" ALSO wrote checkpoints into the shared ` +
          `"${DBOS_DEFAULT_SYSTEM_SCHEMA}" schema, which this probe did not inspect.`,
      );
    }
  } finally {
    await db.$disconnect().catch(() => undefined);
  }
}
