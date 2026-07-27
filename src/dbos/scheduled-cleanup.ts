import { DBOS } from "@dbos-inc/dbos-sdk";
import { SchedulerMode } from "@dbos-inc/dbos-sdk";
import { WORKFLOW_NAMES, WORKFLOW_QUEUE } from "./registry";
import { cleanupOrphanedAssetsWorkflow } from "../workflows/cleanup-orphaned-assets";

/**
 * Plan row 42 / **D42.1** — the schedule, and the fence around it.
 *
 * THIS MODULE MUST BE IMPORTED BY `src/main.ts` AND BY NOTHING ELSE.
 *
 * `cleanupOrphanedAssetsWorkflow` deletes objects from the ONE shared `supagloo-dev`
 * bucket and rows from the shared app database. Fifteen e2e lanes launch the REAL DBOS
 * runtime IN-PROCESS against that same bucket and that same database — only the DBOS
 * *system* schema is per-lane. Arming the schedule anywhere `runtime.ts` can reach would
 * therefore arm it inside every lane, against fixtures another spec is mid-assertion on,
 * including the `Session` rows the api's own test-seed endpoint mints.
 *
 * The guard is STRUCTURAL rather than configurational, and that choice is the point. The
 * alternative — an env flag consulted at registration — is one forgotten variable away
 * from a destructive nightly sweep inside a test lane, and nothing would fail loudly when
 * it happened. Here the lanes call `launchDbos()` from `runtime.ts` and never load
 * `main.ts`, so the schedule is inert in lanes BY CONSTRUCTION: there is no flag to set,
 * no hook to remember, and no way for a future spec to turn it on by accident.
 * `scheduled-cleanup.fence.test.ts` asserts the shape — structurally, by reading the
 * source, never by booting a runtime and watching for a schedule that should not fire.
 *
 * WHY `registerScheduled` AND NOT `applySchedules`. The `dbos-typescript` skill marks
 * `DBOS.registerScheduled` (and `@DBOS.scheduled`) DEPRECATED in favour of
 * `DBOS.applySchedules`/`DBOS.createSchedule`, which persist schedules in the database and
 * can be paused, resumed and backfilled at runtime — and both APIs do exist in the pinned
 * `@dbos-inc/dbos-sdk@4.23.6`. This run implements `registerScheduled` because the Step-2–5
 * brief names it explicitly and this is an implementation step, not a re-litigation; it
 * works on the pinned SDK and satisfies the fence exactly. **Migrating to
 * `DBOS.applySchedules`, called from `main.ts` after `launchDbos(env)`, is recorded as the
 * follow-up** (`scratch/task-42-cleanup-orphaned-assets.md` §1): the fence gets stronger
 * (an explicit call rather than an import side effect) and `automaticBackfill: false` is
 * the direct equivalent of the mode chosen below.
 */

/** D42.4 — daily at 03:00. The cadence is the design's; the hour is free. */
export const CLEANUP_CRONTAB = "0 3 * * *";

/**
 * D42.3 — **no make-up work**. `ExactlyOncePerInterval` would backfill every slot missed
 * while the app was down, so a laptop switched off for a week would fire seven catch-up
 * destructive sweeps in a row at boot, against the shared dev database. A janitor has
 * nothing to catch up on: the next nightly run sees everything the missed ones would have.
 */
export const CLEANUP_SCHEDULER_MODE = SchedulerMode.ExactlyOncePerIntervalWhenActive;

// Module-load side effect, matching the repo's static-registration discipline: the SET of
// schedules is fixed in source at authoring time, exactly like the queue and workflow sets
// in `registry.ts`. The name is passed EXPLICITLY (rather than inferred from `fn.name`)
// so the scheduler binds to the same registry name `DBOS.registerWorkflow` used.
DBOS.registerScheduled(cleanupOrphanedAssetsWorkflow, {
  name: WORKFLOW_NAMES.cleanupOrphanedAssets,
  crontab: CLEANUP_CRONTAB,
  mode: CLEANUP_SCHEDULER_MODE,
  // Routed through the `maintenance` queue (workerConcurrency 1) rather than started
  // immediately, so two overlapping sweeps can never race on the same delete set, and so
  // the nightly sweep never occupies a slot the user-facing git-ops work is waiting on.
  queueName: WORKFLOW_QUEUE.cleanupOrphanedAssets,
});
