import { DBOS } from "@dbos-inc/dbos-sdk";
import { buildAssetKey, type GenerateVideoPayload } from "@supagloo/database-lib";
import { WORKFLOW_NAMES } from "../dbos/registry";
import { getAppDb } from "../db/app-db";
import { getProviderConfig } from "../providers/config";
import { loadOpenRouterCredential } from "../providers/credentials";
import {
  downloadBytes,
  getVideoJob,
  submitVideoJob,
} from "../providers/media-client";
import { MEDIA_RETRY, DISCOVERY_RETRY } from "../providers/errors";
import { getS3Config } from "../files/s3-config";
import { uploadAsset } from "../files/s3-client";
import {
  GenerationRequestInvalidError,
  VideoJobFailedError,
  isPermanentGenerationFailure,
  retryUnlessPermanentGeneration,
} from "./generate-video/errors";
import { parseVideoRequest, type VideoRequest } from "./generate-video/request";
import { buildVideoSubmitInput } from "./generate-video/submit";
import { pollUntilComplete } from "./generate-video/poll";
import { getVideoPollConfig } from "./generate-video/config";
import {
  markVideoGenerationFailed,
  markVideoGenerationRunning,
  persistVideoProviderJobId,
  persistVideoResult,
} from "./generate-video/finalize";

/**
 * `generateVideoClipWorkflow` (queue `ai-generation`) — the async video-job workflow
 * (design-delta §7 workflow 8) and the FIRST durable-sleep / bounded-poll / crash-replay media
 * workflow in the codebase. `video` is openrouter-only (§9-Q2). NO repair loop (video output is
 * opaque bytes, not schema-validated JSON).
 *
 * Steps: loadRequestAndCredentials → submitVideoJob → pollVideoJob (durable-sleep loop) →
 * downloadAndUploadVideo → persistResult. It ONLY writes the `AiGeneration` row (status +
 * providerJobId + resultAssetKey + resultJson) — never `ProjectVersion` or the manifest.
 *
 * REPLAY SAFETY (the flagship recovery case, design §2.8): the `submitVideoJob` step persists
 * `providerJobId` in the SAME step as the HTTP submit, and DBOS memoizes a completed step — so on
 * crash/replay the submit is NOT re-issued (the provider `videoJobsCreated` counter stays 1). The
 * `Idempotency-Key: genId` header on the submit is defense-in-depth for the crash-MID-step case
 * (worker dies after the POST but before the step checkpoint commits ⇒ replay re-submits, but the
 * provider returns the SAME job id). Both together = exactly-once submit.
 *
 * SECRET HANDLING: `loadRequestAndCredentials` verifies the OpenRouter connection exists but
 * returns NO plaintext; the key is (re)loaded INSIDE each provider-call step so it never lands in
 * a DBOS checkpoint (same discipline as generateImage/generateAudio).
 *
 * WHY downloadVideoContent + uploadAssetToS3 are ONE DBOS step (design names them separately):
 * a step return is CHECKPOINTED, and MP4 bytes (a Buffer JSON-serializes ~10x) must never enter
 * the system DB; a temp-file handoff between two checkpointed steps is not crash-safe. Folding
 * keeps the bytes in step-local memory and makes download→upload atomically retryable against the
 * deterministic idempotent key (`buildAssetKey(projectId, genId)`; re-PUT overwrites). The image /
 * audio precedent. Registered STATICALLY at module load.
 */

export const GENERATE_VIDEO_WORKFLOW_NAME = WORKFLOW_NAMES.generateVideo;

// Re-exported so importers of this module (e.g. the e2e) keep importing the enqueue payload type
// from here (parity with generate-image/generate-audio).
export type { GenerateVideoPayload };

export interface GenerateVideoResult {
  generationId: string;
  assetKey: string;
  providerJobId: string;
}

/**
 * TEST-ONLY DI seam (undefined in production ⇒ a pure no-op). The workflow awaits this hook at
 * each phase BOUNDARY so a test can park the workflow and drive a crash/replay — the flagship #34
 * case parks at the FIRST `"pollVideoJob"` label (after submit committed `providerJobId`, before
 * polling reaches `completed`). Reading a module-level ref is a DI read, not workflow state; the
 * hook never changes which steps run, so determinism is preserved.
 */
export type BoundaryHook = (label: string) => void | Promise<void>;
let boundaryHook: BoundaryHook | undefined;
export function __setGenerateVideoBoundaryHook(
  hook: BoundaryHook | undefined,
): void {
  boundaryHook = hook;
}
async function boundary(label: string): Promise<void> {
  if (boundaryHook) await boundaryHook(label);
}

