import type { DBOSClient } from "@dbos-inc/dbos-sdk";

/**
 * Shared DBOS system-DB step-introspection helper (design-delta §10.5) — the generalization
 * of task 34's stub-`videoJobsCreated` counter into a real-provider-safe durability probe,
 * reused by generate-script's reworked crash/replay (LLM step count stable across resume),
 * generate-video's happy-path (`submitVideoJob` executed exactly once), the image/audio
 * happy-paths (provider step executed once), and later by task 34-E7.
 *
 * It counts recorded step executions for a workflow by matching the step NAME as a PREFIX —
 * NOT an exact match — because generate-script's bounded repair loop re-registers the SAME
 * step function under distinct suffixed names per attempt (`callLlmStructured`,
 * `callLlmStructured:repair:1`, …); the crux durability assertion counts them all. Internal
 * `retriesAllowed` retries of a single step do NOT inflate the count (DBOS records one
 * StepInfo row per `functionID`, regardless of in-step retries).
 *
 * Takes just the `listWorkflowSteps` method (structural) rather than the concrete `DBOSClient`
 * so it is unit-testable with an injected fake (`step-introspection.test.ts`). `StepInfo` is not
 * re-exported from the SDK index, so the row type is derived from the method's return type.
 */
export type StepLister = Pick<DBOSClient, "listWorkflowSteps">;

/**
 * Count the recorded executions of the steps whose name STARTS WITH `namePrefix` for the
 * given workflow. Returns 0 when the workflow has no recorded steps (or does not exist).
 */
export async function countStepExecutions(
  client: StepLister,
  workflowID: string,
  namePrefix: string,
): Promise<number> {
  const steps = (await client.listWorkflowSteps(workflowID)) ?? [];
  return steps.filter((s) => s.name.startsWith(namePrefix)).length;
}
