import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@supagloo/database-lib";
import { finalizeImportRecords } from "./finalize";

// finalizeImportRecords is import's terminal step. Unlike scaffold (which writes TWO
// fixed versions v0.0.0/v0.0.1), import writes exactly ONE ProjectVersion — the
// resolved latest, `state: working`, with a FREE-FORM semver — and advances the Project
// to that version branch. Every write is idempotent under replay (Project update-in-
// place; ProjectVersion upserted by [projectId, semver]; ProjectJob update).

function makeFakePrisma() {
  const projectUpdate = vi.fn().mockResolvedValue(undefined);
  const versionUpsert = vi.fn().mockResolvedValue(undefined);
  const jobUpdate = vi.fn().mockResolvedValue(undefined);
  const prisma = {
    project: { update: projectUpdate },
    projectVersion: { upsert: versionUpsert },
    projectJob: { update: jobUpdate },
  } as unknown as PrismaClient;
  return { prisma, projectUpdate, versionUpsert, jobUpdate };
}

describe("finalizeImportRecords", () => {
  it("advances the Project, upserts ONE working ProjectVersion, and completes the job", async () => {
    const { prisma, projectUpdate, versionUpsert, jobUpdate } = makeFakePrisma();

    await finalizeImportRecords(prisma, "job-1", {
      projectId: "cprj1",
      repoOwner: "ashtable",
      repoName: "psalm-121",
      repoVisibility: "private",
      version: {
        semver: "0.10.0",
        branchName: "v0.10.0",
        headCommitSha: "abc123def456",
      },
    });

    // Project advanced to the resolved version branch + repo fields backfilled.
    expect(projectUpdate).toHaveBeenCalledTimes(1);
    const proj = projectUpdate.mock.calls[0][0];
    expect(proj.where).toEqual({ id: "cprj1" });
    expect(proj.data.currentBranch).toBe("v0.10.0");
    expect(proj.data.repoOwner).toBe("ashtable");
    expect(proj.data.repoName).toBe("psalm-121");
    expect(proj.data.repoVisibility).toBe("private");

    // Exactly ONE ProjectVersion — the resolved latest, working, free-form semver.
    expect(versionUpsert).toHaveBeenCalledTimes(1);
    const ver = versionUpsert.mock.calls[0][0];
    expect(ver.where).toEqual({
      projectId_semver: { projectId: "cprj1", semver: "0.10.0" },
    });
    expect(ver.create.semver).toBe("0.10.0");
    expect(ver.create.branchName).toBe("v0.10.0");
    expect(ver.create.state).toBe("working");
    expect(ver.create.headCommitSha).toBe("abc123def456");
    expect(ver.update.state).toBe("working");

    // Job succeeded, completed, every stage done.
    expect(jobUpdate).toHaveBeenCalledTimes(1);
    const job = jobUpdate.mock.calls[0][0];
    expect(job.where).toEqual({ id: "job-1" });
    expect(job.data.status).toBe("succeeded");
    expect(job.data.completedAt).toBeInstanceOf(Date);
    const stages = job.data.stages as Array<{ state: string }>;
    expect(stages.every((s) => s.state === "done")).toBe(true);
    expect(stages).toHaveLength(6);
  });
});
