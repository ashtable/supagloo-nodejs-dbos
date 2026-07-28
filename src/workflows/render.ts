import { DBOS } from "@dbos-inc/dbos-sdk";
import {
  buildRenderOutputKey,
  buildRenderThumbnailKey,
  type PrismaClient,
  type ProjectManifest,
  type RenderWorkflowPayload,
} from "@supagloo/database-lib";
import { WORKFLOW_NAMES } from "../dbos/registry";
import { getAppDb } from "../db/app-db";
import { getScaffoldConfig } from "./scaffold-project/config";
import {
  mintEncryptedInstallationToken,
  openInstallationToken,
} from "./shared/installation-token";
import { getProviderConfig } from "../providers/config";
import { loadOpenRouterCredential } from "../providers/credentials";
import { requestMusic, requestSpeech } from "../providers/media-client";
import { getS3Config } from "../files/s3-config";
import { downloadAsset, uploadAsset } from "../files/s3-client";
import { getRenderConfig } from "./render/config";
import {
  RenderRequestInvalidError,
  RENDER_NETWORK_RETRY,
  isPermanentRenderFailure,
  isRenderCancellation,
  retryUnlessPermanentRender,
} from "./render/errors";
import { parseRenderRequest, type RenderRequest } from "./render/request";
import { applyOutputSpec, type ResolvedComposition } from "./render/composition";
import {
  applyAudioPlans,
  audioPlanOutcome,
  planAudioTrack,
  type AudioPlan,
  type AudioPlans,
  type NarrationScenePlan,
} from "./render/audio";
import {
  markRenderCanceled,
  markRenderCompleted,
  markRenderFailed,
  markRenderStarted,
  recordFrameProgress,
  setRenderFramesTotal,
  setRenderStatus,
} from "./render/status";
import {
  runBundleChild,
  runRenderChild,
  runStillChild,
} from "./render/child-runner";
import {
  COMPOSITION_ID,
  ensureClone,
  ensureDependencies,
  ensureOutDir,
  hasBundle,
  hasRenderedVideo,
  hasThumbnail,
  hasWorkspaceAsset,
  materializeRenderSources,
  readRenderOutputs,
  readWorkspaceManifest,
  removeWorkspace,
  renderWorkspace,
  renderWorkspaceRoot,
  writeWorkspaceAsset,
  type RenderWorkspace,
} from "./render/workspace";

/**
 * `renderWorkflow` (queue `render`, workerConcurrency 1) — design-delta §6c, §7 workflow 9.
 *
 * Fifteen steps, in the design's order:
 *   markStarted → loadCredentials → mintInstallationToken → cloneAtVersion → readManifest
 *   → installDependencies → downloadSceneAssets → ensureNarrationAudio / ensureMusicAudio
 *   → materializeRenderSources → bundleComposition → renderMedia → generateThumbnail
 *   → uploadOutputs → markCompleted
 *
 * WHY AUDIO BEFORE BUNDLE (the invariant `render.order.test.ts` guards): Remotion's
 * `bundle()` SNAPSHOTS the project's `public/` directory into the bundle — verified in
 * @remotion/bundler 4.0.490, which copies `<root>/public` to `<outDir>/public` and serves
 * it at `/public`. Audio written after bundling is simply not in the bundle. So both audio
 * tracks are materialized into `public/` first, and `materializeRenderSources` regenerates
 * the composition from an audio-patched manifest so the tracks are actually REFERENCED
 * (without that second half, "audio before bundle" would be theatre).
 *
 * UNTRUSTED-CODE ISOLATION: the clone is user-controlled code, so `npm ci` always runs
 * with `--ignore-scripts`, and the npm/bundle/render/still children run with an
 * ALLOWLIST-built environment (`render/child-env.ts`) — no `SECRETS_ENCRYPTION_KEY`, no
 * `GITHUB_APP_PRIVATE_KEY`, no provider hosts, no database credentials. Full sandboxing
 * (microVM/container-per-render) is explicitly post-v1.
 *
 * PROGRESS: the render child streams `renderedFrames` and the parent writes a THROTTLED,
 * GUARDED `updateMany({ framesDone: { lt: n } })`. The guard is what makes progress
 * monotonic across a retry or a recovery-replay, which both restart the encode at frame 0.
 * Not `DBOS.setEvent`/`writeStream`: events must be published from the workflow body (not
 * from inside a step's callback), each is a durable system-DB write — thousands per render
 * — and stream writes from steps are at-least-once, so a replay would append a rewound
 * duplicate series.
 *
 * CANCEL: `DBOS.cancelWorkflow(renderJobId)` preempts only at the NEXT step boundary, so
 * the long steps ALSO poll their own DBOS status and fire Remotion's cancel signal to tear
 * Chromium down promptly. And because no `DBOS.runStep` may execute once a workflow is
 * CANCELLED, the `canceled` row write is a direct, conditional, idempotent Prisma write
 * from the workflow body rather than a checkpointed step.
 *
 * CRASH/REPLAY: the workspace is ephemeral, so every workspace-dependent step calls
 * `ensureWorkspaceReady` first, which idempotently rebuilds whatever is missing (the
 * `scaffoldProjectWorkflow` precedent). A genuine crash mid-`renderMedia` therefore
 * RE-EXECUTES the whole rendering step — Remotion does not checkpoint partial frames and
 * an encode cannot be resumed. Accepted limitation, not an oversight.
 *
 * Registered STATICALLY at module load (imported by runtime.ts before `DBOS.launch()`).
 */

