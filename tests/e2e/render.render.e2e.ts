import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DBOS, DBOSClient } from "@dbos-inc/dbos-sdk";
import {
  GetObjectCommand,
  PutObjectCommand,
  type S3Client,
} from "@aws-sdk/client-s3";
import {
  buildAssetKey,
  buildRenderOutputKey,
  buildRenderThumbnailKey,
  createPrismaClient,
  type ProjectManifest,
} from "@supagloo/database-lib";
import { getVideoMetadata } from "@remotion/renderer";
import { loadEnv, type Env } from "../../src/config/env";
import { launchDbos, shutdownDbos } from "../../src/dbos/runtime";
import { WORKFLOW_NAMES, WORKFLOW_QUEUE } from "../../src/dbos/registry";
import { makeInternalS3Client } from "../../src/files/s3-client";
import { writeRemotionScaffold } from "../../src/remotion";
import { wavFromPcm16 } from "../../src/providers/media-client";
import {
  resolveGenerationSeedCreds,
  seedOpenRouterConnection,
  type GenerationSeedCreds,
} from "../../src/testing/seed-connections";
import { resolveAudioModel } from "../../src/testing/e2e-models";
import {
  authenticatedRemoteUrl,
  provisionFixtureRepo,
  resolveGithubE2eSecrets,
  seedGithubConnection,
  type FixtureRepo,
} from "../../src/testing/github-e2e";
import { countStepExecutions } from "../../src/testing/step-introspection";
import {
  __setRenderBoundaryHook,
  renderWorkspaceRoot,
  type RenderResult,
  type RenderWorkflowPayload,
} from "../../src/workflows/render";

/**
 * END-TO-END proof of `renderWorkflow` (design-delta §6c, §7 workflow 9; plan row 36).
 *
 * Everything here is real: **real github.com** serves a real clone of a real scaffolded
 * Remotion project over HTTPS, authenticated with an installation token minted by the
 * product's own code; `npm install --ignore-scripts` really installs Remotion from the
 * public registry into the clone; the manifest's assets are really downloaded out of the
 * Compose MinIO into the workspace `public/` dir; `@remotion/bundler` really bundles;
 * `@remotion/renderer` really drives a headless Chromium and really encodes H.264; and
 * the mp4 + thumbnail really land in MinIO. No mocks anywhere.
 *
 * Task 62 (design-delta §11): the github-stub (:4801) and the local git smart-HTTP
 * server (:4805) are DELETED. Each spec provisions its own per-run throwaway repo
 * (the shared e2e prefix + `render-<label>` + the run id, private, `auto_init`) on the real
 * account and pushes its fixture branch there. That makes this the spec where the render
 * lane's **real network clone from github.com** is proven — retiring the
 * stale-git-server-fixture trap (tech-lead memory `render-workflow-gotchas`) by deletion
 * rather than by documentation. The repos are NEVER torn down in-suite; reclaim them with
 * root's interactive `npm run cleanup:github-e2e`, which archives (never deletes) and
 * confirms per repo.
 *
 * Four proofs:
 *   1. happy path — playable mp4 (probed with `getVideoMetadata`) + thumbnail in MinIO
 *   2. cancel mid-render → row is `canceled`, no orphan status, no output object
 *   3. crash/replay during `renderMedia` (workspace deleted = fresh worker) → completes,
 *      side effects exactly once, the row is never corrupt
 *   4. the SYNTHESIS branch — manifest lacking a narration ref → live OpenRouter TTS,
 *      written into the workspace BEFORE bundling, audible in the output
 *
 * Specs 1-3 make ZERO provider calls (the fixture manifest carries cached audio refs), so
 * only spec 4 costs money. Per design-delta §10 OpenRouter is never stubbed; per §10.6
 * deterministic provider misbehaviour is a unit concern, not an e2e one.
 */

const S3_PUBLIC = process.env.S3_PUBLIC_ENDPOINT ?? "http://localhost:9000";
const S3_BUCKET = process.env.S3_BUCKET ?? "supagloo-dev";
const ENCRYPTION_KEY = "0".repeat(64);

