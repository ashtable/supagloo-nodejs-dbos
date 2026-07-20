import { IMPORT_STAGES, type PrismaClient } from "@supagloo/database-lib";
import { toJson } from "../scaffold-project/stages";

/**
 * `finalizeImportRecords` — the terminal step. Writes the durable domain records the
 * import produced: the Project advanced to the resolved version branch (+ repo fields),
 * exactly ONE ProjectVersion (the resolved latest, `state: working`, a FREE-FORM
 * semver — NOT scaffold's fixed v0.0.0/v0.0.1 pair), and the job's succeeded status +
 * completed stages. Every write is idempotent under replay: the Project is updated in
 * place and the version is UPSERTED by its `@@unique([projectId, semver])` key.
 */

export interface FinalizeImportInput {
  projectId: string;
  repoOwner: string;
  repoName: string;
  repoVisibility: "private" | "public";
  /** The resolved latest version imported from the repo. */
  version: { semver: string; branchName: string; headCommitSha: string };
}

export async function finalizeImportRecords(
  prisma: PrismaClient,
  jobId: string,
  input: FinalizeImportInput,
): Promise<void> {
  // Project: point at the imported version branch; backfill repo fields.
  await prisma.project.update({
    where: { id: input.projectId },
    data: {
      currentBranch: input.version.branchName,
      repoOwner: input.repoOwner,
      repoName: input.repoName,
      repoVisibility: input.repoVisibility,
    },
  });

  // The single imported working version (free-form semver, e.g. "0.10.0").
  await prisma.projectVersion.upsert({
    where: {
      projectId_semver: {
        projectId: input.projectId,
        semver: input.version.semver,
      },
    },
    create: {
      projectId: input.projectId,
      semver: input.version.semver,
      branchName: input.version.branchName,
      state: "working",
      headCommitSha: input.version.headCommitSha,
      changedFiles: [],
    },
    update: {
      branchName: input.version.branchName,
      state: "working",
      headCommitSha: input.version.headCommitSha,
      changedFiles: [],
    },
  });

  // Job: succeeded, every stage done, completed.
  await prisma.projectJob.update({
    where: { id: jobId },
    data: {
      status: "succeeded",
      completedAt: new Date(),
      stages: toJson(IMPORT_STAGES.map((s) => ({ ...s, state: "done" as const }))),
    },
  });
}
