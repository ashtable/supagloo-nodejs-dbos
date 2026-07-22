import { describe, it, expect } from "vitest";
import {
  AI_GENERATION_QUEUE_NAME,
  COMMIT_VERSION_WORKFLOW_NAME,
  GENERATE_SCRIPT_WORKFLOW_NAME,
  GIT_OPS_QUEUE_NAME,
  IMPORT_PROJECT_WORKFLOW_NAME,
  PUBLISH_VERSION_WORKFLOW_NAME,
  SCAFFOLD_PROJECT_WORKFLOW_NAME,
} from "@supagloo/database-lib";
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
  it("declares the workflows built so far (git-ops four + noopProof + generateScript)", () => {
    expect(Object.values(WORKFLOW_NAMES).sort()).toEqual([
      "commitVersion",
      "generateScript",
      "importProject",
      "noopProof",
      "publishVersion",
      "scaffoldProject",
    ]);
  });

  it("maps every workflow onto a declared queue (git-ops for git-ops kinds, ai-generation for generateScript)", () => {
    expect(WORKFLOW_QUEUE.noopProof).toBe("git-ops");
    expect(WORKFLOW_QUEUE.scaffoldProject).toBe("git-ops");
    expect(WORKFLOW_QUEUE.importProject).toBe("git-ops");
    expect(WORKFLOW_QUEUE.commitVersion).toBe("git-ops");
    expect(WORKFLOW_QUEUE.publishVersion).toBe("git-ops");
    expect(WORKFLOW_QUEUE.generateScript).toBe("ai-generation");
    for (const queue of Object.values(WORKFLOW_QUEUE)) {
      expect(Object.keys(QUEUE_CONFIG)).toContain(queue);
    }
  });

  // Task #18/19: the registry's scaffold + import names + queues are sourced from the
  // SHARED db-lib constants (the API imports the SAME values for its enqueue lookup
  // table), so the two services can never drift. This is the "shared fixture" the API's
  // workflow-lookup unit test pins against.
  it("sources the scaffold + import + commit + publish names + git-ops queue from the shared db-lib constants", () => {
    expect(WORKFLOW_NAMES.scaffoldProject).toBe(SCAFFOLD_PROJECT_WORKFLOW_NAME);
    expect(WORKFLOW_QUEUE.scaffoldProject).toBe(GIT_OPS_QUEUE_NAME);
    expect(WORKFLOW_NAMES.importProject).toBe(IMPORT_PROJECT_WORKFLOW_NAME);
    expect(WORKFLOW_QUEUE.importProject).toBe(GIT_OPS_QUEUE_NAME);
    expect(WORKFLOW_NAMES.commitVersion).toBe(COMMIT_VERSION_WORKFLOW_NAME);
    expect(WORKFLOW_QUEUE.commitVersion).toBe(GIT_OPS_QUEUE_NAME);
    expect(WORKFLOW_NAMES.publishVersion).toBe(PUBLISH_VERSION_WORKFLOW_NAME);
    expect(WORKFLOW_QUEUE.publishVersion).toBe(GIT_OPS_QUEUE_NAME);
    // Task #30: the generateScript name + ai-generation queue are the shared db-lib constants.
    expect(WORKFLOW_NAMES.generateScript).toBe(GENERATE_SCRIPT_WORKFLOW_NAME);
    expect(WORKFLOW_QUEUE.generateScript).toBe(AI_GENERATION_QUEUE_NAME);
  });
});

describe("noop workflow static registration (pre-launch)", () => {
  it("registers the noop workflow under the registry name at module load", () => {
    expect(NOOP_PROOF_WORKFLOW_NAME).toBe(WORKFLOW_NAMES.noopProof);
    expect(typeof noopProofWorkflow).toBe("function");
  });
});
