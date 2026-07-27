import { beforeEach, describe, expect, it, vi } from "vitest";
import { shelterManifest } from "../remotion/__fixtures__/manifests";
import { TEST_SECRETS_ENCRYPTION_KEY } from "../testing/secrets-fixture";

/**
 * Task #36 — STEP ORDERING (plan row 36's headline unit test).
 *
 * The invariant: **audio synthesis precedes `bundleComposition`**. Remotion's `bundle()`
 * SNAPSHOTS the `public/` directory into the bundle (verified in
 * @remotion/bundler/dist/bundle.js — it copies `<root>/public` to `<outDir>/public`), so
 * audio written AFTER bundling is simply not in the bundle and can never be heard
 * (design-delta §7 workflow 9, "Why audio before bundle"). Nothing about that ordering is
 * enforced by types or by the runtime — only by the order of the calls in the workflow
 * body — so it gets a test.
 *
 * Technique: the `dbos-typescript` skill's `test-setup` rule — mock the SDK so
 * `registerWorkflow` returns the raw function and `runStep` just invokes its callback,
 * recording the step name. Everything the steps touch (workspace/fs/git/npm, the child
 * processes, S3, the provider client, the row writers) is mocked, because the assertion
 * is about ORCHESTRATION, not about any one step's behaviour — those are unit-tested in
 * `render/*.test.ts` and exercised for real in `tests/e2e/render.render.e2e.ts`.
 */

const stepNames: string[] = [];

vi.mock("@dbos-inc/dbos-sdk", () => ({
  DBOS: {
    workflowID: "rj-1",
    registerWorkflow: (fn: unknown) => fn,
    runStep: async (fn: () => unknown, opts: { name: string }) => {
      stepNames.push(opts.name);
      return fn();
    },
    getWorkflowStatus: async () => ({ status: "PENDING" }),
  },
}));

vi.mock("@supagloo/database-lib", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  mintInstallationToken: vi.fn(async () => ({ token: "ghs_token" })),
}));

const fakePrisma = {
  renderJob: {
    findUnique: vi.fn(async () => ({
      id: "rj-1",
      projectId: "proj-1",
      versionId: "ver-1",
      userId: "user-1",
      status: "queued",
      framesDone: 0,
      framesTotal: 0,
      width: 1080,
      height: 1920,
      fps: 30,
      aspectRatio: "9:16",
      codec: "h264",
      outputAssetKey: null,
      thumbnailAssetKey: null,
      runInBackground: true,
      error: null,
      project: { id: "proj-1", repoOwner: "acme", repoName: "psalm-91", ownerId: "user-1" },
      version: { id: "ver-1", branchName: "v0.0.1", semver: "0.0.1" },
    })),
    update: vi.fn(async () => ({})),
    updateMany: vi.fn(async () => ({ count: 1 })),
  },
  githubConnection: {
    findUnique: vi.fn(async () => ({ userId: "user-1", installationId: "42" })),
  },
  project: {
    findUnique: vi.fn(async () => ({ ownerId: "user-1" })),
  },
};

vi.mock("../db/app-db", () => ({ getAppDb: () => fakePrisma }));
vi.mock("../providers/config", () => ({
  getProviderConfig: () => ({
    openrouterBaseUrl: "https://openrouter.invalid",
    secretsEncryptionKey: TEST_SECRETS_ENCRYPTION_KEY,
  }),
}));
vi.mock("../providers/credentials", () => ({
  loadOpenRouterCredential: vi.fn(async () => ({ apiKey: "sk-or-x" })),
}));
vi.mock("../providers/media-client", () => ({
  requestSpeech: vi.fn(async () => ({
    bytes: Buffer.from("RIFF"),
    contentType: "audio/wav",
    generationId: "g1",
  })),
}));
vi.mock("../files/s3-config", () => ({
  getS3Config: () => ({ client: {}, bucket: "supagloo-dev" }),
}));
vi.mock("../files/s3-client", () => ({
  uploadAsset: vi.fn(async () => undefined),
  downloadAsset: vi.fn(async () => ({ bytes: Buffer.from("asset"), contentType: "image/png" })),
}));
vi.mock("./scaffold-project/config", () => ({
  getScaffoldConfig: () => ({
    githubApiBaseUrl: "http://github.invalid",
    githubGitBaseUrl: "http://git.invalid",
    githubAppId: "1",
    githubAppPrivateKey: "pk",
  }),
}));
vi.mock("./render/config", () => ({
  getRenderConfig: () => ({
    mediaTimeoutMs: 3_600_000,
    bundleTimeoutMs: 900_000,
    installTimeoutMs: 900_000,
    cancelPollMs: 2000,
    narrationModel: "narration-model",
    musicModel: "music-model",
  }),
}));

