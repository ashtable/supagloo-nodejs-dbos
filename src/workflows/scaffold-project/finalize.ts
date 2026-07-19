import type { PrismaClient } from "@supagloo/database-lib";
import { BASE_BRANCH, WORKING_BRANCH } from "./workspace";
import { SCAFFOLD_STAGES, toJson } from "./stages";

/**
 * `finalizeRecords` — the terminal step. Writes the durable domain records the
 * scaffold produced: the Project's working branch, the two ProjectVersion rows
 * (base v0.0.0 + working v0.0.1), and the job's succeeded status + completed stages.
 * Every write is idempotent under replay: the Project is updated in place and the
 * versions are UPSERTED by their `@@unique([projectId, semver])` key.
 */

export interface FinalizeInput {
  projectId: string;
  repoOwner: string;
  repoName: string;
  repoVisibility: "private" | "public";
  /** The base version, from the merged base PR. */
  base: { headCommitSha: string; prNumber: number; prUrl: string };
  /** The working version, from the cut branch. */
  working: { headCommitSha: string };
  /** Files the scaffold introduced (recorded on the base version). */
  changedFiles: string[];
}

export async function finalizeRecords(
  prisma: PrismaClient,
  jobId: string,
  input: FinalizeInput,
): Promise<void> {
  // Project: advance to the working branch; backfill repo fields if unset.
  await prisma.project.update({
    where: { id: input.projectId },
    data: {
      currentBranch: WORKING_BRANCH,
      repoOwner: input.repoOwner,
      repoName: input.repoName,
      repoVisibility: input.repoVisibility,
    },
  });

  // Base version (v0.0.0) — carries the merged base PR's number/url/sha.
  await prisma.projectVersion.upsert({
    where: { projectId_semver: { projectId: input.projectId, semver: "0.0.0" } },
    create: {
      projectId: input.projectId,
      semver: "0.0.0",
      branchName: BASE_BRANCH,
      state: "base",
      headCommitSha: input.base.headCommitSha,
      prNumber: input.base.prNumber,
      prUrl: input.base.prUrl,
      changedFiles: input.changedFiles,
    },
    update: {
      branchName: BASE_BRANCH,
      state: "base",
      headCommitSha: input.base.headCommitSha,
      prNumber: input.base.prNumber,
      prUrl: input.base.prUrl,
      changedFiles: input.changedFiles,
    },
  });

  // Working version (v0.0.1) — the branch to edit; no changes vs base yet.
  await prisma.projectVersion.upsert({
    where: { projectId_semver: { projectId: input.projectId, semver: "0.0.1" } },
    create: {
      projectId: input.projectId,
      semver: "0.0.1",
      branchName: WORKING_BRANCH,
      state: "working",
      headCommitSha: input.working.headCommitSha,
      changedFiles: [],
    },
    update: {
      branchName: WORKING_BRANCH,
      state: "working",
      headCommitSha: input.working.headCommitSha,
      changedFiles: [],
    },
  });

  // Job: succeeded, every stage done, completed.
  await prisma.projectJob.update({
    where: { id: jobId },
    data: {
      status: "succeeded",
      completedAt: new Date(),
      stages: toJson(SCAFFOLD_STAGES.map((s) => ({ ...s, state: "done" }))),
    },
  });
}