export const RENDER_WORKFLOW_NAME = WORKFLOW_NAMES.render;

// Re-exported so importers of this module (e.g. the e2e) keep importing the enqueue
// payload type from here — parity with the other workflows.
export type { RenderWorkflowPayload };
export { renderWorkspaceRoot };

/** The canonical step order. Pinned by `render.order.test.ts`. */
export const RENDER_STEP_SEQUENCE = [
  "markStarted",
  "loadCredentials",
  "mintInstallationToken",
  "cloneAtVersion",
  "readManifest",
  "installDependencies",
  "downloadSceneAssets",
  "ensureNarrationAudio",
  "ensureMusicAudio",
  "materializeRenderSources",
  "bundleComposition",
  "renderMedia",
  "generateThumbnail",
  "uploadOutputs",
  "markCompleted",
] as const;

export interface RenderResult {
  renderJobId: string;
  outputAssetKey: string;
  thumbnailAssetKey: string;
  framesTotal: number;
  audio: {
    narration: "cached" | "synthesized" | "skipped";
    music: "cached" | "synthesized" | "skipped";
  };
}

/**
 * TEST-ONLY DI seam (undefined in production ⇒ a pure no-op). The workflow awaits this
 * hook at each step BOUNDARY so a test can park the workflow and drive a cancel or a
 * crash/replay — the task-36 e2e parks at `"renderMedia"`. Reading a module-level ref is a
 * DI read, not workflow state, and the hook never changes which steps run, so determinism
 * is preserved.
 */
export type BoundaryHook = (label: string) => void | Promise<void>;
let boundaryHook: BoundaryHook | undefined;
export function __setRenderBoundaryHook(hook: BoundaryHook | undefined): void {
  boundaryHook = hook;
}
async function boundary(label: string): Promise<void> {
  if (boundaryHook) await boundaryHook(label);
}

/** Build the authenticated clone URL (`x-access-token:<token>@host/owner/repo.git`). */
function authenticatedCloneUrl(
  gitBaseUrl: string,
  owner: string,
  repo: string,
  token: string,
): string {
  const url = new URL(`${gitBaseUrl.replace(/\/+$/, "")}/${owner}/${repo}.git`);
  url.username = "x-access-token";
  url.password = token;
  return url.toString();
}

/** Every S3 asset key the manifest references (scene visuals + cached audio beds). */
function manifestAssetKeys(manifest: ProjectManifest): string[] {
  const keys = new Set<string>();
  for (const scene of manifest.scenes) {
    if (scene.visualAssetKey) keys.add(scene.visualAssetKey);
  }
  if (manifest.narratorVoice.assetKey) keys.add(manifest.narratorVoice.assetKey);
  if (manifest.music?.assetKey) keys.add(manifest.music.assetKey);
  return [...keys];
}

