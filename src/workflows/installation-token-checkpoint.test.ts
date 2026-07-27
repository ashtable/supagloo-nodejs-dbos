import { beforeEach, describe, expect, it, vi } from "vitest";
import { decryptSecret } from "@supagloo/database-lib";
import { emptyManifest } from "../remotion/__fixtures__/manifests";
import { TEST_SECRETS_ENCRYPTION_KEY } from "../testing/secrets-fixture";
import { initialStages } from "./scaffold-project/stages";
import { initialImportStages } from "./import-project/stages";
import { initialCommitStages } from "./commit-version/stages";
import { initialPublishStages } from "./publish-version/stages";

/**
 * Plan row 48 — THE load-bearing unit test: **no step's checkpointed result contains a
 * raw installation token**, across every git-ops workflow.
 *
 * The defect this pins closed: `mintInstallationToken` is a DBOS *step*, and DBOS
 * durably persists a step's return value into `<schema>.operation_outputs.output`. So
 * the plaintext `ghs_…` token sat at rest in Postgres for the lifetime of the workflow
 * row, in FIVE workflows (brief §9 S7: scaffold, IMPORT, commit, publish, render — the
 * plan row's own list understates it by one, and its in-code comment claimed render had
 * two). The design's "never persisted" framing (current-design §2.3:122-124,
 * §2.5:222-224, §2.6:276) covers only the app-level `GithubConnection` row and never
 * anticipated DBOS's own checkpointing mechanics; wireframe 10b renders the unqualified
 * promise "All tokens & secrets are encrypted at rest", which was false as written.
 *
 * TECHNIQUE. The `dbos-typescript` skill's `test-setup` rule as used by
 * `render.order.test.ts` and `git-ops-job-failure.test.ts`: mock the SDK so
 * `registerWorkflow` returns the raw function and `runStep` invokes its callback — but
 * here the mock additionally RECORDS every step's resolved return value. That recorded
 * set is, by construction, exactly the set of values DBOS would have checkpointed. The
 * assertion is then made against the record, not against the source: a future step that
 * starts returning a token is caught by this test without anyone remembering to add one.
 *
 * WHY NOT re-mint per step (brief §5.1, binding): the token is consumed by 3-5 steps per
 * workflow, `mintInstallationToken` does NO caching, and GitHub's secondary/abuse limits
 * are account-scoped and far tighter than the core limit — where the DBOS classifier
 * keeps `403 ⇒ permanent`. Per-step minting would manufacture exactly the terminal
 * failure row 50 just finished fixing, AND multiply the `countStepExecutions(...,
 * "mintInstallationToken") === 1` durability proof that four e2e specs assert. Sealing
 * the token satisfies row 48's own wording ("re-mints **or derives**") while leaving the
 * step name, the step count and every `functionID` untouched (brief §10 R11).
 */

/** Token-shaped, and distinctive enough that a substring match cannot be accidental. */
const SENTINEL = "ghs_SUPAGLOOsentinelTOKEN0123456789abcd";

/** Every value a step handed back — i.e. everything DBOS would have checkpointed. */
const stepResults: Array<{ name: string; value: unknown }> = [];

const h = vi.hoisted(() => ({
  mint: vi.fn(),
  update: vi.fn(),
  findUniqueOrThrow: vi.fn(),
  ensureScaffold: vi.fn(),
  ensureImportClone: vi.fn(),
  listRemoteBranchNames: vi.fn(),
  hasRemotionConfig: vi.fn(),
  ensureCommitClone: vi.fn(),
  capturePublishHead: vi.fn(),
}));

vi.mock("@dbos-inc/dbos-sdk", () => ({
  DBOS: {
    workflowID: "job-1",
    registerWorkflow: (fn: unknown) => fn,
    runStep: async (fn: () => unknown, opts: { name: string }) => {
      const value = await fn();
      stepResults.push({ name: opts.name, value });
      return value;
    },
  },
}));