// Real GitHub App credentials from the root `.env` (loaded into this worker by
// `tests/e2e/load-root-env.ts`). Fails fast, by name, if any is missing — never a
// generated throwaway keypair with `appId: "123456"`, which could only ever have worked
// against a stub.
const githubSecrets = resolveGithubE2eSecrets();

function makeEnv(overrides: Record<string, string | undefined> = {}): Env {
  return loadEnv({
    DATABASE_URL:
      process.env.DATABASE_URL ?? "postgres://supagloo:supagloo@localhost:5432/supagloo",
    DBOS_DATABASE_URL:
      process.env.DBOS_DATABASE_URL ??
      "postgres://supagloo:supagloo@localhost:5432/supagloo_dbos",
    NODE_ENV: "test",
    // NO GITHUB_API_BASE_URL / GITHUB_GIT_BASE_URL: `src/config/env.ts` defaults them to
    // https://api.github.com and https://github.com, so real-by-default is achieved by
    // NOT overriding them (synthesis finding F1 — the worker was always real; only the
    // specs pointed it at the stub).
    GITHUB_APP_ID: githubSecrets.appId,
    GITHUB_APP_PRIVATE_KEY: githubSecrets.privateKey,
    OPENROUTER_BASE_URL: process.env.OPENROUTER_BASE_URL,
    SECRETS_ENCRYPTION_KEY: ENCRYPTION_KEY,
    // The in-process worker reaches MinIO at the HOST-reachable endpoint.
    S3_ENDPOINT: S3_PUBLIC,
    S3_PUBLIC_ENDPOINT: S3_PUBLIC,
    S3_BUCKET,
    S3_ACCESS_KEY: process.env.S3_ACCESS_KEY ?? "supagloo",
    S3_SECRET_KEY: process.env.S3_SECRET_KEY ?? "supagloo-dev",
    S3_REGION: process.env.S3_REGION ?? "us-east-1",
    ...overrides,
  });
}

// A tiny composition: 1 scene x 1 second at 10 fps = TEN frames at 320x180. The smallest
// thing that is still a real H.264 encode with a real image and a real audio track.
const FPS = 10;
const WIDTH = 320;
const HEIGHT = 180;
const FRAMES = 10;

const prisma = createPrismaClient({
  connectionString:
    process.env.DATABASE_URL ?? "postgres://supagloo:supagloo@localhost:5432/supagloo",
});
let client: DBOSClient;
let s3: S3Client;
let creds: GenerationSeedCreds | undefined;

// A minimal, valid 1x1 PNG (IHDR + IDAT + IEND) — a real decodable image for <Img>.
const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);
// A real, decodable ~0.5s of silent 24kHz mono PCM16, WAV-wrapped by our own helper.
const TINY_WAV = wavFromPcm16(Buffer.alloc(24_000 * 2 * 0.5));

const tempDirs: string[] = [];

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function git(args: string[], cwd?: string): void {
  execFileSync("git", args, {
    cwd,
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: "0",
      GIT_AUTHOR_NAME: "Render E2E",
      GIT_AUTHOR_EMAIL: "render@supagloo.test",
      GIT_COMMITTER_NAME: "Render E2E",
      GIT_COMMITTER_EMAIL: "render@supagloo.test",
    },
    stdio: "pipe",
  });
}

/**
 * Push a REAL scaffolded Remotion project to `branch` of a freshly provisioned,
 * per-run, PRIVATE fixture repo on real github.com.
 *
 * The fixture push uses an `x-access-token:<installation token>@github.com/...` remote —
 * the same authenticated shape the product builds — because the repo is private and the
 * retired git-server needed no credential at all. `provisionFixtureRepo` has already
 * gated on the repo being readable AND visible to the installation, so the workflow's
 * own `ensureRepoReachable` (which classifies absence as PERMANENT) cannot lose a race
 * with GitHub's eventual consistency.
 */