/** Everything the workspace-rebuild helpers need — all of it CHECKPOINTED step output. */
interface RenderContext {
  request: RenderRequest;
  cloneUrl: string;
  manifest: ProjectManifest;
  audioPlans?: AudioPlans;
  /** Resolved + output-spec-stamped; set once `bundleComposition` has checkpointed. */
  composition?: ResolvedComposition;
}

/** Download every manifest-referenced object that is not already on disk. */
async function ensureSceneAssets(
  ws: RenderWorkspace,
  manifest: ProjectManifest,
): Promise<string[]> {
  const { client, bucket } = getS3Config();
  const materialized: string[] = [];
  for (const key of manifestAssetKeys(manifest)) {
    if (hasWorkspaceAsset(ws, key)) {
      materialized.push(key);
      continue;
    }
    const { bytes } = await downloadAsset(client, { bucket, key });
    await writeWorkspaceAsset(ws, key, bytes);
    materialized.push(key);
  }
  return materialized;
}

/**
 * Materialize one audio plan onto disk, returning the plan ENRICHED with what was measured.
 *
 * The return value matters: the caller checkpoints it as the step's result, so the measured
 * lengths survive a crash and reach `applyAudioPlans`. Without them a render-time-synthesized
 * bed could not be looped and a render-time-synthesized narration could not stretch its
 * scene — i.e. this fallback path would quietly reproduce both original bugs.
 *
 * Narration synthesizes one clip PER SCENE; music synthesizes one bed.
 */
async function ensureAudioOnDisk(
  ws: RenderWorkspace,
  request: RenderRequest,
  plan: AudioPlan,
): Promise<AudioPlan> {
  if (plan.action !== "synthesize") return plan;
  const cfg = getProviderConfig();
  const prisma = getAppDb();
  // The key is (re)loaded INSIDE the call so it never lands in a DBOS checkpoint — the
  // discipline every generation workflow follows.
  const client = async () => {
    const cred = await loadOpenRouterCredential({
      prisma,
      userId: request.userId,
      encryptionKey: cfg.secretsEncryptionKey,
    });
    return { openrouterBaseUrl: cfg.openrouterBaseUrl, apiKey: cred.apiKey };
  };

  if (plan.kind === "narration") {
    const scenes: NarrationScenePlan[] = [];
    for (const scene of plan.scenes) {
      if (hasWorkspaceAsset(ws, scene.assetKey) && scene.durationSeconds !== undefined) {
        scenes.push(scene);
        continue;
      }
      const speech = await requestSpeech(await client(), scene.speechArgs);
      await writeWorkspaceAsset(ws, scene.assetKey, speech.bytes);
      scenes.push({
        ...scene,
        ...(speech.durationSeconds !== null
          ? { durationSeconds: speech.durationSeconds }
          : {}),
      });
    }
    return { ...plan, scenes };
  }

  if (hasWorkspaceAsset(ws, plan.assetKey) && plan.durationSeconds !== undefined) {
    return plan;
  }
  const music = await requestMusic(await client(), plan.musicArgs);
  await writeWorkspaceAsset(ws, plan.assetKey, music.bytes);
  return {
    ...plan,
    ...(music.durationSeconds !== null
      ? { durationSeconds: music.durationSeconds }
      : {}),
  };
}

/**
 * SELF-HEALING WORKSPACE (the `scaffoldProjectWorkflow` `materializeBaseVersion` pattern).
 *
 * The workspace lives in an OS temp dir that does not survive a worker restart, while
 * DBOS memoizes COMPLETED steps and resumes at the first incomplete one. So a step that
 * resumes after a crash can find that the artifacts its predecessors produced are simply
 * gone. Each `ensure*` below rebuilds exactly as much as its caller needs, idempotently,
 * from durable sources: git (the clone), the registry (`node_modules`), S3 (the assets),
 * the checkpointed manifest + audio plans (the sources), and — when necessary — a
 * re-bundle and a re-render.
 *
 * The crash/replay e2e proves this: it deletes the whole workspace mid-run and resumes.
 * Without the bundle/output rebuilds below, `renderMedia` fails with Remotion's
 * "…/index.html does not exist".
 */

