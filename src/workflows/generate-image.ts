import { DBOS } from "@dbos-inc/dbos-sdk";
import { buildAssetKey, type GenerateImagePayload } from "@supagloo/database-lib";
import { WORKFLOW_NAMES } from "../dbos/registry";
import { getAppDb } from "../db/app-db";
import { getProviderConfig } from "../providers/config";
import {
  loadGlooCredential,
  loadOpenRouterCredential,
} from "../providers/credentials";
import { mintGlooToken } from "../providers/gloo";
import { requestGlooImage } from "../providers/gloo-image";
import { requestImage } from "../providers/media-client";
import { MEDIA_RETRY, DISCOVERY_RETRY } from "../providers/errors";
import { getS3Config } from "../files/s3-config";
import { uploadAsset } from "../files/s3-client";
import {
  GenerationRequestInvalidError,
  isPermanentGenerationFailure,
  retryUnlessPermanentGeneration,
} from "./generate-image/errors";
import { parseImageRequest, type ImageRequest } from "./generate-image/request";
import {
  markImageGenerationFailed,
  markImageGenerationRunning,
  persistImageResult,
} from "./generate-image/finalize";

/**
 * `generateImageWorkflow` (queue `ai-generation`) — the FIRST media-generation workflow and
 * the FIRST real S3 WRITE in the codebase. Design-delta §7 workflow 6. NO repair loop
 * (image output is opaque bytes, not schema-validated JSON — nothing to re-prompt on).
 *
 * -- TWO providers as of 2026-07-28 (genesis-1 Inspector, D1) ------------------------
 * This workflow used to be openrouter-only on the authority of §9-Q2's "Gloo has no media
 * modalities". That is false for images: Gloo carries 11 image-capable models and a real
 * PNG was generated from one. They are simply not reachable through chat/completions --
 * that surface answers 400 with "Use the POST /v2/responses endpoint instead", which is
 * why the capability went unnoticed. The two paths differ in credential (a long-lived
 * OpenRouter key vs a per-attempt minted Gloo bearer), endpoint, request shape and
 * response shape, so they are two branches rather than one parameterised call.
 * `narration`/`music`/`video` remain openrouter-only, and correctly so -- those Gloo
 * routes answer 404 (absent), not 405.
 *
 * Steps: loadRequestAndCredentials → callImageModel (MEDIA_RETRY: maxAttempts 4 + backoff,
 * 4xx fail-fast; folds the design's `callImageModel` + `fetchAssetBytes` + `uploadAssetToS3`
 * into ONE step) → persistResult. It ONLY writes the `AiGeneration` row (status +
 * resultAssetKey) — never `ProjectVersion` or the manifest.
 *
 * SECRET HANDLING: `loadRequestAndCredentials` verifies the relevant connection exists but
 * returns NO plaintext; the credential is (re)loaded INSIDE `callImageModel` so it never
 * lands in a DBOS checkpoint (same discipline as generateScript). The Gloo bearer is minted
 * fresh inside each step attempt and never cached -- also generateScript's shape.
 *
 * WHY callImageModel + upload are ONE DBOS step: on real OpenRouter the image is returned
 * INLINE as a base64 data URI in the chat-completions response (`modalities:["image"]`) — there
 * is no separate content URL to fetch — so `requestImage` yields the bytes directly. Those bytes
 * (MBs) must NEVER enter a DBOS checkpoint (a step return is checkpointed, and a Buffer
 * JSON-serializes ~10x), so we upload them WITHIN the same step: the bytes stay in step-local
 * memory and the generate→upload is atomically retryable against the deterministic idempotent
 * key (`buildAssetKey(projectId, genId)`; re-PUT overwrites). The audio (#33) / video (#34)
 * precedent. Registered STATICALLY at module load.
 */

export const GENERATE_IMAGE_WORKFLOW_NAME = WORKFLOW_NAMES.generateImage;

// Re-exported so importers of this module (e.g. the e2e) keep importing the enqueue payload
// type from here (parity with generate-script).
export type { GenerateImagePayload };

export interface GenerateImageResult {
  generationId: string;
  assetKey: string;
}

/**
 * TEST-ONLY DI seam (undefined in production ⇒ a pure no-op). The workflow awaits this hook at
 * each step BOUNDARY so a test can park the workflow and drive a crash/replay. Reading a
 * module-level ref (never mutating one) is a DI read, not workflow state; the hook never
 * changes which steps run, so determinism is preserved.
 */
export type BoundaryHook = (label: string) => void | Promise<void>;
let boundaryHook: BoundaryHook | undefined;
export function __setGenerateImageBoundaryHook(
  hook: BoundaryHook | undefined,
): void {
  boundaryHook = hook;
}
async function boundary(label: string): Promise<void> {
  if (boundaryHook) await boundaryHook(label);
}