async function pushScaffoldedProject(
  fixture: FixtureRepo,
  branch: string,
  manifest: ProjectManifest,
  token: string,
): Promise<void> {
  const dir = tempDir("supagloo-render-fixture-");
  git([
    "clone",
    authenticatedRemoteUrl({ token, owner: fixture.owner, repo: fixture.repo }),
    dir,
  ]);
  await writeRemotionScaffold(manifest, dir);
  git(["checkout", "-B", branch], dir);
  git(["add", "-A"], dir);
  git(["commit", "-m", "fixture: scaffolded Remotion project"], dir);
  git(["push", "origin", branch], dir);
}

async function putObject(key: string, bytes: Buffer, contentType: string) {
  await s3.send(
    new PutObjectCommand({
      Bucket: S3_BUCKET,
      Key: key,
      Body: bytes,
      ContentType: contentType,
    }),
  );
}

async function getObjectBytes(key: string): Promise<Buffer | null> {
  try {
    const res = await s3.send(
      new GetObjectCommand({ Bucket: S3_BUCKET, Key: key }),
    );
    const body = res.Body as { transformToByteArray: () => Promise<Uint8Array> };
    return Buffer.from(await body.transformToByteArray());
  } catch {
    return null;
  }
}

interface Seeded {
  renderJobId: string;
  projectId: string;
  userId: string;
  /** The per-run throwaway repo on real github.com this subject renders from. */
  fixture: FixtureRepo;
  payload: RenderWorkflowPayload;
}

/**
 * Seed a complete render subject: user (+ the DISCOVERED GitHub installation, +
 * optionally a real OpenRouter connection), a per-run PRIVATE fixture repo on real
 * github.com, project, working version, uploaded assets, a scaffolded project pushed to
 * that repo, and a queued RenderJob.
 */
async function seedRender(
  label: string,
  opts: { withNarrationRef: boolean; withOpenRouter?: boolean } = {
    withNarrationRef: true,
  },
): Promise<Seeded> {
  const suffix = randomUUID().slice(0, 8);

  const user = await prisma.user.create({
    data: {
      youversionUserId: `yv-render-${suffix}`,
      displayName: "Render E2E",
      email: `render-${suffix}@supagloo.test`,
      avatarInitials: "RE",
    },
  });
  // The installation id + login are DISCOVERED at runtime (task 62 D5) — the fabricated
  // `installationId: "42"` / `githubLogin: "acme"` pair is exactly what made real GitHub
  // 404 `POST /app/installations/42/access_tokens` (plan row 62 item (d)).
  const github = await seedGithubConnection({ prisma, userId: user.id });
  if (opts.withOpenRouter) {
    creds ??= resolveGenerationSeedCreds();
    await seedOpenRouterConnection({
      prisma,
      userId: user.id,
      apiKey: creds.openrouterKey,
      encryptionKey: ENCRYPTION_KEY,
    });
  }

  // The fixture repo must exist before the Project row, because the row records the
  // repo it points at. `provisionFixtureRepo` creates it with the PAT
  // (`private: true, auto_init: true`) and gates on repo-readiness THEN
  // installation-visibility before returning.
  const fixture = await provisionFixtureRepo(`render-${label}`);

  const project = await prisma.project.create({
    data: {
      slug: `render-${suffix}`,
      ownerId: user.id,
      name: "Render E2E",
      repoOwner: fixture.owner,
      repoName: fixture.repo,
      repoVisibility: "private",
      createdFrom: "blank",
      currentBranch: "v0.0.1",
    },
  });

  // Assets referenced by the manifest, really uploaded to MinIO.
  const visualKey = buildAssetKey(project.id, `visual-${suffix}`);
  const musicKey = buildAssetKey(project.id, `music-${suffix}`);
  const narrationKey = buildAssetKey(project.id, `narration-${suffix}`);
  await putObject(visualKey, TINY_PNG, "image/png");
  await putObject(musicKey, TINY_WAV, "audio/wav");
  if (opts.withNarrationRef) await putObject(narrationKey, TINY_WAV, "audio/wav");

  const manifest: ProjectManifest = {
    manifestVersion: 1,
    composition: { width: WIDTH, height: HEIGHT, fps: FPS, aspectRatio: "16:9" },
    scenes: [
      {
        id: "scene-1",
        name: "Shelter",
        scriptText: "He who dwells in the shelter of the Most High.",
        reference: "Psalm 91:1",
        translation: "BSB",
        visualPrompt: "a starlit desert sky",
        durationSeconds: 1,
        captions: true,
        visualAssetKey: visualKey,
      },
    ],
    narratorVoice: {
      description: "Warm, reverent narrator",
      ...(opts.withNarrationRef ? { assetKey: narrationKey } : {}),
    },
    music: { style: "ambient cinematic pads", assetKey: musicKey },
  };

  await pushScaffoldedProject(fixture, "v0.0.1", manifest, github.token);

  const version = await prisma.projectVersion.create({
    data: {
      projectId: project.id,
      semver: "0.0.1",
      branchName: "v0.0.1",
      state: "working",
      headCommitSha: "0".repeat(40),
      changedFiles: [],
    },
  });

  const renderJobId = `render-${project.id}-${suffix}`;
  await prisma.renderJob.create({
    data: {
      id: renderJobId,
      projectId: project.id,
      versionId: version.id,
      userId: user.id,
      status: "queued",
      framesTotal: 0,
      width: WIDTH,
      height: HEIGHT,
      fps: FPS,
      aspectRatio: "16:9",
      codec: "h264",
      runInBackground: true,
    },
  });

  return {
    renderJobId,
    projectId: project.id,
    userId: user.id,
    fixture,
    payload: { renderJobId },
  };
}