async function generateVideoFn(
  payload: GenerateVideoPayload,
): Promise<GenerateVideoResult> {
  const genId = DBOS.workflowID ?? payload.generationId;
  if (!genId) {
    throw new Error("generateVideo: DBOS.workflowID unavailable inside the workflow");
  }
  const prisma = getAppDb();

  try {
    // 1) loadRequestAndCredentials — load the row, validate kind/provider/project/input, verify
    //    the OpenRouter connection EXISTS (fail fast, no secret returned), flip queued → running.
    await boundary("loadRequestAndCredentials");
    const request = await DBOS.runStep<VideoRequest>(
      async () => {
        const row = await prisma.aiGeneration.findUnique({ where: { id: genId } });
        if (!row) {
          throw new GenerationRequestInvalidError(`no AiGeneration row for id ${genId}`);
        }
        const req = parseVideoRequest(row);
        const cfg = getProviderConfig();
        await loadOpenRouterCredential({
          prisma,
          userId: req.userId,
          encryptionKey: cfg.secretsEncryptionKey,
        });
        await markVideoGenerationRunning(prisma, genId);
        return req;
      },
      {
        name: "loadRequestAndCredentials",
        ...DISCOVERY_RETRY,
        shouldRetry: retryUnlessPermanentGeneration,
      },
    );

    // 2) submitVideoJob — reload the key INSIDE the step, POST the async job, and persist the
    //    returned providerJobId in the SAME step (design §2.8 / D1 replay-safety crux). Returns
    //    only the checkpoint-safe { providerJobId, pollingUrl } (pollingUrl is a content URL, not
    //    a secret). The genId is the Idempotency-Key so a replayed submit returns the same job.
    await boundary("submitVideoJob");
    const { providerJobId, pollingUrl } = await DBOS.runStep<{
      providerJobId: string;
      pollingUrl: string;
    }>(
      async () => {
        const cfg = getProviderConfig();
        const cred = await loadOpenRouterCredential({
          prisma,
          userId: request.userId,
          encryptionKey: cfg.secretsEncryptionKey,
        });
        const job = await submitVideoJob(
          { openrouterBaseUrl: cfg.openrouterBaseUrl, apiKey: cred.apiKey },
          {
            modelId: request.model,
            input: buildVideoSubmitInput(request),
            idempotencyKey: genId,
          },
        );
        await persistVideoProviderJobId(prisma, genId, job.id);
        return { providerJobId: job.id, pollingUrl: job.pollingUrl };
      },
      { name: "submitVideoJob", ...MEDIA_RETRY, shouldRetry: retryUnlessPermanentGeneration },
    );

    // 3) pollVideoJob — bounded loop with durable ~30s sleeps between GET {polling_url} calls,
    //    through pending → in_progress → completed. Each poll is its own DBOS step (reloads the
    //    key inside); the loop + sleeps run in the workflow body (deterministic — driven by the
    //    checkpointed poll results). The boundary hook fires before every poll (crash/replay
    //    parks here). Throws VideoJobFailedError / VideoJobTimedOutError (both permanent).
    const { pollIntervalMs, maxPollAttempts } = getVideoPollConfig();
    await pollUntilComplete({
      jobId: providerJobId,
      intervalMs: pollIntervalMs,
      maxAttempts: maxPollAttempts,
      onBeforePoll: () => boundary("pollVideoJob"),
      sleep: (ms) => DBOS.sleep(ms),
      poll: () =>
        DBOS.runStep<string>(
          async () => {
            const cfg = getProviderConfig();
            const cred = await loadOpenRouterCredential({
              prisma,
              userId: request.userId,
              encryptionKey: cfg.secretsEncryptionKey,
            });
            const status = await getVideoJob(
              { openrouterBaseUrl: cfg.openrouterBaseUrl, apiKey: cred.apiKey },
              pollingUrl,
            );
            return status.status;
          },
          {
            name: "pollVideoJob",
            ...MEDIA_RETRY,
            shouldRetry: retryUnlessPermanentGeneration,
          },
        ),
    });

    // 4) downloadAndUploadVideo (folds downloadVideoContent + uploadAssetToS3) — resolve the
    //    completion content URL, download the bytes, PUT to the deterministic idempotent key. The
    //    bytes stay in step-local memory (never checkpointed).
    const assetKey = buildAssetKey(request.projectId, genId);
    await boundary("downloadAndUploadVideo");
    await DBOS.runStep(
      async () => {
        const cfg = getProviderConfig();
        const cred = await loadOpenRouterCredential({
          prisma,
          userId: request.userId,
          encryptionKey: cfg.secretsEncryptionKey,
        });
        const mediaCfg = {
          openrouterBaseUrl: cfg.openrouterBaseUrl,
          apiKey: cred.apiKey,
        };
        // The completed job's content URLs live in the poll body (`unsigned_urls`) — there is no
        // separate JSON content-listing endpoint. Re-read the (now completed) job to get them.
        const { unsignedUrls } = await getVideoJob(mediaCfg, pollingUrl);
        const url = unsignedUrls[0];
        if (!url) {
          // A completed job with no content URL is a malformed provider response — treat as
          // transient (502) so MEDIA_RETRY re-tries rather than failing the generation hard.
          throw new VideoJobFailedError(providerJobId, "completed-without-content-url");
        }
        // The content URL points back at the OpenRouter API and REQUIRES the bearer (downloadBytes
        // sends auth).
        const bytes = await downloadBytes(mediaCfg, url);
        const { client, bucket } = getS3Config();
        await uploadAsset(client, {
          bucket,
          key: assetKey,
          bytes,
          contentType: "video/mp4",
        });
      },
      {
        name: "downloadAndUploadVideo",
        ...MEDIA_RETRY,
        shouldRetry: retryUnlessPermanentGeneration,
      },
    );

    // 5) persistResult — idempotent success upsert (status succeeded + resultAssetKey + resultJson
    //    metadata + completedAt).
    await boundary("persistResult");
    await DBOS.runStep(
      async () => {
        await persistVideoResult(prisma, genId, { assetKey, providerJobId });
      },
      { name: "persistResult", retriesAllowed: true, maxAttempts: 3 },
    );

    return { generationId: genId, assetKey, providerJobId };
  } catch (err) {
    // Mark failed ONLY on a permanent typed failure (bad request row, terminal job failure, poll
    // timeout, permanent 4xx, not connected) — transient failures and DBOS cancellation propagate
    // for retry/recovery.
    if (isPermanentGenerationFailure(err)) {
      await DBOS.runStep(
        async () => {
          await markVideoGenerationFailed(prisma, genId, (err as Error).message);
        },
        { name: "recordFailure", retriesAllowed: true, maxAttempts: 3 },
      );
    }
    throw err;
  }
}

export const generateVideoWorkflow = DBOS.registerWorkflow(generateVideoFn, {
  name: GENERATE_VIDEO_WORKFLOW_NAME,
});
