import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@supagloo/database-lib";
import { finalizePublishRecords } from "./finalize";

// finalizePublishRecords is publish's terminal step. It (1) flips the CURRENT working
// ProjectVersion to `published` (setting publishedAt/prNumber/prUrl/headCommitSha, WITHOUT
// clobbering its existing changedFiles/commitMessage), (2) upserts a NEW `working`
// ProjectVersion at the bumped semver/branch, (3) advances Project.currentBranch to the new
// working branch, and (4) marks the job succeeded with all seven stages done. Every write is
// idempotent under replay (upsert-by-unique-key + in-place project update).

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

const INPUT = {
  projectId: "pprj1",
  published: {
    semver: "0.0.1",
    branchName: "v0.0.1",
    headCommitSha: "a".repeat(40),
    prNumber: 7,
    prUrl: "http://github.test/acme/psalm-91/pull/7",
  },
  next: {
    semver: "0.0.2",
    branchName: "v0.0.2",
    headCommitSha: "b".repeat(40),
  },
};

describe("finalizePublishRecords", () => {
  it("flips the working version to published, upserts the next working version, advances the branch, completes the job", async () => {
    const { prisma, projectUpdate, versionUpsert, jobUpdate } = makeFakePrisma();

    await finalizePublishRecords(prisma, "job-1", INPUT);

    // The Project advances to the NEW working branch.
    expect(projectUpdate).toHaveBeenCalledTimes(1);
    const proj = projectUpdate.mock.calls[0][0];
    expect(proj.where).toEqual({ id: "pprj1" });
    expect(proj.data.currentBranch).toBe("v0.0.2");

    // Two version upserts: the published one, then the new working one.
    expect(versionUpsert).toHaveBeenCalledTimes(2);

    // (1) Published version — keyed by the working (projectId, publishedSemver).
    const pub = versionUpsert.mock.calls[0][0];
    expect(pub.where).toEqual({
      projectId_semver: { projectId: "pprj1", semver: "0.0.1" },
    });
    expect(pub.update.state).toBe("published");
    expect(pub.update.headCommitSha).toBe("a".repeat(40));
    expect(pub.update.prNumber).toBe(7);
    expect(pub.update.prUrl).toBe("http://github.test/acme/psalm-91/pull/7");
    expect(pub.update.publishedAt).toBeInstanceOf(Date);
    // The UPDATE branch must NOT clobber the working version's own changedFiles/commitMessage.
    expect("changedFiles" in pub.update).toBe(false);
    expect("commitMessage" in pub.update).toBe(false);

    // (2) New working version — keyed by the bumped (projectId, nextSemver).
    const nextV = versionUpsert.mock.calls[1][0];
    expect(nextV.where).toEqual({
      projectId_semver: { projectId: "pprj1", semver: "0.0.2" },
    });
    expect(nextV.create.semver).toBe("0.0.2");
    expect(nextV.create.branchName).toBe("v0.0.2");
    expect(nextV.create.state).toBe("working");
    expect(nextV.create.headCommitSha).toBe("b".repeat(40));
    expect(nextV.create.changedFiles).toEqual([]);
    expect(nextV.update.state).toBe("working");
    expect(nextV.update.headCommitSha).toBe("b".repeat(40));

    // Job succeeded, completed, every publish stage done.
    expect(jobUpdate).toHaveBeenCalledTimes(1);
    const job = jobUpdate.mock.calls[0][0];
    expect(job.where).toEqual({ id: "job-1" });
    expect(job.data.status).toBe("succeeded");
    expect(job.data.completedAt).toBeInstanceOf(Date);
    const stages = job.data.stages as Array<{ state: string }>;
    expect(stages).toHaveLength(7);
    expect(stages.every((s) => s.state === "done")).toBe(true);
  });
});