vi.mock("./render/workspace", () => ({
  COMPOSITION_ID: "Main",
  renderWorkspaceRoot: () => "/tmp/supagloo-render",
  renderWorkspace: (id: string) => ({
    root: `/tmp/supagloo-render/${id}`,
    repoDir: `/tmp/supagloo-render/${id}/repo`,
    publicDir: `/tmp/supagloo-render/${id}/repo/public`,
    bundleDir: `/tmp/supagloo-render/${id}/bundle`,
    outDir: `/tmp/supagloo-render/${id}/out`,
    videoPath: `/tmp/supagloo-render/${id}/out/output.mp4`,
    thumbnailPath: `/tmp/supagloo-render/${id}/out/thumb.jpg`,
  }),
  ensureClone: vi.fn(async () => undefined),
  readWorkspaceManifest: vi.fn(async () => shelterManifest),
  ensureDependencies: vi.fn(async () => ({ usedLockfile: false, skipped: false })),
  hasWorkspaceAsset: vi.fn(() => true),
  // Everything already on disk ⇒ the self-heal helpers are pure pass-throughs, so the
  // recorded step sequence reflects the workflow body and nothing else.
  hasBundle: vi.fn(() => true),
  hasRenderedVideo: vi.fn(() => true),
  hasThumbnail: vi.fn(() => true),
  writeWorkspaceAsset: vi.fn(async () => "/tmp/asset"),
  materializeRenderSources: vi.fn(async () => ({ filesWritten: [] })),
  ensureOutDir: vi.fn(async () => undefined),
  readRenderOutputs: vi.fn(async () => ({
    video: Buffer.from("mp4"),
    thumbnail: Buffer.from("jpg"),
  })),
  removeWorkspace: vi.fn(async () => undefined),
}));

vi.mock("./render/child-runner", () => ({
  runBundleChild: vi.fn(async () => ({
    bundleDir: "/tmp/supagloo-render/rj-1/.render/bundle",
    composition: {
      id: "Main",
      width: 1080,
      height: 1920,
      fps: 30,
      durationInFrames: 360,
    },
  })),
  runRenderChild: vi.fn(async () => ({ outputPath: "/tmp/out.mp4", framesRendered: 360 })),
  runStillChild: vi.fn(async () => ({ outputPath: "/tmp/thumb.jpg" })),
}));

vi.mock("./render/status", () => ({
  TERMINAL_RENDER_STATUSES: ["completed", "failed", "canceled"],
  markRenderStarted: vi.fn(async () => undefined),
  setRenderStatus: vi.fn(async () => undefined),
  setRenderFramesTotal: vi.fn(async () => undefined),
  recordFrameProgress: vi.fn(async () => undefined),
  markRenderCompleted: vi.fn(async () => undefined),
  markRenderFailed: vi.fn(async () => undefined),
  markRenderCanceled: vi.fn(async () => undefined),
}));

// Imported AFTER the mocks are declared (vi.mock is hoisted, but keep it explicit).
import { RENDER_STEP_SEQUENCE, renderWorkflow } from "./render";

beforeEach(() => {
  stepNames.length = 0;
});

describe("renderWorkflow — step ordering", () => {
  it("runs the design's steps in exactly the design's order", async () => {
    await renderWorkflow({ renderJobId: "rj-1" });
    expect(stepNames).toEqual([...RENDER_STEP_SEQUENCE]);
  });

  it("synthesizes/ensures BOTH audio tracks BEFORE bundleComposition (Remotion snapshots assets at bundle time)", async () => {
    await renderWorkflow({ renderJobId: "rj-1" });
    const bundleAt = stepNames.indexOf("bundleComposition");
    expect(bundleAt).toBeGreaterThan(-1);
    expect(stepNames.indexOf("ensureNarrationAudio")).toBeLessThan(bundleAt);
    expect(stepNames.indexOf("ensureMusicAudio")).toBeLessThan(bundleAt);
  });

  it("re-materializes the workspace sources after the audio steps and before bundling", async () => {
    await renderWorkflow({ renderJobId: "rj-1" });
    const sourcesAt = stepNames.indexOf("materializeRenderSources");
    expect(sourcesAt).toBeGreaterThan(stepNames.indexOf("ensureMusicAudio"));
    expect(sourcesAt).toBeLessThan(stepNames.indexOf("bundleComposition"));
  });

  it("downloads scene assets before the audio steps and installs dependencies before both", async () => {
    await renderWorkflow({ renderJobId: "rj-1" });
    expect(stepNames.indexOf("installDependencies")).toBeLessThan(
      stepNames.indexOf("downloadSceneAssets"),
    );
    expect(stepNames.indexOf("downloadSceneAssets")).toBeLessThan(
      stepNames.indexOf("ensureNarrationAudio"),
    );
  });

  it("clones at the version only after minting an installation token (design §7)", async () => {
    await renderWorkflow({ renderJobId: "rj-1" });
    expect(stepNames.indexOf("mintInstallationToken")).toBeLessThan(
      stepNames.indexOf("cloneAtVersion"),
    );
  });

  it("renders, thumbnails, uploads, then marks completed — in that order", async () => {
    await renderWorkflow({ renderJobId: "rj-1" });
    const order = ["renderMedia", "generateThumbnail", "uploadOutputs", "markCompleted"];
    const indices = order.map((n) => stepNames.indexOf(n));
    expect(indices).toEqual([...indices].sort((a, b) => a - b));
    expect(indices.every((i) => i > -1)).toBe(true);
  });

  it("declares the canonical sequence, with markStarted first and markCompleted last", () => {
    expect(RENDER_STEP_SEQUENCE[0]).toBe("markStarted");
    expect(RENDER_STEP_SEQUENCE[RENDER_STEP_SEQUENCE.length - 1]).toBe("markCompleted");
    expect(new Set(RENDER_STEP_SEQUENCE).size).toBe(RENDER_STEP_SEQUENCE.length);
  });

  it("returns the db-lib-shaped output keys for the render job", async () => {
    const result = await renderWorkflow({ renderJobId: "rj-1" });
    expect(result.outputAssetKey).toBe("renders/rj-1/output.mp4");
    expect(result.thumbnailAssetKey).toBe("renders/rj-1/thumb.jpg");
    expect(result.framesTotal).toBe(360);
  });
});
