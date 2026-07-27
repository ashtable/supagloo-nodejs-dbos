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

vi.mock("@dbos-inc/dbos-sdk", () => ({
  DBOS: {
    workflowID: "cleanup-1",
    registerWorkflow: (fn: unknown) => fn,
    runStep: async (fn: () => unknown, opts: { name: string }) => {
      stepNames.push(opts.name);
      return fn();
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

beforeEach(() => {
  vi.clearAllMocks();
  stepNames.length = 0;
  h.renderFindMany.mockResolvedValue([]);
  h.generationFindMany.mockResolvedValue([]);
  h.projectFindMany.mockResolvedValue([]);
  h.galleryFindMany.mockResolvedValue([]);
  h.sessionDeleteMany.mockResolvedValue({ count: 0 });
  h.sessionCount.mockResolvedValue(0);
  h.s3Send.mockImplementation(listingS3());
  setCleanupConfig({ retentionMs: 168 * HOUR, dryRun: false });
});

describe("cleanupOrphanedAssetsWorkflow — dry run", () => {
  beforeEach(() => {
    setCleanupConfig({ retentionMs: 168 * HOUR, dryRun: true });
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
    const where = h.sessionDeleteMany.mock.calls[0][0].where;
    expect(Object.keys(where)).toEqual(["expiresAt"]);
    expect(where.expiresAt).toHaveProperty("lt");
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
