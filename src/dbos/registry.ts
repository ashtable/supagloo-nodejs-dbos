import {
  AI_GENERATION_QUEUE_NAME,
  COMMIT_VERSION_WORKFLOW_NAME,
  GENERATE_IMAGE_WORKFLOW_NAME,
  GENERATE_SCRIPT_WORKFLOW_NAME,
  GIT_OPS_QUEUE_NAME,
  IMPORT_PROJECT_WORKFLOW_NAME,
  PUBLISH_VERSION_WORKFLOW_NAME,
  SCAFFOLD_PROJECT_WORKFLOW_NAME,
} from "@supagloo/database-lib";

/**
 * The static DBOS registry — the single source of truth for the worker's queues
 * and workflows.
 *
 * HARD CONSTRAINT (design-delta §7, memory dbos-static-workflows-and-enqueue-
 * pattern): zero dynamic workflow registration. The SET of queues and workflows
 * is fixed here in source at authoring time; nothing is constructed at runtime.
 *
 * On queue timing (verified against @dbos-inc/dbos-sdk@4.23.6): the constraint
 * that matters is *static workflow registration* — each workflow is registered via
 * `DBOS.registerWorkflow(fn, { name })` at module load, before `DBOS.launch()`
 * (see src/workflows/*). Queue *concurrency* is persisted to the system database
 * via `DBOS.registerQueue`, which the current SDK requires be called AFTER launch
 * (so an external DBOSClient can see the queue row; the module-load
 * `new WorkflowQueue()` form is deprecated/in-process-only). runtime.ts iterates
 * THIS frozen table to make those calls — the queue names/concurrency are still
 * fully static, they are just applied post-launch. This does not weaken the
 * no-dynamic-registration guarantee, which is about workflow shapes.
 */

/**
 * The three design-mandated queues and their per-worker concurrency (design-delta
 * §7). `git-ops` ~4 and `ai-generation` ~8 are deliberate design-time
 * approximations (tuning deferred to the load-testing task 45); `render` = exactly
 * 1/worker is firm (Remotion/Chromium is CPU/memory heavy). These names are
 * load-bearing for every later workflow task — never renamed.
 */
export const QUEUE_CONFIG = {
  "git-ops": { workerConcurrency: 4 },
  "ai-generation": { workerConcurrency: 8 },
  render: { workerConcurrency: 1 },
} as const satisfies Record<string, { workerConcurrency: number }>;

export type QueueName = keyof typeof QUEUE_CONFIG;

/**
 * Every statically-registered workflow's name. Task #15 ships only the noop proof
 * workflow; real workflows (scaffold/import/commit/publish, generate*, render,
 * cleanup) are added by later tasks, each adding its name here + a WORKFLOW_QUEUE
 * entry. The API's enqueue path (task 18) imports these same names for its static
 * kind→workflow lookup table.
 */
export const WORKFLOW_NAMES = {
  noopProof: "noopProof",
  // Sourced from the SHARED db-lib constant (design-delta §5.1/§7): the API's enqueue
  // lookup table imports the SAME value, so the worker and the enqueuer can never
  // disagree on the scaffold workflow name.
  scaffoldProject: SCAFFOLD_PROJECT_WORKFLOW_NAME,
  // Task #19: the second real git-ops workflow. Same shared-constant discipline as
  // scaffold — the API enqueues to this exact name via the db-lib routing table.
  importProject: IMPORT_PROJECT_WORKFLOW_NAME,
  // Task #21: the third real git-ops workflow (commit an edited manifest). Same
  // shared-constant discipline — the API enqueues to this exact name.
  commitVersion: COMMIT_VERSION_WORKFLOW_NAME,
  // Task #22: the fourth real git-ops workflow (publish: merge working → main, tag,
  // cut next branch). Same shared-constant discipline — the API enqueues to this name.
  publishVersion: PUBLISH_VERSION_WORKFLOW_NAME,
  // Task #30: the first ai-generation workflow (storyboard + script structured text).
  // Same shared-constant discipline — the API enqueues to this name on the ai-generation queue.
  generateScript: GENERATE_SCRIPT_WORKFLOW_NAME,
  // Task #32: the image-generation workflow (openrouter-only media). Same shared-constant
  // discipline — the API enqueues to this name on the ai-generation queue.
  generateImage: GENERATE_IMAGE_WORKFLOW_NAME,
} as const;

export type WorkflowName = (typeof WORKFLOW_NAMES)[keyof typeof WORKFLOW_NAMES];

/**
 * Which queue each workflow lands on. The noop proof rides `git-ops` — the
 * lightest real queue and the one the first real workflow (`scaffoldProject`,
 * task 17) uses — so the proof exercises the same dispatch path the earliest real
 * work will. `scaffoldProject` (task 17) is that first real git-ops workflow.
 */
export const WORKFLOW_QUEUE = {
  noopProof: "git-ops",
  // The git-ops queue name is likewise the shared db-lib constant the API enqueues to.
  scaffoldProject: GIT_OPS_QUEUE_NAME,
  // importProject (task 19) rides the same git-ops queue as scaffold.
  importProject: GIT_OPS_QUEUE_NAME,
  // commitVersion (task 21) rides the same git-ops queue.
  commitVersion: GIT_OPS_QUEUE_NAME,
  // publishVersion (task 22) rides the same git-ops queue.
  publishVersion: GIT_OPS_QUEUE_NAME,
  // generateScript (task 30) rides the ai-generation queue (the shared db-lib constant).
  generateScript: AI_GENERATION_QUEUE_NAME,
  // generateImage (task 32) rides the same ai-generation queue.
  generateImage: AI_GENERATION_QUEUE_NAME,
} as const satisfies Record<keyof typeof WORKFLOW_NAMES, QueueName>;
