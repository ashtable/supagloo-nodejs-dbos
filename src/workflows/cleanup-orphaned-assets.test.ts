import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  DeleteObjectsCommand,
  ListObjectsV2Command,
  type S3Client,
} from "@aws-sdk/client-s3";
import {
  buildAssetKey,
  buildRenderOutputKey,
  buildRenderThumbnailKey,
} from "@supagloo/database-lib";

/**
 * Plan row 42 — the workflow's ORCHESTRATION, and above all its **dry-run listing mode**.
 *
 * The row's Unit column asks for "retention-window selection … expired-session selection …
 * dry-run listing logic". The first two are pure and live in `selection.test.ts`; this file
 * covers the third and the wiring, using the repo's established SDK mock (the
 * `dbos-typescript` skill's `test-setup` rule): `registerWorkflow` returns the raw function,
 * `runStep` invokes its callback.
 *
 * The dry-run assertion is deliberately hostile rather than polite: the fake S3 client
 * THROWS on `DeleteObjectsCommand`, so "performs zero S3 mutations" is proven by the test
 * being unable to pass otherwise — not by counting calls that a refactor could stop making.
 * This is the ONLY S3 delete path in the design (design-delta §8:1401-1403), so a dry run
 * that quietly deleted would be unrecoverable in the one shared bucket.
 */

const HOUR = 3_600_000;

const h = vi.hoisted(() => ({
  renderFindMany: vi.fn(),
  generationFindMany: vi.fn(),
  projectFindMany: vi.fn(),
  galleryFindMany: vi.fn(),
  sessionDeleteMany: vi.fn(),
  sessionCount: vi.fn(),
  s3Send: vi.fn(),
}));

const stepNames: string[] = [];

/**
 * How far the wall clock advances at each step boundary (Step-11 item 20).
 *
 * Default 0, so every existing case is unaffected. U-CLW4b sets it under fake timers to model
 * the thing the replay-determinism line actually defends against: steps that execute MINUTES
 * apart. With all four steps landing in the same millisecond — which is what the mocked
 * `runStep` otherwise produces — `new Date(selection.now)` and a fresh `new Date()` are
 * indistinguishable, and an equality assertion against the shared instant passes for both.
 */
const stepClock = { advanceMs: 0 };

/**
 * Step-11 item 11 (R42-2): captured `DBOS.logger` output. The workflow returned its result
 * object SILENTLY, while root's `.env.example` told operators the dry run "LOGS the exact
 * delete set" — so the documented rehearsal step printed nothing, and an operator would
 * reasonably conclude there were no orphans and turn the flag off.
 */
const logs = vi.hoisted(() => ({
  info: [] as unknown[][],
  warn: [] as unknown[][],
  error: [] as unknown[][],
}));

vi.mock("@dbos-inc/dbos-sdk", () => ({
  DBOS: {
    workflowID: "cleanup-1",
    registerWorkflow: (fn: unknown) => fn,
    runStep: async (fn: () => unknown, opts: { name: string }) => {
      stepNames.push(opts.name);
      if (stepClock.advanceMs > 0) vi.advanceTimersByTime(stepClock.advanceMs);
      return fn();
    },
    logger: {
      info: (...args: unknown[]) => logs.info.push(args),
      warn: (...args: unknown[]) => logs.warn.push(args),
      error: (...args: unknown[]) => logs.error.push(args),
      debug: () => {},
    },
  },
}));

vi.mock("../db/app-db", () => ({
  getAppDb: () => ({
    renderJob: { findMany: h.renderFindMany },
    aiGeneration: { findMany: h.generationFindMany },
    project: { findMany: h.projectFindMany },
    galleryItem: { findMany: h.galleryFindMany },
    session: { deleteMany: h.sessionDeleteMany, count: h.sessionCount },
  }),
}));

vi.mock("../files/s3-config", () => ({
  getS3Config: () => ({
    client: { send: h.s3Send } as unknown as S3Client,
    bucket: "supagloo-dev",
  }),
}));

import { cleanupOrphanedAssetsWorkflow } from "./cleanup-orphaned-assets";
import { clearCleanupConfig, setCleanupConfig } from "./cleanup-orphaned-assets/config";

const OLD = new Date(Date.now() - 400 * HOUR);