/** Level 1 — just the clone (all the steps that run before the manifest is known). */
async function ensureClonedWorkspace(ctx: RenderContext): Promise<RenderWorkspace> {
  const ws = renderWorkspace(ctx.request.renderJobId);
  await ensureClone(ws, ctx.cloneUrl, ctx.request.branchName);
  return ws;
}

/** Level 2 — clone + dependencies + assets + audio + regenerated sources. */
async function ensureWorkspaceSources(ctx: RenderContext): Promise<RenderWorkspace> {
  const cfg = getRenderConfig();
  const ws = await ensureClonedWorkspace(ctx);
  await ensureDependencies(ws, cfg.installTimeoutMs);
  await ensureSceneAssets(ws, ctx.manifest);
  if (ctx.audioPlans) {
    await ensureAudioOnDisk(ws, ctx.request, ctx.audioPlans.narration);
    await ensureAudioOnDisk(ws, ctx.request, ctx.audioPlans.music);
    await materializeRenderSources(ws, applyAudioPlans(ctx.manifest, ctx.audioPlans));
  }
  await ensureOutDir(ws);
  return ws;
}

/** Run the bundle child and return the composition Remotion resolves for it. */
async function bundleInChild(
  ws: RenderWorkspace,
  renderJobId: string,
): Promise<ResolvedComposition> {
  const cfg = getRenderConfig();
  const { composition } = await runBundleChild(
    { projectDir: ws.repoDir, outDir: ws.bundleDir, compositionId: COMPOSITION_ID },
    {
      timeoutMs: cfg.bundleTimeoutMs,
      workflowId: renderJobId,
      cancelPollMs: cfg.cancelPollMs,
      callbacks: { getWorkflowStatus: (id) => DBOS.getWorkflowStatus(id) },
    },
  );
  return composition;
}

/** Level 3 — sources + a usable bundle (re-bundled only when it is missing). */
async function ensureBundledWorkspace(ctx: RenderContext): Promise<RenderWorkspace> {
  const ws = await ensureWorkspaceSources(ctx);
  if (!hasBundle(ws)) {
    await bundleInChild(ws, ctx.request.renderJobId);
  }
  return ws;
}

/**
 * Level 4 — bundle + the encoded artifacts (re-rendered only when missing).
 *
 * Needed by `uploadOutputs`: `renderMedia`/`generateThumbnail` are memoized steps, so a
 * crash between them and the upload leaves the upload with nothing to read. Re-rendering
 * inside the upload step is expensive but CORRECT, and it is the only alternative to
 * folding render+still+upload into one giant step (which would lose the design's step
 * granularity and the plan's per-step e2e assertions).
 */
async function ensureRenderedOutputs(ctx: RenderContext): Promise<RenderWorkspace> {
  const ws = await ensureBundledWorkspace(ctx);
  const composition = ctx.composition;
  if (!composition) return ws;
  if (!hasRenderedVideo(ws)) {
    await renderInChild(ctx, ws, composition);
  }
  if (!hasThumbnail(ws)) {
    await stillInChild(ctx, ws, composition);
  }
  return ws;
}

/**
 * Run the encode in a scrubbed child, relaying the frame stream to a THROTTLED, GUARDED
 * `framesDone` write. Extracted so the self-heal path (`ensureRenderedOutputs`) and the
 * `renderMedia` step share one implementation.
 */
