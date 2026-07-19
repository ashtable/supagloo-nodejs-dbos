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
} as const;

export type WorkflowName = (typeof WORKFLOW_NAMES)[keyof typeof WORKFLOW_NAMES];

/**
 * Which queue each workflow lands on. The noop proof rides `git-ops` — the
 * lightest real queue and the one the first real workflow (`scaffoldProject`,
 * task 17) uses — so the proof exercises the same dispatch path the earliest real
 * work will.
 */
export const WORKFLOW_QUEUE = {
  noopProof: "git-ops",
} as const satisfies Record<keyof typeof WORKFLOW_NAMES, QueueName>;
