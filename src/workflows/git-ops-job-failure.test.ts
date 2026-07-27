import { beforeEach, describe, expect, it, vi } from "vitest";
import { GithubAppError } from "@supagloo/database-lib";
import { emptyManifest } from "../remotion/__fixtures__/manifests";
import { initialStages } from "./scaffold-project/stages";
import { initialImportStages } from "./import-project/stages";
import { initialCommitStages } from "./commit-version/stages";
import { initialPublishStages } from "./publish-version/stages";
import { NotASupaglooProjectError } from "./import-project/errors";

/**
 * Plan row 50 item (2) — the SHARED terminal-failure record, across ALL FOUR git-ops
 * workflows.
 *
 * The defect: an uncaught permanent step failure left `ProjectJob.status` at `"running"`
 * forever, with every stage `pending` and no `error`, while DBOS reported ERROR. The
 * user-visible face is an eternal wizard spinner — the poll endpoint has nothing to
 * report a failure with, because the WORKFLOW is the only writer of the terminal status
 * (design-delta §5.1:741-746: no HTTP between api and dbos; status flows back through the
 * app-database rows the workflows update). An api-side reconciler polling `supagloo_dbos`
 * would invert that designed flow, so the fix belongs here.
 *
 * State at HEAD, verified, and why the plan row's own parenthetical is WRONG (brief §9 S1):
 *
 *   - `scaffoldProjectWorkflow` — fixed by plan row 63 / D63.7 with an UNGATED catch.
 *     That is the model the other three copy. Covered here too, so the shared property is
 *     asserted in one place for all four rather than living only in
 *     `scaffold-project.failure.test.ts`.
 *   - `importProjectWorkflow` — the row claims it "already did" this. It did NOT. Its
 *     catch is DOUBLY gated: `isPermanentImportFailure(err)` AND `failedStageFor(err)`,
 *     and `failedStageFor` returns non-null for exactly two CONTENT errors
 *     (`NotASupaglooProjectError`, `ManifestInvalidError`). A `GithubAppError` from step 1
 *     `mintInstallationToken`, a `GitCommandError` from the clone, or a Prisma/Zod error
 *     from `finalizeRecords` all escaped with nothing written — i.e. import carried
 *     exactly the eternal-spinner defect row 63 killed in scaffold, for every class but
 *     two. D50.3 widens it while PRESERVING the two typed mappings (wireframe 12b's
 *     "NOT A SUPAGLOO PROJECT" stage state depends on them).
 *   - `commitVersionWorkflow` / `publishVersionWorkflow` — no try, no catch,
 *     `markJobFailed` not even imported. The defect is fully intact for both.
 *
 * TECHNIQUE (the `dbos-typescript` skill's `test-setup` rule, as in `render.order.test.ts`
 * and `scaffold-project.failure.test.ts`): mock the SDK so `registerWorkflow` returns the
 * raw function and `runStep` just invokes its callback. That is the FAITHFUL model of the
 * boundary under test — by the time a step error reaches the workflow body DBOS has
 * already spent that step's retry budget and CHECKPOINTED the error, so the failure is
 * durable and terminal. `stages.ts` is REAL here (it is the thing being proven); the
 * git/HTTP/FS steps are mocked because the assertion is about the failure RECORD.
 */

const h = vi.hoisted(() => ({
  mint: vi.fn(),
  update: vi.fn(),
  findUniqueOrThrow: vi.fn(),
  // scaffold
  ensureScaffold: vi.fn(),
  // import
  ensureImportClone: vi.fn(),
  listRemoteBranchNames: vi.fn(),
  hasRemotionConfig: vi.fn(),
  // commit
  ensureCommitClone: vi.fn(),
  // publish
  capturePublishHead: vi.fn(),
}));

vi.mock("@dbos-inc/dbos-sdk", () => ({
  DBOS: {
    workflowID: "job-1",
    registerWorkflow: (fn: unknown) => fn,
    runStep: async (fn: () => unknown) => fn(),
  },
}));

vi.mock("@supagloo/database-lib", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  mintInstallationToken: h.mint,
}));

vi.mock("../db/app-db", () => ({
  getAppDb: () => ({
    projectJob: { update: h.update, findUniqueOrThrow: h.findUniqueOrThrow },
    projectVersion: { findMany: vi.fn(async () => []) },
  }),
}));

// --- scaffold seams -------------------------------------------------------------
vi.mock("./scaffold-project/github-rest", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  ensureRepoReachable: vi.fn(async () => {}),
  openPullRequest: vi.fn(async () => ({ number: 7, url: "https://github.test/pull/7" })),
  mergePullRequest: vi.fn(async () => ({ merged: true, sha: "merge-sha" })),
}));
vi.mock("./scaffold-project/workspace", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  ensureClone: vi.fn(async () => {}),
  ensureBaseRef: vi.fn(async () => {}),
  ensureScaffold: h.ensureScaffold,
  materializeBaseVersion: vi.fn(async () => ({ baseSha: "base-sha" })),
  pushBranchFromWorkspace: vi.fn(async () => {}),
  cutWorkingBranchLocal: vi.fn(async () => ({ workingSha: "working-sha" })),
  removeWorkspace: vi.fn(async () => {}),
}));
vi.mock("./scaffold-project/finalize", () => ({ finalizeRecords: vi.fn(async () => {}) }));