vi.mock("@supagloo/database-lib", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  mintInstallationToken: h.mint,
}));

vi.mock("../db/app-db", () => ({
  getAppDb: () => ({
    projectJob: { update: h.update, findUniqueOrThrow: h.findUniqueOrThrow },
    // Publish's `cutNextVersionBranch` step derives the next semver from the existing
    // set, so the happy path needs at least one parseable row here.
    projectVersion: { findMany: vi.fn(async () => [{ semver: "0.0.1" }]) },
  }),
}));

vi.mock("../providers/config", () => ({
  getProviderConfig: () => ({
    openrouterBaseUrl: "https://openrouter.invalid",
    glooBaseUrl: "https://gloo.invalid",
    youversionBaseUrl: "https://youversion.invalid",
    secretsEncryptionKey: TEST_SECRETS_ENCRYPTION_KEY,
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
vi.mock("./import-project/manifest", () => ({
  parseManifestFile: vi.fn(async () => emptyManifest),
}));
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

beforeEach(() => {
  vi.clearAllMocks();
  stepResults.length = 0;
  setScaffoldConfig({
    githubApiBaseUrl: "https://api.github.test",
    githubGitBaseUrl: "https://github.test",
    githubAppId: "123456",
    githubAppPrivateKey:
      "-----BEGIN RSA PRIVATE KEY-----\nnope\n-----END RSA PRIVATE KEY-----",
  });
  h.mint.mockResolvedValue({ token: SENTINEL });
  h.ensureScaffold.mockResolvedValue({ filesWritten: ["package.json"] });
  h.ensureImportClone.mockResolvedValue("/tmp/import");
  h.listRemoteBranchNames.mockResolvedValue(["main", "v0.0.1"]);
  h.hasRemotionConfig.mockReturnValue(true);
  h.ensureCommitClone.mockResolvedValue("/tmp/commit");
  h.capturePublishHead.mockResolvedValue({ headCommitSha: "working-head" });
  h.update.mockResolvedValue({});
});

/** Serialize a checkpointed value the way DBOS does before it hits Postgres. */
function asCheckpoint(value: unknown): string {
  return JSON.stringify(value ?? null);
}

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
  "$name — checkpointed step results carry no plaintext installation token (row 48)",
  ({ run, stages }) => {
    beforeEach(() => {
      h.findUniqueOrThrow.mockResolvedValue({ stages: stages(), status: "running" });
    });

    it("U-IT9: no step's return value contains the token", async () => {
      await run();

      // Guard against a vacuous pass: the workflow must actually have run steps.
      expect(stepResults.length).toBeGreaterThan(3);
      for (const step of stepResults) {
        expect(
          asCheckpoint(step.value),
          `step "${step.name}" checkpointed a plaintext installation token`,
        ).not.toContain(SENTINEL);
      }
    });

    it("U-IT10: no step's return value even carries the ghs_ token PREFIX", async () => {
      await run();

      for (const step of stepResults) {
        expect(asCheckpoint(step.value), `step "${step.name}"`).not.toMatch(
          /gh[soupr]_[A-Za-z0-9]/,
        );
      }
    });

    it("U-IT11: mintInstallationToken still runs exactly ONCE, and its result decrypts back to the token", async () => {
      await run();

      const mints = stepResults.filter((s) => s.name === "mintInstallationToken");
      // The flagship durability proof (design-delta §6f:1091, §11.5:2223-2226) asserts
      // exactly one recorded execution. Row 48 must not disturb it — which is precisely
      // what naive per-step re-minting would have done.
      expect(mints).toHaveLength(1);
      expect(typeof mints[0].value).toBe("string");
      // POSITIVE proof, not just absence: the checkpoint is a real ciphertext of the real
      // token, so "no token found" cannot be an artifact of a step that stopped returning
      // anything at all.
      expect(decryptSecret(mints[0].value as string, TEST_SECRETS_ENCRYPTION_KEY)).toBe(
        SENTINEL,
      );
    });
  },
);
