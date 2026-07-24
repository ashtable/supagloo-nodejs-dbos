import { describe, it, expect } from "vitest";
import type { DBOSClient } from "@dbos-inc/dbos-sdk";
import { countStepExecutions, type StepLister } from "./step-introspection";

// `StepInfo` is not re-exported from the SDK index — derive the row type from the method.
type StepInfo = NonNullable<
  Awaited<ReturnType<DBOSClient["listWorkflowSteps"]>>
>[number];

// Unit proof of the shared DBOS system-DB step-introspection helper (design-delta §10.5),
// the one 34-E7 reuses. It MUST prefix-match, not exact-match: the generate-script repair
// loop re-registers the SAME step under distinct suffixed names
// (`callLlmStructured`, `callLlmStructured:repair:1`, …), and the crash/replay proof counts
// them all. A fake `listWorkflowSteps` returns a canned StepInfo[] — no live DBOS.

function step(name: string, functionID: number): StepInfo {
  return {
    functionID,
    name,
    output: null,
    error: null,
    childWorkflowID: null,
  };
}

function lister(steps: StepInfo[] | undefined): StepLister {
  return { listWorkflowSteps: async () => steps };
}

describe("countStepExecutions", () => {
  const steps = [
    step("loadRequestAndCredentials", 0),
    step("callLlmStructured", 1),
    step("callLlmStructured:repair:1", 2),
    step("persistResult", 3),
  ];

  it("PREFIX-matches so the repair-loop attempts all count under the base name", async () => {
    expect(await countStepExecutions(lister(steps), "gen-1", "callLlmStructured")).toBe(2);
  });

  it("counts a single exact step (submitVideoJob) as 1", async () => {
    const videoSteps = [
      step("loadRequestAndCredentials", 0),
      step("submitVideoJob", 1),
      step("pollVideoJob", 2),
      step("pollVideoJob", 3),
      step("persistResult", 4),
    ];
    expect(await countStepExecutions(lister(videoSteps), "gen-2", "submitVideoJob")).toBe(1);
    expect(await countStepExecutions(lister(videoSteps), "gen-2", "pollVideoJob")).toBe(2);
  });

  it("returns 0 for an unmatched prefix", async () => {
    expect(await countStepExecutions(lister(steps), "gen-1", "nope")).toBe(0);
  });

  it("returns 0 when the workflow has no steps (undefined)", async () => {
    expect(await countStepExecutions(lister(undefined), "missing", "callLlmStructured")).toBe(0);
  });

  it("scopes to the given workflowID (forwards it to listWorkflowSteps)", async () => {
    // Real workflowID-scoping happens server-side in DBOSClient.listWorkflowSteps(workflowID); the
    // helper's job is only to FORWARD the id. A fake keyed by workflowID pins that it does — a
    // helper that dropped/hardcoded the id would return the wrong workflow's step rows.
    const byWorkflow: Record<string, StepInfo[]> = {
      "wf-a": [step("submitVideoJob", 0)],
      "wf-b": [step("submitVideoJob", 0), step("submitVideoJob:retry", 1)],
    };
    const scoped: StepLister = {
      listWorkflowSteps: async (id: string) => byWorkflow[id] ?? [],
    };
    expect(await countStepExecutions(scoped, "wf-a", "submitVideoJob")).toBe(1);
    expect(await countStepExecutions(scoped, "wf-b", "submitVideoJob")).toBe(2);
    expect(await countStepExecutions(scoped, "wf-unknown", "submitVideoJob")).toBe(0);
  });
});