// --- import seams ---------------------------------------------------------------
vi.mock("./import-project/workspace", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  ensureImportClone: h.ensureImportClone,
  listRemoteBranchNames: h.listRemoteBranchNames,
  hasRemotionConfig: h.hasRemotionConfig,
  checkoutVersionBranch: vi.fn(async () => "import-head-sha"),
  removeImportWorkspace: vi.fn(async () => {}),
}));
vi.mock("./import-project/manifest", () => ({ parseManifestFile: vi.fn(async () => {}) }));
vi.mock("./import-project/finalize", () => ({
  finalizeImportRecords: vi.fn(async () => {}),
}));

// --- commit seams ---------------------------------------------------------------
vi.mock("./commit-version/workspace", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  ensureCommitClone: h.ensureCommitClone,
  ensureManifestApplied: vi.fn(async () => {}),
  commitBranch: vi.fn(async () => ({
    committed: true,
    headCommitSha: "commit-sha",
    changedFiles: ["M src/scenes/A.tsx"],
  })),
  removeCommitWorkspace: vi.fn(async () => {}),
}));
vi.mock("./commit-version/finalize", () => ({
  updateCommitVersionRecord: vi.fn(async () => {}),
}));

// --- publish seams --------------------------------------------------------------
vi.mock("./publish-version/workspace", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  capturePublishHead: h.capturePublishHead,
  pushWorkingBranch: vi.fn(async () => {}),
  cutNextBranch: vi.fn(async () => ({ headCommitSha: "next-sha" })),
  removePublishWorkspace: vi.fn(async () => {}),
}));
vi.mock("./publish-version/github-rest", () => ({
  createTag: vi.fn(async () => ({ ref: "refs/tags/v0.0.1" })),
}));
vi.mock("./publish-version/finalize", () => ({
  finalizePublishRecords: vi.fn(async () => {}),
}));

import { scaffoldProjectWorkflow, type ScaffoldProjectPayload } from "./scaffold-project";
import { importProjectWorkflow, type ImportProjectPayload } from "./import-project";
import { commitVersionWorkflow, type CommitVersionPayload } from "./commit-version";
import { publishVersionWorkflow, type PublishVersionPayload } from "./publish-version";
import { setScaffoldConfig } from "./scaffold-project/config";

const scaffoldPayload: ScaffoldProjectPayload = {
  projectId: "proj-1",
  userId: "user-1",
  ownerId: "user-1",
  installationId: "42",
  repoOwner: "acme",
  repoName: "psalm-91",
  repoVisibility: "private",
  createdFrom: "blank",
  slug: "psalm-91",
  name: "Psalm 91",
  manifest: emptyManifest,
};

const importPayload: ImportProjectPayload = {
  projectId: "proj-1",
  userId: "user-1",
  ownerId: "user-1",
  installationId: "42",
  repoOwner: "acme",
  repoName: "psalm-91",
  repoVisibility: "private",
  slug: "psalm-91",
  name: "Psalm 91",
};

const commitPayload: CommitVersionPayload = {
  projectId: "proj-1",
  userId: "user-1",
  installationId: "42",
  repoOwner: "acme",
  repoName: "psalm-91",
  branchName: "v0.0.1",
  semver: "0.0.1",
  manifest: emptyManifest,
  message: "Edit the shelter scene",
};

const publishPayload: PublishVersionPayload = {
  projectId: "proj-1",
  userId: "user-1",
  installationId: "42",
  repoOwner: "acme",
  repoName: "psalm-91",
  branchName: "v0.0.1",
  semver: "0.0.1",
  message: "Publish the shelter cut",
};

/** The `projectJob.update` call that recorded the terminal failure, if any. */
function failureWrite():
  | {
      status: string;
      error: string;
      completedAt: Date;
      stages: Array<{ key: string; state: string }>;
    }
  | undefined {
  const call = h.update.mock.calls.find(
    (c) => (c[0] as { data?: { status?: string } })?.data?.status === "failed",
  );
  return call?.[0]?.data;
}

/** The db-lib error step 1 `mintInstallationToken` throws on a 401/404 token exchange —
 *  the single most likely permanent failure in every one of the four workflows, and the
 *  one NO existing gate recognised (it is neither a git nor a GitHub-REST typed error). */
const mintFailure = () =>
  new GithubAppError(
    "TOKEN_EXCHANGE_FAILED",
    "installation token exchange failed: 401 Bad credentials",
  );

