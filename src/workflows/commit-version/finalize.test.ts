import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@supagloo/database-lib";
import { updateCommitVersionRecord } from "./finalize";

// updateCommitVersionRecord is commit's terminal step. Unlike scaffold/import (which
// ADVANCE the Project to a new branch), commit stays on the SAME working branch — so it
// UPDATES the EXISTING working ProjectVersion row in place (upsert by [projectId, semver],
// same semver) with the commit's headSha/changedFiles/message, marks the job succeeded,
// and does NOT touch the Project row. Idempotent under replay (upsert-in-place).

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

describe("updateCommitVersionRecord", () => {
  it("upserts the working version in place and completes the job, leaving the Project untouched", async () => {
    const { prisma, projectUpdate, versionUpsert, jobUpdate } = makeFakePrisma();

    await updateCommitVersionRecord(prisma, "job-1", {
      projectId: "cprj1",
      semver: "0.0.1",
      branchName: "v0.0.1",
      headCommitSha: "a".repeat(40),
      commitMessage: "Tighten the shelter pacing",
      changedFiles: ["M src/scenes/Shelter.tsx", "M supagloo.project.json"],
    });

    // The commit does NOT advance the branch — the Project row is not written.
    expect(projectUpdate).not.toHaveBeenCalled();

    // Exactly ONE ProjectVersion upsert, keyed by the working (projectId, semver).
    expect(versionUpsert).toHaveBeenCalledTimes(1);
    const ver = versionUpsert.mock.calls[0][0];
    expect(ver.where).toEqual({
      projectId_semver: { projectId: "cprj1", semver: "0.0.1" },
    });
    expect(ver.create.semver).toBe("0.0.1");
    expect(ver.create.branchName).toBe("v0.0.1");
    expect(ver.create.state).toBe("working");
    expect(ver.create.headCommitSha).toBe("a".repeat(40));
    expect(ver.create.commitMessage).toBe("Tighten the shelter pacing");
    expect(ver.create.changedFiles).toEqual([
      "M src/scenes/Shelter.tsx",
      "M supagloo.project.json",
    ]);
    // The UPDATE branch carries the same commit fields (idempotent update-in-place).
    expect(ver.update.state).toBe("working");
    expect(ver.update.headCommitSha).toBe("a".repeat(40));
    expect(ver.update.commitMessage).toBe("Tighten the shelter pacing");
    expect(ver.update.changedFiles).toEqual([
      "M src/scenes/Shelter.tsx",
      "M supagloo.project.json",
    ]);

    // Job succeeded, completed, every commit stage done.
    expect(jobUpdate).toHaveBeenCalledTimes(1);
    const job = jobUpdate.mock.calls[0][0];
    expect(job.where).toEqual({ id: "job-1" });
    expect(job.data.status).toBe("succeeded");
    expect(job.data.completedAt).toBeInstanceOf(Date);
    const stages = job.data.stages as Array<{ state: string }>;
    expect(stages).toHaveLength(5);
    expect(stages.every((s) => s.state === "done")).toBe(true);
  });
});
