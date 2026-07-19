import { describe, it, expect } from "vitest";
import { QUEUE_CONFIG, WORKFLOW_NAMES, WORKFLOW_QUEUE } from "./registry";
import {
  NOOP_PROOF_WORKFLOW_NAME,
  noopProofWorkflow,
} from "../workflows/noop-proof";

// The hard constraint (memory dbos-static-workflows-and-enqueue-pattern,
// design-delta §7): the set of workflows + queues is FIXED in source and knowable
// WITHOUT launching DBOS. This suite pins the exact registry and never calls
// DBOS.launch() — importing the workflow module runs DBOS.registerWorkflow at
// module load, which must be launch-free. See registry.ts §0.1 for why the queue
// concurrency is persisted (via DBOS.registerQueue) after launch while the queue
// SET stays static here.

describe("static queue registry", () => {
  it("declares exactly the three design-mandated queues", () => {
    expect(Object.keys(QUEUE_CONFIG).sort()).toEqual([
      "ai-generation",
      "git-ops",
      "render",
    ]);
  });

  it("pins each queue's worker concurrency (git-ops ~4, ai-generation ~8, render 1)", () => {
    expect(QUEUE_CONFIG["git-ops"].workerConcurrency).toBe(4);
    expect(QUEUE_CONFIG["ai-generation"].workerConcurrency).toBe(8);
    expect(QUEUE_CONFIG["render"].workerConcurrency).toBe(1);
  });
});

describe("static workflow registry", () => {
  it("declares exactly the workflows built in this task (noopProof only)", () => {
    expect(Object.values(WORKFLOW_NAMES).sort()).toEqual(["noopProof"]);
  });

  it("maps every workflow onto a declared queue (noopProof → git-ops)", () => {
    expect(WORKFLOW_QUEUE.noopProof).toBe("git-ops");
    expect(Object.keys(QUEUE_CONFIG)).toContain(WORKFLOW_QUEUE.noopProof);
  });
});

describe("noop workflow static registration (pre-launch)", () => {
  it("registers the noop workflow under the registry name at module load", () => {
    expect(NOOP_PROOF_WORKFLOW_NAME).toBe(WORKFLOW_NAMES.noopProof);
    expect(typeof noopProofWorkflow).toBe("function");
  });
});