beforeEach(() => {
  vi.clearAllMocks();
  setScaffoldConfig({
    githubApiBaseUrl: "https://api.github.test",
    githubGitBaseUrl: "https://github.test",
    githubAppId: "123456",
    githubAppPrivateKey:
      "-----BEGIN RSA PRIVATE KEY-----\nnope\n-----END RSA PRIVATE KEY-----",
  });
  h.mint.mockResolvedValue({ token: "ghs_token" });
  h.ensureScaffold.mockResolvedValue({ filesWritten: ["package.json"] });
  h.ensureImportClone.mockResolvedValue("/tmp/import");
  h.listRemoteBranchNames.mockResolvedValue(["main", "v0.0.1"]);
  h.hasRemotionConfig.mockReturnValue(true);
  h.ensureCommitClone.mockResolvedValue("/tmp/commit");
  h.capturePublishHead.mockResolvedValue({ headCommitSha: "working-head" });
  h.update.mockResolvedValue({});
  h.findUniqueOrThrow.mockResolvedValue({ stages: initialStages(), status: "running" });
});

/**
 * The shared property, table-driven over all four workflows: an uncaught PERMANENT step
 * failure flips `ProjectJob.status` to `"failed"`, marks the in-flight stage `failed`,
 * stamps `completedAt` + `error`, and RE-THROWS (DBOS decides retry/recovery from the
 * escaping error — the bookkeeping must never swallow it).
 */
const workflows = [
  {
    name: "scaffoldProjectWorkflow",
    run: () => scaffoldProjectWorkflow(scaffoldPayload),
    stages: initialStages,
  },
  {
    name: "importProjectWorkflow",
    run: () => importProjectWorkflow(importPayload),
    stages: initialImportStages,
  },
  {
    name: "commitVersionWorkflow",
    run: () => commitVersionWorkflow(commitPayload),
    stages: initialCommitStages,
  },
  {
    name: "publishVersionWorkflow",
    run: () => publishVersionWorkflow(publishPayload),
    stages: initialPublishStages,
  },
] as const;

describe.each(workflows)(
  "$name — terminal failure reconciles ProjectJob.status (row 50 item 2)",
  ({ run, stages }) => {
    beforeEach(() => {
      h.findUniqueOrThrow.mockResolvedValue({ stages: stages(), status: "running" });
    });

    it("flips status to failed, marks mintInstallationToken failed, and re-throws", async () => {
      h.mint.mockRejectedValue(mintFailure());

      await expect(run()).rejects.toThrow(GithubAppError);

      const data = failureWrite();
      expect(data).toBeDefined();
      expect(data!.status).toBe("failed");
      expect(data!.completedAt).toBeInstanceOf(Date);
      expect(data!.error).toContain("401 Bad credentials");
      expect(data!.stages.find((s) => s.key === "mintInstallationToken")?.state).toBe(
        "failed",
      );
      // Upserted IN PLACE — the terminal stage is untouched, never appended.
      expect(data!.stages.find((s) => s.key === "finalizeRecords")?.state ?? "pending").toBe(
        "pending",
      );
    });

    it("never clobbers a job that already reached succeeded", async () => {
      h.findUniqueOrThrow.mockResolvedValue({ stages: stages(), status: "succeeded" });
      h.mint.mockRejectedValue(mintFailure());

      await expect(run()).rejects.toThrow(GithubAppError);
      expect(failureWrite()).toBeUndefined();
    });

    it("never lets the bookkeeping write mask the real failure", async () => {
      h.mint.mockRejectedValue(mintFailure());
      // The job row is gone / the app DB is down while we try to record the failure.
      h.findUniqueOrThrow.mockRejectedValue(new Error("P2025: record not found"));

      await expect(run()).rejects.toThrow("installation token exchange failed");
    });
  },
);

/**
 * D50.3's other half: widening import's catch must NOT cost the two typed CONTENT
 * mappings. `failedStageFor` stays the PREFERRED stage key; the captured in-flight stage
 * is only the fallback. Wireframe 12b's "NOT A SUPAGLOO PROJECT" terminal stage state is
 * what depends on this.
 */
describe("importProjectWorkflow — typed content failures keep their own stage key", () => {
  beforeEach(() => {
    h.findUniqueOrThrow.mockResolvedValue({
      stages: initialImportStages(),
      status: "running",
    });
  });

  it("maps NotASupaglooProjectError to the verifySupaglooProject stage", async () => {
    h.hasRemotionConfig.mockReturnValue(false);
    h.listRemoteBranchNames.mockResolvedValue(["main"]);

    await expect(importProjectWorkflow(importPayload)).rejects.toBeInstanceOf(
      NotASupaglooProjectError,
    );

    const data = failureWrite();
    expect(data).toBeDefined();
    expect(data!.status).toBe("failed");
    expect(data!.stages.find((s) => s.key === "verifySupaglooProject")?.state).toBe(
      "failed",
    );
  });

  it("records a non-content permanent failure at the stage that was in flight", async () => {
    // A plain (Prisma/Zod-shaped) error out of the clone step: neither
    // `isPermanentImportFailure` nor `failedStageFor` recognised it, so before row 50 it
    // escaped with NOTHING written. This is the assertion that proves brief finding S1.
    h.ensureImportClone.mockRejectedValue(new Error("fatal: could not read Username"));

    await expect(importProjectWorkflow(importPayload)).rejects.toThrow(
      "could not read Username",
    );

    const data = failureWrite();
    expect(data).toBeDefined();
    expect(data!.status).toBe("failed");
    expect(data!.stages.find((s) => s.key === "cloneRepo")?.state).toBe("failed");
  });
});
