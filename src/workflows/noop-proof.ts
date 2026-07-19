import { DBOS } from "@dbos-inc/dbos-sdk";
import { WORKFLOW_NAMES } from "../dbos/registry";
import { recordNoopProof } from "../db/app-db";

/**
 * The noop proof workflow — the minimal proof-of-mechanism the real workflows are
 * built on. It exists to prove, end to end, that:
 *   1. an external `DBOSClient.enqueue` (workflowName/queueName/workflowID) reaches
 *      the worker and runs to completion, and
 *   2. the workflow writes to the APP database via a checkpointed `DBOS.runStep`,
 *      and
 *   3. enqueuing again with the same workflowID runs exactly once (idempotency —
 *      the guarantee the API's "workflowID = domain-record id" enqueue relies on).
 *
 * Registered STATICALLY at module load via `DBOS.registerWorkflow(fn, { name })`,
 * before `DBOS.launch()` — importing this module is what performs the registration
 * (see runtime.ts, which imports it prior to launch). No dynamic registration.
 */

export const NOOP_PROOF_WORKFLOW_NAME = WORKFLOW_NAMES.noopProof;

export interface NoopProofPayload {
  note?: string | null;
}

export interface NoopProofResult {
  workflowId: string;
  recordedNote: string | null;
}

async function noopProofFn(
  payload?: NoopProofPayload,
): Promise<NoopProofResult> {
  const workflowId = DBOS.workflowID;
  if (!workflowId) {
    throw new Error("noopProof: DBOS.workflowID unavailable inside the workflow");
  }
  const note = payload?.note ?? null;

  await DBOS.runStep(() => recordNoopProof(workflowId, note), {
    name: "recordNoopProof",
  });

  return { workflowId, recordedNote: note };
}

export const noopProofWorkflow = DBOS.registerWorkflow(noopProofFn, {
  name: NOOP_PROOF_WORKFLOW_NAME,
});