function enqueueRender(seeded: Seeded) {
  return client.enqueue<RenderResult>(
    {
      workflowName: WORKFLOW_NAMES.render,
      queueName: WORKFLOW_QUEUE.render,
      workflowID: seeded.renderJobId,
    },
    seeded.payload,
  );
}

async function waitForDbosStatus(id: string, statuses: string[]): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const [wf] = await DBOS.listWorkflows({ workflowIDs: [id] });
    if (wf && statuses.includes(wf.status)) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`workflow ${id} did not reach ${statuses.join("/")} in time`);
}

beforeAll(async () => {
  s3 = makeInternalS3Client({
    endpoint: S3_PUBLIC,
    region: process.env.S3_REGION ?? "us-east-1",
    bucket: S3_BUCKET,
    accessKey: process.env.S3_ACCESS_KEY ?? "supagloo",
    secretKey: process.env.S3_SECRET_KEY ?? "supagloo-dev",
  });
  await launchDbos(makeEnv());
  client = await DBOSClient.create({
    systemDatabaseUrl:
      process.env.DBOS_DATABASE_URL ??
      "postgres://supagloo:supagloo@localhost:5432/supagloo_dbos",
  });
}, 600_000);

afterAll(async () => {
  __setRenderBoundaryHook(undefined);
  await client?.destroy().catch(() => {});
  await shutdownDbos();
  await prisma.$disconnect().catch(() => {});
  s3?.destroy();
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

describe("renderWorkflow — happy path (real npm install, real bundle, real Chromium encode)", () => {
  it("renders a small fixture project end to end: playable mp4 + thumbnail in MinIO", async () => {
    const seeded = await seedRender("happy");

    const handle = await enqueueRender(seeded);
    const result = await handle.getResult();

    expect(result.renderJobId).toBe(seeded.renderJobId);
    expect(result.outputAssetKey).toBe(buildRenderOutputKey(seeded.renderJobId));
    expect(result.thumbnailAssetKey).toBe(
      buildRenderThumbnailKey(seeded.renderJobId),
    );

    // The row is completed and internally coherent.
    const job = await prisma.renderJob.findUniqueOrThrow({
      where: { id: seeded.renderJobId },
    });
    expect(job.status).toBe("completed");
    expect(job.framesTotal).toBe(FRAMES);
    expect(job.framesDone).toBe(job.framesTotal);
    expect(job.outputAssetKey).toBe(buildRenderOutputKey(seeded.renderJobId));
    expect(job.thumbnailAssetKey).toBe(buildRenderThumbnailKey(seeded.renderJobId));
    expect(job.startedAt).toBeInstanceOf(Date);
    expect(job.completedAt).toBeInstanceOf(Date);
    expect(job.error).toBeNull();

    // Real objects in MinIO.
    const mp4 = await getObjectBytes(buildRenderOutputKey(seeded.renderJobId));
    const thumb = await getObjectBytes(buildRenderThumbnailKey(seeded.renderJobId));
    expect(mp4).not.toBeNull();
    expect(thumb).not.toBeNull();
    expect(mp4!.byteLength).toBeGreaterThan(1000);
    expect(thumb!.byteLength).toBeGreaterThan(200);
    // A real MP4 container: `....ftyp` at offset 4; a real JPEG starts FF D8 FF.
    expect(mp4!.subarray(4, 8).toString("ascii")).toBe("ftyp");
    expect(thumb!.subarray(0, 3)).toEqual(Buffer.from([0xff, 0xd8, 0xff]));

    // PLAYABLE: probe the encoded file for real dimensions/fps/duration.
    const probeDir = tempDir("supagloo-render-probe-");
    const probePath = join(probeDir, "output.mp4");
    writeFileSync(probePath, mp4!);
    const meta = await getVideoMetadata(probePath);
    expect(meta.width).toBe(WIDTH);
    expect(meta.height).toBe(HEIGHT);
    expect(meta.durationInSeconds).toBeGreaterThan(0.5);
    expect(meta.durationInSeconds).toBeLessThan(2);

    // Dependencies installed exactly once — no accidental re-install loop.
    expect(
      await countStepExecutions(client, seeded.renderJobId, "installDependencies"),
    ).toBe(1);
    expect(await countStepExecutions(client, seeded.renderJobId, "renderMedia")).toBe(1);
  });
});

describe("renderWorkflow — cancel mid-render", () => {
  it("flips the RenderJob to canceled with no orphan status and no output object", async () => {
    const seeded = await seedRender("cancel");

    let release!: () => void;
    const reached = new Promise<void>((resolve) => {
      __setRenderBoundaryHook(async (label) => {
        if (label === "renderMedia") {
          resolve();
          await new Promise<void>((r) => {
            release = r;
          });
        }
      });
    });

    const handle = await enqueueRender(seeded);
    const settled = handle.getResult().then(
      () => "ok",
      () => "interrupted",
    );

    await reached;
    // This is exactly what the render API's cancel endpoint (task 37) will do.
    await DBOS.cancelWorkflow(seeded.renderJobId);
    release();
    expect(await settled).toBe("interrupted");
    __setRenderBoundaryHook(undefined);

    await waitForDbosStatus(seeded.renderJobId, ["CANCELLED"]);

    const job = await prisma.renderJob.findUniqueOrThrow({
      where: { id: seeded.renderJobId },
    });
    expect(job.status).toBe("canceled");
    // No orphan: the row is NOT left mid-phase, and no output was published.
    expect(["bundling", "encoding", "uploading", "synthesizing", "queued"]).not.toContain(
      job.status,
    );
    expect(job.outputAssetKey).toBeNull();
    expect(job.thumbnailAssetKey).toBeNull();
    expect(
      await getObjectBytes(buildRenderOutputKey(seeded.renderJobId)),
    ).toBeNull();
  });
});

describe("renderWorkflow — crash / replay during renderMedia", () => {
  it("rebuilds the lost workspace on resume, completes exactly once, and never corrupts the row", async () => {
    const seeded = await seedRender("replay");

    let release!: () => void;
    const reached = new Promise<void>((resolve) => {
      __setRenderBoundaryHook(async (label) => {
        if (label === "renderMedia") {
          resolve();
          await new Promise<void>((r) => {
            release = r;
          });
        }
      });
    });

    const handle = await enqueueRender(seeded);
    const settled = handle.getResult().then(
      () => "ok",
      () => "interrupted",
    );

    await reached;
    await DBOS.cancelWorkflow(seeded.renderJobId);
    // Simulate a genuinely fresh worker: the ephemeral workspace (clone, node_modules,
    // downloaded assets, bundle) is gone. Every workspace-dependent step must self-heal.
    rmSync(join(renderWorkspaceRoot(), seeded.renderJobId), {
      recursive: true,
      force: true,
    });
    release();
    await settled;

    // The interrupted attempt published nothing.
    expect(
      await getObjectBytes(buildRenderOutputKey(seeded.renderJobId)),
    ).toBeNull();

    __setRenderBoundaryHook(undefined);
    await waitForDbosStatus(seeded.renderJobId, ["CANCELLED", "ERROR"]);

    const resumed = await DBOS.resumeWorkflow<RenderResult>(seeded.renderJobId);
    const result = await resumed.getResult();
    expect(result.renderJobId).toBe(seeded.renderJobId);

    const job = await prisma.renderJob.findUniqueOrThrow({
      where: { id: seeded.renderJobId },
    });
    // The row is coherent: completed WITH its keys, frames never exceeding the total.
    expect(job.status).toBe("completed");
    expect(job.outputAssetKey).toBe(buildRenderOutputKey(seeded.renderJobId));
    expect(job.thumbnailAssetKey).toBe(buildRenderThumbnailKey(seeded.renderJobId));
    expect(job.framesDone).toBeLessThanOrEqual(job.framesTotal);
    expect(job.framesDone).toBe(job.framesTotal);
    expect(job.error).toBeNull();

    // Exactly-once side effects: the completed upload step ran once (the replay resumed
    // from the last COMPLETED step, it did not redo the whole workflow).
    expect(await countStepExecutions(client, seeded.renderJobId, "uploadOutputs")).toBe(1);
    expect(await countStepExecutions(client, seeded.renderJobId, "markCompleted")).toBe(1);

    const mp4 = await getObjectBytes(buildRenderOutputKey(seeded.renderJobId));
    expect(mp4).not.toBeNull();
    expect(mp4!.subarray(4, 8).toString("ascii")).toBe("ftyp");
  });
});

describe("renderWorkflow — narration synthesis fallback (LIVE OpenRouter)", () => {
  it("synthesizes the missing narration into the workspace BEFORE bundling and it lands in the encode", async () => {
    // Model ids are never hardcoded (design §10.9) — resolve one from live discovery.
    const narrationModel = await resolveAudioModel(
      { OPENROUTER_BASE_URL: process.env.OPENROUTER_BASE_URL ?? "https://openrouter.ai" },
      "narration",
    );
    // Re-launch the runtime with the render narration model configured; without it the
    // workflow deliberately SKIPS synthesis rather than failing (plan D5).
    await shutdownDbos();
    await launchDbos(makeEnv({ RENDER_NARRATION_MODEL: narrationModel }));

    const seeded = await seedRender("synth", {
      withNarrationRef: false,
      withOpenRouter: true,
    });

    const handle = await enqueueRender(seeded);
    const result = await handle.getResult();

    expect(result.audio.narration).toBe("synthesized");
    expect(result.audio.music).toBe("cached");

    const job = await prisma.renderJob.findUniqueOrThrow({
      where: { id: seeded.renderJobId },
    });
    expect(job.status).toBe("completed");

    // The synthesized track really made it into the encode: the mp4 carries audio.
    const mp4 = await getObjectBytes(buildRenderOutputKey(seeded.renderJobId));
    expect(mp4).not.toBeNull();
    const probeDir = tempDir("supagloo-render-audio-probe-");
    const probePath = join(probeDir, "output.mp4");
    writeFileSync(probePath, mp4!);
    const meta = await getVideoMetadata(probePath);
    expect(meta.audioCodec).toBeTruthy();
  });
});