async function renderInChild(
  ctx: RenderContext,
  ws: RenderWorkspace,
  composition: ResolvedComposition,
): Promise<number> {
  const cfg = getRenderConfig();
  const prisma = getAppDb();
  const renderJobId = ctx.request.renderJobId;
  let lastWrite = 0;
  const result = await runRenderChild(
    {
      serveUrl: ws.bundleDir,
      compositionId: composition.id,
      outputLocation: ws.videoPath,
      codec: ctx.request.outputSpec.codec,
      width: composition.width,
      height: composition.height,
      fps: composition.fps,
      durationInFrames: composition.durationInFrames,
      // Plan row 45 (§9-Q8) + Step-11 item 9: the child-process kill deadline AND
      // Remotion's own per-frame budget, which are two different numbers — passing the
      // deadline as the per-frame budget (what row 45 first shipped) makes the per-frame
      // budget unreachable. The child's env is scrubbed, so tuning crosses the boundary in
      // the spec rather than through the environment.
      mediaTimeoutMs: cfg.mediaTimeoutMs,
      frameTimeoutMs: cfg.mediaFrameTimeoutMs,
      ...(cfg.mediaConcurrency !== undefined
        ? { concurrency: cfg.mediaConcurrency }
        : {}),
    },
    {
      timeoutMs: cfg.mediaTimeoutMs,
      workflowId: renderJobId,
      cancelPollMs: cfg.cancelPollMs,
      callbacks: {
        getWorkflowStatus: (id) => DBOS.getWorkflowStatus(id),
        onProgress: (renderedFrames) => {
          // Throttle to at most one row write per second. The DB-side guard is what makes
          // it monotonic; this just keeps a high-frequency callback off the database.
          const now = Date.now();
          if (now - lastWrite < 1000) return;
          lastWrite = now;
          void recordFrameProgress(prisma, renderJobId, renderedFrames).catch(() => {
            /* progress is advisory — never fail a render over it */
          });
        },
      },
    },
  );
  await recordFrameProgress(prisma, renderJobId, result.framesRendered);
  return result.framesRendered;
}

/** Render the thumbnail still from the middle of the composition, in a scrubbed child. */
async function stillInChild(
  ctx: RenderContext,
  ws: RenderWorkspace,
  composition: ResolvedComposition,
): Promise<void> {
  const cfg = getRenderConfig();
  const frame = Math.min(
    Math.max(0, Math.floor(composition.durationInFrames / 2)),
    composition.durationInFrames - 1,
  );
  await runStillChild(
    {
      serveUrl: ws.bundleDir,
      compositionId: composition.id,
      outputLocation: ws.thumbnailPath,
      frame,
      width: composition.width,
      height: composition.height,
    },
    {
      timeoutMs: cfg.bundleTimeoutMs,
      workflowId: ctx.request.renderJobId,
      cancelPollMs: cfg.cancelPollMs,
      callbacks: { getWorkflowStatus: (id) => DBOS.getWorkflowStatus(id) },
    },
  );
}

