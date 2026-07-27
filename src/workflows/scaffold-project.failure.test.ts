import { beforeEach, describe, expect, it, vi } from "vitest";
import { GithubAppError } from "@supagloo/database-lib";
import { emptyManifest } from "../remotion/__fixtures__/manifests";
import { initialStages } from "./scaffold-project/stages";
import { TEST_SECRETS_ENCRYPTION_KEY } from "../testing/secrets-fixture";

/**
 * Plan row 63 / D63.7, review finding DR4 — the TERMINAL-FAILURE record.
 *
 * Row 63 gave `scaffoldProjectFn` a catch block, but it recorded a failure only when
 * `isPermanentScaffoldFailure(err)` was true, and that predicate knows exactly three
 * types: `RepoUnreachableError`, `GithubRestError`, `GitCommandError`. Everything else
 * was rethrown with NOTHING written — so `ProjectJob.status` stayed `"running"` with
 * every stage `pending` forever while DBOS reported ERROR. That is the eternal wizard
 * spinner D63.7 exists to kill, and it survived in the two most likely permanent
 * failures of all:
 *
 *   1. step 1 `mintInstallationToken` throws db-lib's `GithubAppError` (a bad App
 *      private key, a revoked installation). That step deliberately has no `shouldRetry`
 *      (D64.5), so a 401/404 burns the full 4-attempt `NETWORK_RETRY` budget and throws.
 *   2. `writeRemotionScaffold` / `finalizeRecords` throw plain Zod/Prisma errors — no
 *      typed git/HTTP shape anywhere.
 *
 * Technique: the `dbos-typescript` skill's `test-setup` rule, as in `render.order.test.ts` —
 * mock the SDK so `registerWorkflow` returns the raw function and `runStep` just invokes
 * its callback. `runStep` invoking the callback directly is the FAITHFUL model of the
 * boundary under test: by the time a step error reaches the workflow body DBOS has
 * already spent the step's retry budget and CHECKPOINTED the error
 * (`dbos-executor.js` records the error via `recordOperationResult` then throws), so the
 * failure is durable and terminal — the workflow will never retry past it on its own.
 * `stages.ts` is REAL here (it is the thing being proven); the git/HTTP/FS steps are
 * mocked because the assertion is about the failure record, not their behaviour.
 */

const h = vi.hoisted(() => ({
  mint: vi.fn(),
  ensureScaffold: vi.fn(),
  update: vi.fn(),
  findUniqueOrThrow: vi.fn(),
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

vi.mock("../providers/config", () => ({
  getProviderConfig: () => ({
    openrouterBaseUrl: "https://openrouter.invalid",
    glooBaseUrl: "https://gloo.invalid",
    youversionBaseUrl: "https://youversion.invalid",
    // Plan row 48: the mintInstallationToken step SEALS its result with this key, so a
    // workflow body cannot run without provider config in scope.
    secretsEncryptionKey: TEST_SECRETS_ENCRYPTION_KEY,
  }),
}));

vi.mock("../db/app-db", () => ({
  getAppDb: () => ({
    projectJob: { update: h.update, findUniqueOrThrow: h.findUniqueOrThrow },
  }),
}));

vi.mock("./scaffold-project/github-rest", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  ensureRepoReachable: vi.fn(async () => {}),
  openPullRequest: vi.fn(async () => ({ number: 7, url: "https://github.test/pull/7" })),
  mergePullRequest: vi.fn(async () => ({ sha: "merge-sha" })),
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

import { scaffoldProjectWorkflow, type ScaffoldProjectPayload } from "./scaffold-project";
import { setScaffoldConfig } from "./scaffold-project/config";

const payload: ScaffoldProjectPayload = {
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

/** The `projectJob.update` call that recorded the terminal failure, if any. */
function failureWrite():
  | { status: string; error: string; completedAt: Date; stages: Array<{ key: string; state: string }> }
  | undefined {
  const call = h.update.mock.calls.find(
    (c) => (c[0] as { data?: { status?: string } })?.data?.status === "failed",
  );
  return call?.[0]?.data;
}

beforeEach(() => {
  vi.clearAllMocks();
  setScaffoldConfig({
    githubApiBaseUrl: "https://api.github.test",
    githubGitBaseUrl: "https://github.test",
    githubAppId: "123456",
    githubAppPrivateKey: "-----BEGIN RSA PRIVATE KEY-----\nnope\n-----END RSA PRIVATE KEY-----",
  });
  h.mint.mockResolvedValue({ token: "ghs_token" });
  h.ensureScaffold.mockResolvedValue({ filesWritten: ["package.json"] });
  h.update.mockResolvedValue({});
  h.findUniqueOrThrow.mockResolvedValue({ stages: initialStages(), status: "running" });
});

describe("scaffoldProjectFn — terminal failure record (D63.7 / DR4)", () => {
  it("records a FAILED job when mintInstallationToken throws db-lib's GithubAppError", async () => {
    // The exact shape db-lib throws on a 401/404 token exchange. Constructed WITHOUT the
    // status option on purpose: the fix must not depend on that field, which was renamed
    // `status` → `upstreamStatus` in this same sweep.
    h.mint.mockRejectedValue(
      new GithubAppError(
        "TOKEN_EXCHANGE_FAILED",
        "installation token exchange failed: 401 Bad credentials",
      ),
    );

    await expect(scaffoldProjectWorkflow(payload)).rejects.toThrow(GithubAppError);

    const data = failureWrite();
    expect(data).toBeDefined();
    expect(data!.status).toBe("failed");
    expect(data!.completedAt).toBeInstanceOf(Date);
    expect(data!.error).toContain("401 Bad credentials");
    expect(data!.stages.find((s) => s.key === "mintInstallationToken")?.state).toBe(
      "failed",
    );
    // Upserted IN PLACE — later stages untouched, never appended.
    expect(data!.stages.find((s) => s.key === "finalizeRecords")?.state).toBe("pending");
  });

  it("records a FAILED job when an untyped (Zod/Prisma) error escapes writeRemotionScaffold", async () => {
    h.ensureScaffold.mockRejectedValue(
      new Error("Invalid manifest: scenes.0.durationSeconds expected number"),
    );

    await expect(scaffoldProjectWorkflow(payload)).rejects.toThrow("Invalid manifest");

    const data = failureWrite();
    expect(data).toBeDefined();
    expect(data!.status).toBe("failed");
    expect(data!.stages.find((s) => s.key === "writeRemotionScaffold")?.state).toBe(
      "failed",
    );
    // The stages that DID complete are not rewritten by the failure record.
    expect(data!.stages.find((s) => s.key === "commitBaseVersion")?.state).toBe("pending");
  });

  it("never lets the bookkeeping write mask the real failure", async () => {
    h.mint.mockRejectedValue(
      new GithubAppError("TOKEN_EXCHANGE_FAILED", "installation token exchange failed"),
    );
    // The job row is gone / the app DB is down while we try to record the failure.
    h.findUniqueOrThrow.mockRejectedValue(new Error("P2025: record not found"));

    await expect(scaffoldProjectWorkflow(payload)).rejects.toThrow(
      "installation token exchange failed",
    );
  });
});
