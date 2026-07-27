import { describe, expect, it } from "vitest";
import {
  buildAssetKey,
  buildRenderOutputKey,
  buildRenderThumbnailKey,
} from "@supagloo/database-lib";
import {
  CLEANUP_RETENTION_HOURS_DEFAULT,
  ORPHAN_STATUSES,
  excludeReferencedKeys,
  generationAssetCandidates,
  isDeletableRenderObjectKey,
  renderKeyCandidates,
  renderObjectPrefix,
  retentionCutoff,
  selectOrphanedGenerations,
  selectOrphanedRenderJobs,
  type CleanupCandidate,
  type GenerationRow,
  type RenderJobRow,
} from "./selection";

/**
 * Plan row 42 — the PURE selection rules of `cleanupOrphanedAssetsWorkflow`.
 *
 * These are the rules that decide what gets DELETED from the one shared bucket and which
 * `Session` rows get purged, so they are unit-tested in isolation from Prisma, S3 and the
 * clock. Every constraint below is from brief §1.2 and is subtle enough to be worth a
 * named test rather than a comment.
 */

const HOUR = 3_600_000;
const NOW = new Date("2026-07-27T03:00:00.000Z");

const render = (over: Partial<RenderJobRow>): RenderJobRow => ({
  id: "rj-old",
  status: "failed",
  createdAt: new Date(NOW.getTime() - 400 * HOUR),
  completedAt: new Date(NOW.getTime() - 300 * HOUR),
  ...over,
});

const generation = (over: Partial<GenerationRow>): GenerationRow => ({
  id: "gen-old",
  projectId: "proj-1",
  status: "failed",
  createdAt: new Date(NOW.getTime() - 400 * HOUR),
  completedAt: new Date(NOW.getTime() - 300 * HOUR),
  ...over,
});

describe("retentionCutoff", () => {
  it("U-CL1: defaults to 7 days — the window that keeps the container's nightly run off fresh e2e fixtures", () => {
    expect(CLEANUP_RETENTION_HOURS_DEFAULT).toBe(168);
    expect(retentionCutoff(NOW, CLEANUP_RETENTION_HOURS_DEFAULT * HOUR)).toEqual(
      new Date(NOW.getTime() - 168 * HOUR),
    );
  });

  it("U-CL2: a zero window means 'everything terminal is in scope' (the e2e's setting)", () => {
    expect(retentionCutoff(NOW, 0)).toEqual(NOW);
  });
});

describe("selectOrphanedRenderJobs", () => {
  const cutoff = retentionCutoff(NOW, 168 * HOUR);

  it("U-CL3: selects only failed and canceled jobs", () => {
    expect([...ORPHAN_STATUSES].sort()).toEqual(["canceled", "failed"]);
    const rows = [
      render({ id: "a", status: "failed" }),
      render({ id: "b", status: "canceled" }),
      // `RenderStatus`'s terminal success is `completed`; AiGeneration's `JobStatus`
      // spells it `succeeded`. Both are covered, because one shared predicate serves both.
      render({ id: "c", status: "completed" }),
      render({ id: "d", status: "running" }),
      render({ id: "e", status: "queued" }),
    ];
    expect(selectOrphanedRenderJobs(rows, cutoff).map((r) => r.id)).toEqual(["a", "b"]);
  });

  it("U-CL4: a COMPLETED job is never selected however ancient — selection is status-driven, never 'unreferenced object'-driven", () => {
    const ancient = render({
      id: "published",
      status: "completed",
      createdAt: new Date(0),
      completedAt: new Date(0),
    });
    expect(selectOrphanedRenderJobs([ancient], cutoff)).toEqual([]);
  });

  it("U-CL5: a failed job INSIDE the retention window is untouched", () => {
    const fresh = render({
      id: "fresh",
      createdAt: new Date(NOW.getTime() - 2 * HOUR),
      completedAt: new Date(NOW.getTime() - 1 * HOUR),
    });
    expect(selectOrphanedRenderJobs([fresh], cutoff)).toEqual([]);
  });

  it("U-CL6: ages on completedAt, falling back to createdAt so a never-finalized row is not immortal", () => {
    // completedAt is INSIDE the window, createdAt is outside ⇒ not selected.
    const recentlyFinished = render({
      id: "recent-finish",
      createdAt: new Date(NOW.getTime() - 400 * HOUR),
      completedAt: new Date(NOW.getTime() - 1 * HOUR),
    });
    // no completedAt at all (crashed before any terminal writer ran) ⇒ aged on createdAt.
    const neverFinalized = render({
      id: "never-finalized",
      createdAt: new Date(NOW.getTime() - 400 * HOUR),
      completedAt: null,
    });
    expect(selectOrphanedRenderJobs([recentlyFinished, neverFinalized], cutoff).map((r) => r.id)).toEqual(
      ["never-finalized"],
    );
  });

  it("U-CL7: the boundary is strict — age exactly at the cutoff is NOT collected", () => {
    const exactly = render({ id: "boundary", completedAt: cutoff, createdAt: cutoff });
    expect(selectOrphanedRenderJobs([exactly], cutoff)).toEqual([]);
  });
});