async function renderFn(payload: RenderWorkflowPayload): Promise<RenderResult> {
  const renderJobId = DBOS.workflowID ?? payload.renderJobId;
  if (!renderJobId) {
    throw new Error("render: DBOS.workflowID unavailable inside the workflow");
  }
  const prisma: PrismaClient = getAppDb();

  try {
    // 1) markStarted — load the RenderJob (+ Project + ProjectVersion), validate the
    //    output spec against the SHARED schema, resolve the owner's GitHub installation,
    //    and stamp startedAt. Per §6c the row stays `queued` until `synthesizing`.
    await boundary("markStarted");
    const request = await DBOS.runStep<RenderRequest>(
      async () => {
        const row = await prisma.renderJob.findUnique({
          where: { id: renderJobId },
          include: { project: true, version: true },
        });
        const parsed = parseRenderRequest(row);
        await markRenderStarted(prisma, renderJobId);
        return parsed;
      },
      {
        name: "markStarted",
        ...RENDER_NETWORK_RETRY,
        shouldRetry: retryUnlessPermanentRender,
      },
    );

    // 2) loadCredentials — design names this "decrypt the provider credentials needed for
    //    audio synthesis". We deliberately VERIFY rather than return plaintext: a step's
    //    return value is checkpointed, so returning a decrypted API key would persist a
    //    secret in the system database. The key is re-loaded inside the synthesis call
    //    instead (the discipline every generation workflow follows). Absence is NOT fatal
    //    — a manifest with cached audio refs needs no provider at all — so this records a
    //    boolean the audio planner branches on.
    await boundary("loadCredentials");
    const { hasOpenRouterConnection, installationId } = await DBOS.runStep<{
      hasOpenRouterConnection: boolean;
      installationId: string;
    }>(
      async () => {
        const project = await prisma.project.findUnique({
          where: { id: request.projectId },
          select: { ownerId: true },
        });
        if (!project) {
          throw new RenderRequestInvalidError(`no Project ${request.projectId}`);
        }
        const connection = await prisma.githubConnection.findUnique({
          where: { userId: project.ownerId },
        });
        if (!connection?.installationId) {
          throw new RenderRequestInvalidError(
            `project owner ${project.ownerId} has no GitHub installation — cannot clone`,
          );
        }
        const cfg = getProviderConfig();
        let connected = true;
        try {
          await loadOpenRouterCredential({
            prisma,
            userId: request.userId,
            encryptionKey: cfg.secretsEncryptionKey,
          });
        } catch {
          connected = false;
        }
        return {
          hasOpenRouterConnection: connected,
          installationId: connection.installationId,
        };
      },
      {
        name: "loadCredentials",
        ...RENDER_NETWORK_RETRY,
        shouldRetry: retryUnlessPermanentRender,
      },
    );

    // 3) mintInstallationToken — App JWT → ~1h installation token (never persisted beyond
    //    this workflow's checkpoint). §7: "every git-ops workflow AND renderWorkflow's
    //    clone starts with mintInstallationToken".
    await boundary("mintInstallationToken");
    const scaffoldCfg = getScaffoldConfig();
    // PLAN ROW 48: SEALED, for the same reason as the four git-ops workflows — a step's
    // return value is what DBOS checkpoints. This is render's ONLY mint step (the plan
    // row's list and the old scaffold comment both got that wrong — brief §9 S7), and its
    // position in `RENDER_STEP_SEQUENCE` is untouched.
    const sealedToken = await DBOS.runStep<string>(
      async () => {
        return await mintEncryptedInstallationToken({
          appId: scaffoldCfg.githubAppId,
          privateKey: scaffoldCfg.githubAppPrivateKey,
          installationId,
          apiBaseUrl: scaffoldCfg.githubApiBaseUrl,
        });
      },
      { name: "mintInstallationToken", ...RENDER_NETWORK_RETRY },
    );
    const token = openInstallationToken(sealedToken);

    const cloneUrl = authenticatedCloneUrl(
      scaffoldCfg.githubGitBaseUrl,
      request.repoOwner,
      request.repoName,
      token,
    );

    // 4) cloneAtVersion — shallow clone of the version branch into the ephemeral workspace.
    await boundary("cloneAtVersion");
    await DBOS.runStep(
      async () => {
        const ws = renderWorkspace(renderJobId);
        await ensureClone(ws, cloneUrl, request.branchName);
      },
      {
        name: "cloneAtVersion",
        ...RENDER_NETWORK_RETRY,
        shouldRetry: retryUnlessPermanentRender,
      },
    );

    // 5) readManifest — the manifest MUST be a checkpointed step output: the workflow
    //    branches on it (which audio to synthesize, which assets to download), and
    //    re-reading it from an ephemeral workspace on replay could take a different branch.
    await boundary("readManifest");
    const manifest = await DBOS.runStep<ProjectManifest>(
      async () => readWorkspaceManifest(renderWorkspace(renderJobId)),
      { name: "readManifest", shouldRetry: retryUnlessPermanentRender },
    );

    const ctx: RenderContext = { request, cloneUrl, manifest };

    // 6) installDependencies — `npm ci --ignore-scripts` (or `npm install --ignore-scripts`
    //    when the project ships no lockfile) in a SCRUBBED-ENV child. Retryable: the
    //    registry is a network dependency.
    await boundary("installDependencies");
    await DBOS.runStep(
      async () => {
        const ws = await ensureClonedWorkspace(ctx);
        const cfg = getRenderConfig();
        await ensureDependencies(ws, cfg.installTimeoutMs);
      },
      {
        name: "installDependencies",
        ...RENDER_NETWORK_RETRY,
        shouldRetry: retryUnlessPermanentRender,
      },
    );

    // 7) downloadSceneAssets — S3 → `<workspace>/public/<assetKey>` (plan D1). Real bytes
    //    on local disk, because our buckets are private and because `bundle()` snapshots
    //    `public/` into the bundle.
    await boundary("downloadSceneAssets");
    await DBOS.runStep<string[]>(
      async () => {
        const ws = await ensureClonedWorkspace(ctx);
        return ensureSceneAssets(ws, manifest);
      },
      {
        name: "downloadSceneAssets",
        ...RENDER_NETWORK_RETRY,
        shouldRetry: retryUnlessPermanentRender,
      },
    );

    // 8/9) ensureNarrationAudio / ensureMusicAudio — BEFORE bundling. Synthesize only if
    //      the manifest lacks a cached ref (and a fallback model + connection exist);
    //      otherwise the cached object was already materialized in step 7.
    const renderCfg = getRenderConfig();
    await boundary("ensureNarrationAudio");
    const narrationPlan = await DBOS.runStep<AudioPlan>(
      async () => {
        await setRenderStatus(prisma, renderJobId, "synthesizing");
        const plan = planAudioTrack({
          kind: "narration",
          manifest,
          modelId: renderCfg.narrationModel,
          hasOpenRouterConnection,
        });
        const ws = await ensureClonedWorkspace(ctx);
        // The ENRICHED plan is what gets checkpointed — the measured clip lengths ride
        // back out with it and are what `applyAudioPlans` writes onto the manifest.
        return await ensureAudioOnDisk(ws, request, plan);
      },
      {
        name: "ensureNarrationAudio",
        ...RENDER_NETWORK_RETRY,
        shouldRetry: retryUnlessPermanentRender,
      },
    );

    await boundary("ensureMusicAudio");
    const musicPlan = await DBOS.runStep<AudioPlan>(
      async () => {
        const plan = planAudioTrack({
          kind: "music",
          manifest,
          modelId: renderCfg.musicModel,
          hasOpenRouterConnection,
        });
        const ws = await ensureClonedWorkspace(ctx);
        return await ensureAudioOnDisk(ws, request, plan);
      },
      {
        name: "ensureMusicAudio",
        ...RENDER_NETWORK_RETRY,
        shouldRetry: retryUnlessPermanentRender,
      },
    );

    ctx.audioPlans = { narration: narrationPlan, music: musicPlan };
    const renderManifest = applyAudioPlans(manifest, ctx.audioPlans);

    // 10) materializeRenderSources — regenerate the manifest-derived Remotion sources (plus
    //     the static asset resolver) from the AUDIO-PATCHED manifest, so a freshly
    //     synthesized track is actually referenced by the composition. A no-op for any
    //     project whose last commit went through commitVersionWorkflow (plan D2).
    await boundary("materializeRenderSources");
    await DBOS.runStep(
      async () => {
        const ws = await ensureClonedWorkspace(ctx);
        await materializeRenderSources(ws, renderManifest);
        await ensureOutDir(ws);
      },
      { name: "materializeRenderSources", shouldRetry: retryUnlessPermanentRender },
    );

    // 11) bundleComposition — @remotion/bundler in a SCRUBBED-ENV child; also resolves the
    //     composition so `framesTotal` is a verified value rather than a guess.
    await boundary("bundleComposition");
    const composition = await DBOS.runStep<ResolvedComposition>(
      async () => {
        await setRenderStatus(prisma, renderJobId, "bundling");
        const ws = await ensureWorkspaceSources(ctx);
        const resolved = await bundleInChild(ws, renderJobId);
        const withSpec = applyOutputSpec(resolved, request.outputSpec);
        await setRenderFramesTotal(prisma, renderJobId, withSpec.durationInFrames);
        return withSpec;
      },
      { name: "bundleComposition", shouldRetry: retryUnlessPermanentRender },
    );
    ctx.composition = composition;

    // 12) renderMedia — ONE long step. NOT retried automatically: an hour-long encode that
    //     died should not silently burn three more hours; DBOS workflow RECOVERY is the
    //     retry mechanism, under an operator's control. The child's onProgress stream is
    //     relayed to a throttled, monotonic `framesDone` write.
    await boundary("renderMedia");
    const rendered = await DBOS.runStep<{ framesRendered: number }>(
      async () => {
        await setRenderStatus(prisma, renderJobId, "encoding");
        const ws = await ensureBundledWorkspace(ctx);
        const framesRendered = await renderInChild(ctx, ws, composition);
        return { framesRendered };
      },
      { name: "renderMedia", retriesAllowed: false },
    );

    // 13) generateThumbnail — a still from the middle of the composition, same bundle,
    //     same scrubbed-child mechanism.
    await boundary("generateThumbnail");
    await DBOS.runStep(
      async () => {
        const ws = await ensureBundledWorkspace(ctx);
        await stillInChild(ctx, ws, composition);
      },
      { name: "generateThumbnail", shouldRetry: retryUnlessPermanentRender },
    );

    // 14) uploadOutputs — mp4 + thumbnail to the SHARED db-lib key layout. The bytes stay
    //     in step-local memory and are never checkpointed (the image/audio/video
    //     precedent); the keys are deterministic, so a retried PUT overwrites the same
    //     objects and is idempotent.
    const outputAssetKey = buildRenderOutputKey(renderJobId);
    const thumbnailAssetKey = buildRenderThumbnailKey(renderJobId);
    await boundary("uploadOutputs");
    await DBOS.runStep(
      async () => {
        await setRenderStatus(prisma, renderJobId, "uploading");
        // Level 4 self-heal: renderMedia/generateThumbnail are memoized, so a crash
        // between them and this step leaves nothing on disk to upload — re-render.
        const ws = await ensureRenderedOutputs(ctx);
        const { video, thumbnail } = await readRenderOutputs(ws);
        const { client, bucket } = getS3Config();
        await uploadAsset(client, {
          bucket,
          key: outputAssetKey,
          bytes: video,
          contentType: "video/mp4",
        });
        await uploadAsset(client, {
          bucket,
          key: thumbnailAssetKey,
          bytes: thumbnail,
          contentType: "image/jpeg",
        });
      },
      {
        name: "uploadOutputs",
        ...RENDER_NETWORK_RETRY,
        shouldRetry: retryUnlessPermanentRender,
      },
    );

    // 15) markCompleted — terminal success + workspace cleanup.
    await boundary("markCompleted");
    await DBOS.runStep(
      async () => {
        await markRenderCompleted(prisma, renderJobId, {
          outputAssetKey,
          thumbnailAssetKey,
          framesTotal: composition.durationInFrames,
        });
        await removeWorkspace(renderWorkspace(renderJobId));
      },
      { name: "markCompleted", retriesAllowed: true, maxAttempts: 3 },
    );

    return {
      renderJobId,
      outputAssetKey,
      thumbnailAssetKey,
      framesTotal: rendered.framesRendered,
      audio: {
        narration: audioPlanOutcome(narrationPlan),
        music: audioPlanOutcome(musicPlan),
      },
    };
  } catch (err) {
    // CANCELLATION is checked FIRST and is its own axis: not a failure, and not retryable.
    // Once DBOS has marked the workflow CANCELLED no further `DBOS.runStep` may execute,
    // so this write is a DIRECT (non-checkpointed) Prisma call. It is conditional on the
    // row not already being terminal, so it is idempotent and loses a race against a
    // completion — and it is safe for the render API's cancel endpoint (task 37) to make
    // the same write.
    if (isRenderCancellation(err)) {
      await markRenderCanceled(prisma, renderJobId).catch(() => {});
      await removeWorkspace(renderWorkspace(renderJobId)).catch(() => {});
      throw err;
    }
    if (isPermanentRenderFailure(err)) {
      await DBOS.runStep(
        async () => {
          await markRenderFailed(prisma, renderJobId, (err as Error).message);
          await removeWorkspace(renderWorkspace(renderJobId));
        },
        { name: "recordFailure", retriesAllowed: true, maxAttempts: 3 },
      );
    }
    throw err;
  }
}

export const renderWorkflow = DBOS.registerWorkflow(renderFn, {
  name: RENDER_WORKFLOW_NAME,
});