async function generateImageFn(
  payload: GenerateImagePayload,
): Promise<GenerateImageResult> {
  const genId = DBOS.workflowID ?? payload.generationId;
  if (!genId) {
    throw new Error("generateImage: DBOS.workflowID unavailable inside the workflow");
  }
  const prisma = getAppDb();

  try {
    // 1) loadRequestAndCredentials — load the row, validate kind/project/input, verify the
    //    OpenRouter connection EXISTS (fail fast, no secret returned), flip queued → running.
    await boundary("loadRequestAndCredentials");
    const request = await DBOS.runStep<ImageRequest>(
      async () => {
        const row = await prisma.aiGeneration.findUnique({ where: { id: genId } });
        if (!row) {
          throw new GenerationRequestInvalidError(`no AiGeneration row for id ${genId}`);
        }
        const req = parseImageRequest(row);
        // Verify the relevant connection exists WITHOUT returning the plaintext secret.
        // WHICH one depends on the row's provider -- checking the wrong one would let a
        // Gloo generation reach the provider call before failing, wasting the step.
        const cfg = getProviderConfig();
        if (req.provider === "gloo") {
          await loadGlooCredential({
            prisma,
            userId: req.userId,
            encryptionKey: cfg.secretsEncryptionKey,
          });
        } else {
          await loadOpenRouterCredential({
            prisma,
            userId: req.userId,
            encryptionKey: cfg.secretsEncryptionKey,
          });
        }
        await markImageGenerationRunning(prisma, genId);
        return req;
      },
      {
        name: "loadRequestAndCredentials",
        ...DISCOVERY_RETRY,
        shouldRetry: retryUnlessPermanentGeneration,
      },
    );

    // 2) callImageModel (folds fetchAssetBytes + uploadAssetToS3) — reload the key INSIDE the
    //    step (never checkpointed), call the image model, and PUT the bytes to S3. On real
    //    OpenRouter the image arrives INLINE as a base64 data URI in the chat-completions
    //    response (there is no separate URL to fetch), so download+upload collapse into this
    //    one step; the bytes stay in step-local memory and never enter a DBOS checkpoint. The
    //    step keeps the name "callImageModel" (the e2e counts its single execution).
    const assetKey = buildAssetKey(request.projectId, genId);
    await boundary("callImageModel");
    await DBOS.runStep(
      async () => {
        const cfg = getProviderConfig();
        const { bytes, contentType } =
          request.provider === "gloo"
            ? await (async () => {
                const cred = await loadGlooCredential({
                  prisma,
                  userId: request.userId,
                  encryptionKey: cfg.secretsEncryptionKey,
                });
                // Minted per attempt, inside the step -- never cached, never checkpointed.
                const token = await mintGlooToken({
                  glooBaseUrl: cfg.glooBaseUrl,
                  clientId: cred.clientId,
                  clientSecret: cred.clientSecret,
                });
                return requestGlooImage(
                  { glooBaseUrl: cfg.glooBaseUrl, accessToken: token.accessToken },
                  {
                    modelId: request.model,
                    prompt: request.prompt,
                    // Faith alignment applies on the image surface too: the same request
                    // with `tradition` set still returned a valid PNG, input tokens
                    // rising 1042 -> 14917. Absent unless the user chose one.
                    ...(request.tradition ? { tradition: request.tradition } : {}),
                  },
                );
              })()
            : await (async () => {
                const cred = await loadOpenRouterCredential({
                  prisma,
                  userId: request.userId,
                  encryptionKey: cfg.secretsEncryptionKey,
                });
                return requestImage(
                  { openrouterBaseUrl: cfg.openrouterBaseUrl, apiKey: cred.apiKey },
                  { modelId: request.model, prompt: request.prompt },
                );
              })();
        const { client, bucket } = getS3Config();
        await uploadAsset(client, {
          bucket,
          key: assetKey,
          bytes,
          contentType: contentType || "application/octet-stream",
        });
      },
      { name: "callImageModel", ...MEDIA_RETRY, shouldRetry: retryUnlessPermanentGeneration },
    );

    // 4) persistResult — idempotent success upsert (status succeeded + resultAssetKey + completedAt).
    await boundary("persistResult");
    await DBOS.runStep(
      async () => {
        await persistImageResult(prisma, genId, { assetKey });
      },
      { name: "persistResult", retriesAllowed: true, maxAttempts: 3 },
    );

    return { generationId: genId, assetKey };
  } catch (err) {
    // Mark failed ONLY on a permanent typed failure (bad request row, not connected,
    // permanent 4xx) — transient failures and DBOS cancellation propagate for retry/recovery.
    if (isPermanentGenerationFailure(err)) {
      await DBOS.runStep(
        async () => {
          await markImageGenerationFailed(prisma, genId, (err as Error).message);
        },
        { name: "recordFailure", retriesAllowed: true, maxAttempts: 3 },
      );
    }
    throw err;
  }
}

export const generateImageWorkflow = DBOS.registerWorkflow(generateImageFn, {
  name: GENERATE_IMAGE_WORKFLOW_NAME,
});
