import { COMMIT_STAGES, type PrismaClient } from "@supagloo/database-lib";
import { toJson } from "../scaffold-project/stages";

/**
 * `updateVersionRecord` — commit's terminal step. Records the durable result of the
 * commit onto the EXISTING working ProjectVersion row (design-delta §7 workflow 3): the
 * new head SHA, the changed-files list, and the commit message — keyed by the working
 * `[projectId, semver]` (SAME semver, SAME branch: commit does NOT bump the version or
 * advance the branch, so unlike scaffold/import it never writes the Project row). The
 * write is idempotent under replay (upsert-in-place). Then the job is marked succeeded
 * with every commit stage done.
 */

export interface UpdateCommitVersionInput {
  projectId: string;
  /** The working version's semver — keys the upsert (unchanged by the commit). */
  semver: string;
  branchName: string;
  headCommitSha: string;
  commitMessage: string;
  /** `["M src/scenes/Shelter.tsx", ...]` — the commit's change set. */
  changedFiles: string[];
}

export async function updateCommitVersionRecord(
  prisma: PrismaClient,
  jobId: string,
  input: UpdateCommitVersionInput,
): Promise<void> {
  // Update the working version in place (upsert-by-unique-key for replay safety). No
  // Project write: commit stays on the same working branch.
  await prisma.projectVersion.upsert({
    where: {
      projectId_semver: { projectId: input.projectId, semver: input.semver },
    },
    create: {
      projectId: input.projectId,
      semver: input.semver,
      branchName: input.branchName,
      state: "working",
      headCommitSha: input.headCommitSha,
      commitMessage: input.commitMessage,
      changedFiles: input.changedFiles,
    },
    update: {
      branchName: input.branchName,
      state: "working",
      headCommitSha: input.headCommitSha,
      commitMessage: input.commitMessage,
      changedFiles: input.changedFiles,
    },
  });

  // Job: succeeded, every stage done, completed.
  await prisma.projectJob.update({
    where: { id: jobId },
    data: {
      status: "succeeded",
      completedAt: new Date(),
      stages: toJson(COMMIT_STAGES.map((s) => ({ ...s, state: "done" as const }))),
    },
  });
}