describe("selectOrphanedGenerations", () => {
  const cutoff = retentionCutoff(NOW, 168 * HOUR);

  it("U-CL8: same status + retention rules as renders", () => {
    const rows = [
      generation({ id: "g-failed", status: "failed" }),
      generation({ id: "g-canceled", status: "canceled" }),
      generation({ id: "g-ok", status: "succeeded" }),
      generation({
        id: "g-fresh",
        completedAt: new Date(NOW.getTime() - 1 * HOUR),
        createdAt: new Date(NOW.getTime() - 2 * HOUR),
      }),
    ];
    expect(selectOrphanedGenerations(rows, cutoff).map((r) => r.id)).toEqual([
      "g-failed",
      "g-canceled",
    ]);
  });
});

describe("key candidates come from db-lib's builders, never hand-built strings", () => {
  it("U-CL9: a render contributes exactly its output + thumbnail keys", () => {
    expect(renderKeyCandidates("rj-1").map((c) => c.key)).toEqual([
      buildRenderOutputKey("rj-1"),
      buildRenderThumbnailKey("rj-1"),
    ]);
    expect(renderKeyCandidates("rj-1").map((c) => c.reason)).toEqual([
      "render-output",
      "render-thumbnail",
    ]);
  });

  it("U-CL10: a generation contributes exactly its project asset key", () => {
    expect(generationAssetCandidates(generation({ id: "g1", projectId: "p1" }))).toEqual([
      { key: buildAssetKey("p1", "g1"), reason: "generation-asset", sourceId: "g1" },
    ]);
  });

  it("U-CL11: a generation with NO projectId contributes nothing — no key can be built for it", () => {
    expect(generationAssetCandidates(generation({ id: "g1", projectId: null }))).toEqual([]);
  });

  it("U-CL12: the render listing prefix is the render's own directory, nothing broader", () => {
    expect(renderObjectPrefix("rj-1")).toBe("renders/rj-1/");
    // Never the whole `renders/` tree — a prefix bug here would list every render ever.
    expect(renderObjectPrefix("rj-1")).not.toBe("renders/");
  });
});

describe("isDeletableRenderObjectKey — parseS3Key admission, never string matching", () => {
  it("U-CL13: admits exactly the two canonical render keys for THIS job", () => {
    expect(isDeletableRenderObjectKey(buildRenderOutputKey("rj-1"), "rj-1")).toBe(true);
    expect(isDeletableRenderObjectKey(buildRenderThumbnailKey("rj-1"), "rj-1")).toBe(true);
  });

  it("U-CL14: refuses a key belonging to a DIFFERENT render job", () => {
    expect(isDeletableRenderObjectKey(buildRenderOutputKey("rj-2"), "rj-1")).toBe(false);
  });

  it("U-CL15: refuses a stray/unrecognized object under the same prefix", () => {
    // A ListObjectsV2 under `renders/rj-1/` returns whatever is there. Anything the shared
    // db-lib layout does not recognize is left alone rather than guessed at.
    expect(isDeletableRenderObjectKey("renders/rj-1/scratch.tmp", "rj-1")).toBe(false);
    expect(isDeletableRenderObjectKey("renders/rj-1/nested/output.mp4", "rj-1")).toBe(false);
    expect(isDeletableRenderObjectKey("renders/rj-1/", "rj-1")).toBe(false);
  });

  it("U-CL16: refuses a project-asset key even if it somehow surfaced in a render listing", () => {
    expect(isDeletableRenderObjectKey(buildAssetKey("p1", "a1"), "rj-1")).toBe(false);
  });
});

describe("excludeReferencedKeys", () => {
  const candidates: CleanupCandidate[] = [
    { key: buildRenderOutputKey("rj-1"), reason: "render-output", sourceId: "rj-1" },
    { key: buildRenderThumbnailKey("rj-1"), reason: "render-thumbnail", sourceId: "rj-1" },
  ];

  it("U-CL17: drops a key a Project.thumbnailAssetKey still points at (a canceled render's uploaded thumb)", () => {
    const kept = excludeReferencedKeys(candidates, [buildRenderThumbnailKey("rj-1")]);
    expect(kept.map((c) => c.key)).toEqual([buildRenderOutputKey("rj-1")]);
  });

  it("U-CL18: keeps everything when nothing references it", () => {
    expect(excludeReferencedKeys(candidates, [])).toEqual(candidates);
  });

  it("U-CL19: ignores null/undefined reference columns rather than treating them as keys", () => {
    const kept = excludeReferencedKeys(candidates, [null, undefined, ""]);
    expect(kept).toEqual(candidates);
  });
});

// U-CL20/21/22 covered `isExpiredSession`, which Step-11 item 20 (R42-5) DELETED. It had no
// production consumer and structurally could not acquire one — `purgeExpiredSessions` selects
// with a Prisma `where`, and a row predicate cannot build a query. Three green tests over a
// function nothing calls read as coverage of the destructive purge's selection rule while
// covering none of it. The rule itself is now pinned where it is actually decided:
// `cleanup-orphaned-assets.test.ts` U-CLW4 asserts the whole `where` object (column AND the
// instant), and U-CLW4b proves the instant is step 1's checkpointed clock under a replay.
