import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  AI_GENERATION_QUEUE_NAME,
  CLEANUP_ORPHANED_ASSETS_WORKFLOW_NAME,
  COMMIT_VERSION_WORKFLOW_NAME,
  GENERATE_AUDIO_WORKFLOW_NAME,
  GENERATE_IMAGE_WORKFLOW_NAME,
  GENERATE_SCRIPT_WORKFLOW_NAME,
  GENERATE_VIDEO_WORKFLOW_NAME,
  GIT_OPS_QUEUE_NAME,
  IMPORT_PROJECT_WORKFLOW_NAME,
  PUBLISH_VERSION_WORKFLOW_NAME,
  MAINTENANCE_QUEUE_NAME,
  RENDER_QUEUE_NAME,
  RENDER_WORKFLOW_NAME,
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
      // Plan row 42: the fourth queue. `WORKFLOW_QUEUE` is
      // `satisfies Record<keyof typeof WORKFLOW_NAMES, QueueName>`, so adding a workflow
      // name WITHOUT a queue is a compile error — which is why the maintenance queue is
      // not optional once cleanupOrphanedAssets exists.
      "maintenance",
      "render",
    ]);
  });

  it("pins each queue's worker concurrency (git-ops ~4, ai-generation ~8, render 1)", () => {
    expect(QUEUE_CONFIG["git-ops"].workerConcurrency).toBe(4);
    expect(QUEUE_CONFIG["ai-generation"].workerConcurrency).toBe(8);
    expect(QUEUE_CONFIG["render"].workerConcurrency).toBe(1);
    // Plan row 42: one janitor at a time. Two concurrent cleanup runs would race on the
    // same delete set in the one shared bucket for no throughput benefit.
    expect(QUEUE_CONFIG["maintenance"].workerConcurrency).toBe(1);
  });
});

describe("static workflow registry", () => {
  it("declares the workflows built so far (git-ops four + noopProof + generateScript/Image/Audio/Video)", () => {
    expect(Object.values(WORKFLOW_NAMES).sort()).toEqual([
      "cleanupOrphanedAssets",
      "commitVersion",
      "generateAudio",
      "generateImage",
      "generateScript",
      "generateVideo",
      "importProject",
      "noopProof",
      "publishVersion",
      "render",
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
    expect(WORKFLOW_QUEUE.generateImage).toBe("ai-generation");
    expect(WORKFLOW_QUEUE.generateAudio).toBe("ai-generation");
    expect(WORKFLOW_QUEUE.generateVideo).toBe("ai-generation");
    // Task #36: render is the ONLY workflow on the dedicated `render` queue.
    expect(WORKFLOW_QUEUE.render).toBe("render");
    // Plan row 42: the scheduled janitor is alone on `maintenance`. It is deliberately
    // NOT on git-ops — a nightly bucket sweep must never occupy a slot the user-facing
    // scaffold/commit/publish work is waiting on.
    expect(WORKFLOW_QUEUE.cleanupOrphanedAssets).toBe(MAINTENANCE_QUEUE_NAME);
    for (const queue of Object.values(WORKFLOW_QUEUE)) {
      expect(Object.keys(QUEUE_CONFIG)).toContain(queue);
    }
  });

  // Task #18/19: the registry's scaffold + import names + queues are sourced from the
  // SHARED db-lib constants (the API imports the SAME values for its enqueue lookup
  // table), so the two services can never drift. This is the "shared fixture" the API's
  // workflow-lookup unit test pins against.
  /**
   * Step-11 item 29 (R42-4) — row 42's two names come from db-lib TOO.
   *
   * Verified: the pinned db-lib exports `CLEANUP_ORPHANED_ASSETS_WORKFLOW_NAME` and
   * `MAINTENANCE_QUEUE_NAME` from both `src/workflows.ts` and `dist/workflows.d.ts`, and its
   * own docblock asserts that "the dbos static registry pins
   * `WORKFLOW_NAMES.cleanupOrphanedAssets` against this exact constant". The registry
   * hard-coded both strings instead, under a comment claiming the name "is authored LOCALLY
   * rather than sourced from db-lib" — so db-lib documented a coupling the code did not honour,
   * and the TDD plan recorded a false deviation note saying the constant had not shipped.
   *
   * These assertions are what make a literal drift fail: with the strings hard-coded, renaming
   * either side was invisible to every test in both repos.
   */
  it("sources row 42's cleanup workflow name AND maintenance queue from db-lib (item 29)", () => {
    expect(WORKFLOW_NAMES.cleanupOrphanedAssets).toBe(
      CLEANUP_ORPHANED_ASSETS_WORKFLOW_NAME,
    );
    expect(WORKFLOW_QUEUE.cleanupOrphanedAssets).toBe(MAINTENANCE_QUEUE_NAME);
    expect(Object.keys(QUEUE_CONFIG)).toContain(MAINTENANCE_QUEUE_NAME);
    // And the registry must not carry a second, local copy of either string: an imported
    // constant plus a hard-coded literal elsewhere is the same drift hazard with more steps.
    const source = readFileSync(join(__dirname, "registry.ts"), "utf8");
    expect(source).toContain("CLEANUP_ORPHANED_ASSETS_WORKFLOW_NAME");
    expect(source).toContain("MAINTENANCE_QUEUE_NAME");
    expect(source).not.toContain('"cleanupOrphanedAssets"');
    expect(source).not.toContain('"maintenance"');
  });

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
    // Task #32: the generateImage name + ai-generation queue are the shared db-lib constants.
    expect(WORKFLOW_NAMES.generateImage).toBe(GENERATE_IMAGE_WORKFLOW_NAME);
    expect(WORKFLOW_QUEUE.generateImage).toBe(AI_GENERATION_QUEUE_NAME);
    // Task #33: the generateAudio name + ai-generation queue are the shared db-lib constants.
    expect(WORKFLOW_NAMES.generateAudio).toBe(GENERATE_AUDIO_WORKFLOW_NAME);
    expect(WORKFLOW_QUEUE.generateAudio).toBe(AI_GENERATION_QUEUE_NAME);
    // Task #34: the generateVideo name + ai-generation queue are the shared db-lib constants.
    expect(WORKFLOW_NAMES.generateVideo).toBe(GENERATE_VIDEO_WORKFLOW_NAME);
    expect(WORKFLOW_QUEUE.generateVideo).toBe(AI_GENERATION_QUEUE_NAME);
    // Task #36: the render name + the dedicated render queue are the shared db-lib
    // constants — the API's render-enqueue path (task 37) imports the SAME values.
    expect(WORKFLOW_NAMES.render).toBe(RENDER_WORKFLOW_NAME);
    expect(WORKFLOW_QUEUE.render).toBe(RENDER_QUEUE_NAME);
  });

  // Task #36: the render queue is the one queue whose concurrency is FIRM rather than a
  // design-time approximation — Remotion/Chromium is CPU + memory heavy, so exactly one
  // render per worker (design-delta §7; sizing validation deferred to task 45).
  it("keeps the render queue at exactly one render per worker", () => {
    expect(QUEUE_CONFIG[WORKFLOW_QUEUE.render].workerConcurrency).toBe(1);
  });
});

describe("noop workflow static registration (pre-launch)", () => {
  it("registers the noop workflow under the registry name at module load", () => {
    expect(NOOP_PROOF_WORKFLOW_NAME).toBe(WORKFLOW_NAMES.noopProof);
    expect(typeof noopProofWorkflow).toBe("function");
  });
});
