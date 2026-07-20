import { PUBLISH_STAGES, type PrismaClient } from "@supagloo/database-lib";
import { toJson } from "../scaffold-project/stages";

/**
 * `finalizeRecords` — publish's terminal step (design-delta §7 workflow 4). Records the
 * durable result of the publish:
 *   1. flip the CURRENT working ProjectVersion → `published` (set publishedAt + the merged
 *      PR's number/url + the merge head sha), WITHOUT clobbering its own commit history
 *      (changedFiles/commitMessage stay);
 *   2. upsert the NEW `working` ProjectVersion at the bumped semver/branch;
 *   3. advance `Project.currentBranch` to the new working branch (`main` now holds the
 *      published version; the user edits one version ahead);
 *   4. mark the job succeeded with every publish stage done.
 * Every write is idempotent under replay (upsert-by-unique-key + in-place project update).
 */

export interface FinalizePublishInput {
  projectId: string;
  /** The version being published (the current working version, flipped to `published`). */
  published: {
    semver: string;
    branchName: string;
    /** The merge commit sha on `main`. */
    headCommitSha: string;
    prNumber: number;
    prUrl: string;
  };
  /** The next working version, cut from `main` at the bumped semver. */
  next: {
    semver: string;
    branchName: string;
    headCommitSha: string;
  };
}

export async function finalizePublishRecords(
  prisma: PrismaClient,
  jobId: string,
  input: FinalizePublishInput,
): Promise<void> {
  const publishedAt = new Date();

  // 1) The published version — flip working → published in place. The UPDATE branch sets
  //    ONLY the publish-specific fields, preserving the version's own changedFiles /
  //    commitMessage (its edit history from prior commits). The CREATE branch is defensive
  //    (the working row always already exists).
  await prisma.projectVersion.upsert({
    where: {
      projectId_semver: {
        projectId: input.projectId,
        semver: input.published.semver,
      },
    },
    create: {
      projectId: input.projectId,
      semver: input.published.semver,
      branchName: input.published.branchName,
      state: "published",
      headCommitSha: input.published.headCommitSha,
      prNumber: input.published.prNumber,
      prUrl: input.published.prUrl,
      publishedAt,
      changedFiles: [],
    },
    update: {
      state: "published",
      headCommitSha: input.published.headCommitSha,
      prNumber: input.published.prNumber,
      prUrl: input.published.prUrl,
      publishedAt,
    },
  });

  // 2) The next working version — a fresh branch cut from main; no changes vs the published
  //    version yet.
  await prisma.projectVersion.upsert({
    where: {
      projectId_semver: { projectId: input.projectId, semver: input.next.semver },
    },
    create: {
      projectId: input.projectId,
      semver: input.next.semver,
      branchName: input.next.branchName,
      state: "working",
      headCommitSha: input.next.headCommitSha,
      changedFiles: [],
    },
    update: {
      branchName: input.next.branchName,
      state: "working",
      headCommitSha: input.next.headCommitSha,
      changedFiles: [],
    },
  });

  // 3) The Project advances to the new working branch.
  await prisma.project.update({
    where: { id: input.projectId },
    data: { currentBranch: input.next.branchName },
  });

  // 4) Job: succeeded, every stage done, completed.
  await prisma.projectJob.update({
    where: { id: jobId },
    data: {
      status: "succeeded",
      completedAt: new Date(),
      stages: toJson(PUBLISH_STAGES.map((s) => ({ ...s, state: "done" as const }))),
    },
  });
}