/** A stock listing responder: every render prefix holds both canonical objects. */
function listingS3(): (cmd: unknown) => Promise<unknown> {
  return (cmd: unknown) => {
    if (cmd instanceof ListObjectsV2Command) {
      const prefix = cmd.input.Prefix ?? "";
      const id = prefix.replace(/^renders\//, "").replace(/\/$/, "");
      if (prefix.startsWith("renders/")) {
        return Promise.resolve({
          IsTruncated: false,
          Contents: [
            { Key: buildRenderOutputKey(id) },
            { Key: buildRenderThumbnailKey(id) },
          ],
        });
      }
      // A project-asset prefix: the exact key, present.
      return Promise.resolve({ IsTruncated: false, Contents: [{ Key: prefix }] });
    }
    if (cmd instanceof DeleteObjectsCommand) {
      return Promise.resolve({
        Deleted: (cmd.input.Delete?.Objects ?? []).map((o) => ({ Key: o.Key })),
      });
    }
    throw new Error(`unexpected S3 command: ${String(cmd)}`);
  };
}

/** Every string the workflow logged at a given level, flattened. */
const loggedText = (level: "info" | "warn" | "error"): string =>
  logs[level].map((args) => args.map((a) => String(a)).join(" ")).join("\n");

beforeEach(() => {
  vi.clearAllMocks();
  stepNames.length = 0;
  logs.info.length = 0;
  logs.warn.length = 0;
  logs.error.length = 0;
  h.renderFindMany.mockResolvedValue([]);
  h.generationFindMany.mockResolvedValue([]);
  h.projectFindMany.mockResolvedValue([]);
  h.galleryFindMany.mockResolvedValue([]);
  h.sessionDeleteMany.mockResolvedValue({ count: 0 });
  h.sessionCount.mockResolvedValue(0);
  h.s3Send.mockImplementation(listingS3());
  setCleanupConfig({ retentionMs: 168 * HOUR, dryRun: false, maxItemsPerRun: 500 });
});

describe("cleanupOrphanedAssetsWorkflow — dry run", () => {
  beforeEach(() => {
    setCleanupConfig({ retentionMs: 168 * HOUR, dryRun: true, maxItemsPerRun: 500 });
    h.renderFindMany.mockResolvedValue([
      { id: "rj-dead", status: "failed", createdAt: OLD, completedAt: OLD },
    ]);
    h.sessionCount.mockResolvedValue(3);
  });

  it("U-CLW1: performs ZERO S3 mutations — the fake client throws if DeleteObjects is ever sent", async () => {
    const listOnly = listingS3();
    h.s3Send.mockImplementation((cmd: unknown) => {
      if (cmd instanceof DeleteObjectsCommand) {
        throw new Error("dry run must never send DeleteObjectsCommand");
      }
      return listOnly(cmd);
    });

    const result = await cleanupOrphanedAssetsWorkflow(new Date(), new Date());

    expect(result.dryRun).toBe(true);
    expect(result.deletedKeys).toEqual([]);
  });

  it("U-CLW2: still reports the EXACT delete set it would have removed", async () => {
    const result = await cleanupOrphanedAssetsWorkflow(new Date(), new Date());

    expect(result.plannedKeys).toEqual([
      buildRenderOutputKey("rj-dead"),
      buildRenderThumbnailKey("rj-dead"),
    ]);
  });

  it("U-CLW3: purges NO sessions, but reports how many would have gone", async () => {
    const result = await cleanupOrphanedAssetsWorkflow(new Date(), new Date());

    expect(h.sessionDeleteMany).not.toHaveBeenCalled();
    expect(result.expiredSessions).toBe(3);
    expect(result.sessionsPurged).toBe(0);
  });
});

describe("cleanupOrphanedAssetsWorkflow — real run", () => {
  it("U-CLW4: deletes exactly the planned keys and purges exactly the expired sessions", async () => {
    h.renderFindMany.mockResolvedValue([
      { id: "rj-dead", status: "canceled", createdAt: OLD, completedAt: OLD },
    ]);
    h.generationFindMany.mockResolvedValue([
      { id: "gen-dead", projectId: "proj-1", status: "failed", createdAt: OLD, completedAt: OLD },
    ]);
    h.sessionDeleteMany.mockResolvedValue({ count: 2 });

    const result = await cleanupOrphanedAssetsWorkflow(new Date(), new Date());

    expect(result.deletedKeys.sort()).toEqual(
      [
        buildRenderOutputKey("rj-dead"),
        buildRenderThumbnailKey("rj-dead"),
        buildAssetKey("proj-1", "gen-dead"),
      ].sort(),
    );
    expect(result.sessionsPurged).toBe(2);
    // The purge keys on expiresAt ONLY — createdAt/lastUsedAt would evict live users,
    // because sessions are sliding (every authenticated request re-stamps expiresAt).
    //
    // Step-11 item 20 (R42-5): asserted as a WHOLE-OBJECT equality against
    // `new Date(result.now)`, which pins the column AND the SHARED INSTANT in one statement.
    // The old form — `Object.keys(where) === ["expiresAt"]` plus `toHaveProperty("lt")` —
    // said nothing about the VALUE, so mutating `new Date(selection.now)` to `new Date()`
    // survived every unit test and the e2e too (which seeds sessions far past expiry, so any
    // recent instant selects the same rows). That line decides which rows a DESTRUCTIVE purge
    // selects ON REPLAY: with a fresh clock, a replay minutes later purges a strictly larger
    // set than the one the original execution decided on — including sessions that were live
    // when the workflow started.
    const where = h.sessionDeleteMany.mock.calls[0][0].where;
    expect(where).toEqual({ expiresAt: { lt: new Date(result.now) } });
  });

  it("U-CLW4b: the purge instant is STEP 1's clock, even when the steps run minutes apart", async () => {
    // THE item-20 assertion. `purgeExpiredSessions` must build its `where` from
    // `selection.now` — the instant checkpointed by step 1 — and never from a fresh clock.
    // On replay DBOS returns step 1's memo and re-executes the uncheckpointed tail, which
    // can be minutes or days later; a fresh clock there means the replay deletes a strictly
    // LARGER set than the execution decided on, including sessions that were live at start.
    // Fake timers make that difference observable instead of a same-millisecond coincidence.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-27T03:00:00.000Z"));
    stepClock.advanceMs = 60_000;
    try {
      h.renderFindMany.mockResolvedValue([]);
      h.generationFindMany.mockResolvedValue([]);
      h.sessionDeleteMany.mockResolvedValue({ count: 2 });

      const result = await cleanupOrphanedAssetsWorkflow(new Date(), new Date());

      // Step 1 ran first, so its clock is the earliest of the four.
      expect(result.now).toBe("2026-07-27T03:01:00.000Z");
      const where = h.sessionDeleteMany.mock.calls[0][0].where;
      expect(where).toEqual({ expiresAt: { lt: new Date(result.now) } });
      // And explicitly NOT the clock step 4 would have read: three further boundaries later.
      expect((where.expiresAt.lt as Date).toISOString()).not.toBe("2026-07-27T03:04:00.000Z");
    } finally {
      stepClock.advanceMs = 0;
      vi.useRealTimers();
    }
  });

  it("U-CLW5: never touches a COMPLETED render's objects, however ancient", async () => {
    // The DB read itself is status-filtered; this pins that the workflow does not widen it.
    h.renderFindMany.mockResolvedValue([]);

    const result = await cleanupOrphanedAssetsWorkflow(new Date(), new Date());

    expect(result.deletedKeys).toEqual([]);
    const statusFilter = h.renderFindMany.mock.calls[0][0].where.status;
    expect(statusFilter).toEqual({ in: ["failed", "canceled"] });
  });

  it("U-CLW6: excludes a key a live Project row still references", async () => {
    h.renderFindMany.mockResolvedValue([
      { id: "rj-dead", status: "canceled", createdAt: OLD, completedAt: OLD },
    ]);
    // A canceled render CAN have uploaded a thumbnail that the project now points at
    // (design-delta §2.6:228) — deleting it would blank a live project card.
    h.projectFindMany.mockResolvedValue([
      { thumbnailAssetKey: buildRenderThumbnailKey("rj-dead") },
    ]);

    const result = await cleanupOrphanedAssetsWorkflow(new Date(), new Date());

    expect(result.deletedKeys).toEqual([buildRenderOutputKey("rj-dead")]);
  });

  it("U-CLW7: runs its four named steps in order", async () => {
    await cleanupOrphanedAssetsWorkflow(new Date(), new Date());

    expect(stepNames).toEqual([
      "selectOrphanCandidates",
      "listOrphanObjects",
      "deleteOrphanObjects",
      "purgeExpiredSessions",
    ]);
  });

  it("U-CLW8: only deletes objects that ACTUALLY exist in the bucket", async () => {
    h.renderFindMany.mockResolvedValue([
      { id: "rj-dead", status: "failed", createdAt: OLD, completedAt: OLD },
    ]);
    // A failed render that never reached `uploadOutputs` has NO objects at all — the
    // common case, since asset keys are only written on success.
    h.s3Send.mockImplementation((cmd: unknown) => {
      if (cmd instanceof ListObjectsV2Command) {
        return Promise.resolve({ IsTruncated: false, Contents: [] });
      }
      throw new Error("nothing to delete — DeleteObjects must not be sent");
    });

    const result = await cleanupOrphanedAssetsWorkflow(new Date(), new Date());

    expect(result.plannedKeys).toEqual([]);
    expect(result.deletedKeys).toEqual([]);
  });

  it("U-CLW9: refuses to run without injected config, rather than defaulting to delete-everything", () => {
    clearCleanupConfig();
    return expect(
      cleanupOrphanedAssetsWorkflow(new Date(), new Date()),
    ).rejects.toThrow(/cleanup config not initialized/);
  });
});

/**
 * Step-11 item 11 (R42-2) — THE SWEEP MUST REPORT ITSELF.
 *
 * The defect, verified: zero `logger` and zero `console.` hits anywhere in the workflow. The
 * result object was returned to whoever invoked the workflow, and the nightly invoker is the
 * SCHEDULER — nobody reads it. Two consequences, both silent:
 *
 *   1. Root's `.env.example` documents `CLEANUP_DRY_RUN` as the rehearsal that "LOGS the
 *      exact delete set". It logged nothing. An operator runs the rehearsal, sees no output,
 *      concludes there are no orphans, and turns the flag off — and the next night 315
 *      objects are deleted unseen.
 *   2. `deleteErrors` (per-key S3 failures) was returned and read by nobody, so an
 *      `AccessDenied` bucket policy produces a SUCCESSFUL nightly no-op forever.
 *
 * Keys are not secrets (they are `renders/<id>/…` and `projects/<id>/<gen>` paths), so
 * `redactForLog` is deliberately not involved — that would turn the diagnostic into noise.
 */
describe("cleanupOrphanedAssetsWorkflow — the sweep reports itself (item 11)", () => {
  const rjDead = { id: "rj-dead", status: "failed", createdAt: OLD, completedAt: OLD };

  it("U-CLW10: logs a one-line summary on every run — dryRun, cutoff, and the three counts", async () => {
    h.renderFindMany.mockResolvedValue([rjDead]);
    h.sessionDeleteMany.mockResolvedValue({ count: 4 });

    const result = await cleanupOrphanedAssetsWorkflow(new Date(), new Date());

    const text = loggedText("info");
    expect(text).toContain("cleanupOrphanedAssets");
    expect(text).toContain(`dryRun=false`);
    expect(text).toContain(`cutoff=${result.cutoff}`);
    expect(text).toContain(`planned=2`);
    expect(text).toContain(`deleted=2`);
    expect(text).toContain(`sessionsPurged=4`);
  });

  it("U-CLW11: in DRY RUN, logs EVERY planned key — the rehearsal .env.example promises", async () => {
    setCleanupConfig({ retentionMs: 168 * HOUR, dryRun: true, maxItemsPerRun: 500 });
    h.renderFindMany.mockResolvedValue([rjDead]);

    const result = await cleanupOrphanedAssetsWorkflow(new Date(), new Date());

    expect(result.plannedKeys.length).toBe(2);
    const text = loggedText("info");
    expect(text).toContain("dryRun=true");
    for (const key of result.plannedKeys) {
      expect(text).toContain(key);
    }
  });

  it("U-CLW12: a real run does NOT dump the whole key list — only the counts", async () => {
    // The dry run is the rehearsal; the nightly run must stay one line, or a 500-key sweep
    // buries every other line in the shared Compose log stream.
    h.renderFindMany.mockResolvedValue([rjDead]);

    const result = await cleanupOrphanedAssetsWorkflow(new Date(), new Date());

    expect(result.plannedKeys.length).toBe(2);
    expect(loggedText("info")).not.toContain(result.plannedKeys[0]);
  });

  it("U-CLW13: logs at ERROR when deleteAssets reports per-key failures", async () => {
    h.renderFindMany.mockResolvedValue([rjDead]);
    const listOnly = listingS3();
    h.s3Send.mockImplementation((cmd: unknown) => {
      if (cmd instanceof DeleteObjectsCommand) {
        // The realistic shape: a bucket policy denies deletes, so every key comes back as an
        // Error and NOTHING is deleted — while the workflow still resolves successfully.
        return Promise.resolve({
          Deleted: [],
          Errors: (cmd.input.Delete?.Objects ?? []).map((o) => ({
            Key: o.Key,
            Code: "AccessDenied",
            Message: "Access Denied",
          })),
        });
      }
      return listOnly(cmd);
    });

    const result = await cleanupOrphanedAssetsWorkflow(new Date(), new Date());

    expect(result.deletedKeys).toEqual([]);
    expect(result.deleteErrors.length).toBe(2);
    const text = loggedText("error");
    expect(text).toContain("AccessDenied");
    expect(text).toContain("cleanupOrphanedAssets");
  });

  it("U-CLW14: stays silent at ERROR level when nothing failed", async () => {
    h.renderFindMany.mockResolvedValue([rjDead]);
    await cleanupOrphanedAssetsWorkflow(new Date(), new Date());
    expect(logs.error).toEqual([]);
  });
});

/**
 * Step-11 item 12 (R42-3) — PER-RUN WORK MUST BE BOUNDED.
 *
 * Reproduced on the live dev DB: 134 orphaned render jobs + 181 orphaned generations = exactly
 * **315 sequential `ListObjectsV2` calls inside ONE step**, and that number only ever grows,
 * because there is no `take`, no `orderBy` and no watermark — a failed job stays a candidate
 * for ever, and its objects mostly do not exist, so nothing ever removes it from the set. Two
 * consequences:
 *
 *   • the step's own duration grows without bound, and because all 315 LISTs live in ONE
 *     DBOS step, a crash at LIST 300 discards all 300 and starts over on recovery;
 *   • `referencedKeys` was four WHOLE-TABLE reads, serialized into `operation_outputs` as a
 *     single very large checkpoint, every night, for ever.
 *
 * The fix is two-part and neither part weakens the exclusion rule:
 *   (a) `take: cfg.maxItemsPerRun` + `orderBy: { createdAt: "asc" }` on both candidate
 *       queries — a bounded batch, oldest first, so the sweep converges on the backlog
 *       instead of sampling it;
 *   (b) the referenced-key reads are scoped to `{ in: candidateKeys }`. The candidate key set
 *       is fully known inside step 1 (before any S3 listing), and the only question those
 *       reads answer is "does any live row point at one of THESE keys" — so the narrowing is
 *       information-preserving. U-CLW6 and U-CLW17 hold that.
 */
describe("cleanupOrphanedAssetsWorkflow — bounded per-run work (item 12)", () => {
  /** The candidate query for a model: the one selecting rows (`id`), not asset keys. */
  const candidateCall = (m: typeof h.renderFindMany) =>
    m.mock.calls.find((c) => (c[0] as { select?: Record<string, unknown> })?.select?.id)?.[0] as
      | { take?: number; orderBy?: unknown; where?: Record<string, unknown> }
      | undefined;

  /** A referenced-key read: the one selecting asset-key columns. */
  const referencedCall = (m: typeof h.renderFindMany) =>
    m.mock.calls.find((c) => !(c[0] as { select?: Record<string, unknown> })?.select?.id)?.[0] as
      | { where?: unknown; select?: unknown }
      | undefined;

  beforeEach(() => {
    h.renderFindMany.mockResolvedValue([
      { id: "rj-dead", status: "failed", createdAt: OLD, completedAt: OLD },
    ]);
    h.generationFindMany.mockResolvedValue([
      { id: "gen-dead", projectId: "proj-1", status: "failed", createdAt: OLD, completedAt: OLD },
    ]);
  });

  it("U-CLW15: BOTH candidate queries carry `take` = maxItemsPerRun and `orderBy` createdAt asc", async () => {
    setCleanupConfig({ retentionMs: 168 * HOUR, dryRun: true, maxItemsPerRun: 7 });

    await cleanupOrphanedAssetsWorkflow(new Date(), new Date());

    for (const [label, model] of [
      ["renderJob", h.renderFindMany],
      ["aiGeneration", h.generationFindMany],
    ] as const) {
      const call = candidateCall(model);
      expect(call, label).toBeDefined();
      // Bounded: without `take` the set grows for ever and so does the single-step LIST loop.
      expect(call!.take, label).toBe(7);
      // Oldest first: the cap then makes PROGRESS on the backlog rather than re-reading the
      // same arbitrary slice of it every night.
      expect(call!.orderBy, label).toEqual({ createdAt: "asc" });
      // And the status filter is untouched — a succeeded job's rows still never enter.
      expect(call!.where?.status, label).toEqual({ in: ["failed", "canceled"] });
    }
  });

  it("U-CLW16: every referenced-key read is scoped to the candidate keys, not the whole table", async () => {
    setCleanupConfig({ retentionMs: 168 * HOUR, dryRun: true, maxItemsPerRun: 500 });

    await cleanupOrphanedAssetsWorkflow(new Date(), new Date());

    const expectedKeys = [
      buildRenderOutputKey("rj-dead"),
      buildRenderThumbnailKey("rj-dead"),
      buildAssetKey("proj-1", "gen-dead"),
    ].sort();

    /** Every `{ in: [...] }` list appearing anywhere in a `where` clause. */
    const inLists = (where: unknown): string[][] => {
      const out: string[][] = [];
      const walk = (node: unknown): void => {
        if (Array.isArray(node)) return node.forEach(walk);
        if (node && typeof node === "object") {
          for (const [k, v] of Object.entries(node)) {
            if (k === "in" && Array.isArray(v)) out.push([...(v as string[])].sort());
            else walk(v);
          }
        }
      };
      walk(where);
      return out;
    };

    for (const [label, model] of [
      ["project", h.projectFindMany],
      ["renderJob", h.renderFindMany],
      ["aiGeneration", h.generationFindMany],
      ["galleryItem", h.galleryFindMany],
    ] as const) {
      const call = referencedCall(model);
      expect(call, label).toBeDefined();
      const lists = inLists(call!.where);
      expect(lists.length, label).toBeGreaterThan(0);
      for (const list of lists) expect(list, label).toEqual(expectedKeys);
    }
  });

  it("U-CLW17: a candidate key referenced by a NON-candidate row is still excluded", async () => {
    // The narrowing must not lose the exclusion. `gal-live` is a GalleryItem — a row type that
    // is never a cleanup candidate — pointing at the dead render's output. Scoping the read to
    // the candidate KEYS (not to candidate ROWS) is what keeps it visible.
    setCleanupConfig({ retentionMs: 168 * HOUR, dryRun: false, maxItemsPerRun: 500 });
    h.generationFindMany.mockResolvedValue([]);
    h.galleryFindMany.mockResolvedValue([
      { videoAssetKey: buildRenderOutputKey("rj-dead"), thumbnailAssetKey: null },
    ]);

    const result = await cleanupOrphanedAssetsWorkflow(new Date(), new Date());

    expect(result.plannedKeys).toEqual([buildRenderThumbnailKey("rj-dead")]);
    expect(result.deletedKeys).toEqual([buildRenderThumbnailKey("rj-dead")]);
  });

  it("U-CLW18: with no candidates at all, the referenced-key reads are skipped entirely", async () => {
    // `{ in: [] }` is a pointless round trip, and four of them every night on a clean system
    // is the common case once the backlog is drained.
    setCleanupConfig({ retentionMs: 168 * HOUR, dryRun: true, maxItemsPerRun: 500 });
    h.renderFindMany.mockResolvedValue([]);
    h.generationFindMany.mockResolvedValue([]);

    const result = await cleanupOrphanedAssetsWorkflow(new Date(), new Date());

    expect(result.plannedKeys).toEqual([]);
    expect(h.projectFindMany).not.toHaveBeenCalled();
    expect(h.galleryFindMany).not.toHaveBeenCalled();
    // Exactly one call each: the candidate query, and no referenced-key follow-up.
    expect(h.renderFindMany).toHaveBeenCalledTimes(1);
    expect(h.generationFindMany).toHaveBeenCalledTimes(1);
  });
});
