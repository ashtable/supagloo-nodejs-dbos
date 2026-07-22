import { DBOS } from "@dbos-inc/dbos-sdk";
import { buildAssetKey, type GenerateAudioPayload } from "@supagloo/database-lib";
import { WORKFLOW_NAMES } from "../dbos/registry";
import { getAppDb } from "../db/app-db";
import { getProviderConfig } from "../providers/config";
import { loadOpenRouterCredential } from "../providers/credentials";
import { requestSpeech } from "../providers/media-client";
import { MEDIA_RETRY, DISCOVERY_RETRY } from "../providers/errors";
import { getS3Config } from "../files/s3-config";
import { uploadAsset } from "../files/s3-client";
import {
  GenerationRequestInvalidError,
  isPermanentGenerationFailure,
  retryUnlessPermanentGeneration,
} from "./generate-audio/errors";
import { parseAudioRequest, type AudioRequest } from "./generate-audio/request";
import { buildSpeechArgs } from "./generate-audio/synthesize";
import {
  markAudioGenerationFailed,
  markAudioGenerationRunning,
  persistAudioResult,
} from "./generate-audio/finalize";

/**
 * `generateAudioWorkflow` (queue `ai-generation`) — the audio-generation workflow covering
 * BOTH audio kinds (design-delta §7 workflow 7): `narration` (TTS) and `music`, dispatched by
 * the row's `kind` (the generateScript storyboard/script precedent). Both are openrouter-only
 * (§9-Q2). NO repair loop (audio output is opaque bytes, not schema-validated JSON).
 *
 * Steps: loadRequestAndCredentials → synthesizeAndUploadAudio (MEDIA_RETRY) → persistResult.
 * It ONLY writes the `AiGeneration` row (status + resultAssetKey + a small resultJson metadata
 * blob) — never `ProjectVersion` or the manifest.
 *
 * SECRET HANDLING: `loadRequestAndCredentials` verifies the OpenRouter connection exists but
 * returns NO plaintext; the key is (re)loaded INSIDE `synthesizeAndUploadAudio` so it never
 * lands in a DBOS checkpoint (same discipline as generateScript/generateImage).
 *
 * WHY callSpeechEndpoint + uploadAssetToS3 are ONE DBOS step (design §7 names them as two —
 * decision D1): a step's return value is CHECKPOINTED, and `requestSpeech` returns the audio
 * BYTES directly (a Buffer JSON-serializes to `{type:"Buffer",data:[...]}`, ~10x bloat) — so a
 * standalone callSpeech step would checkpoint the audio. Folding keeps the bytes in step-local
 * memory and makes synth→upload atomically retryable against the deterministic idempotent key
 * (`buildAssetKey(projectId, genId)`; re-PUT overwrites). The step returns only the small,
 * checkpoint-safe `{ providerGenerationId }` (the provider's X-Generation-Id header — decision
 * D6, persisted in resultJson for traceability). This mirrors the task-32 image precedent
 * (there callImageModel returned a URL; here requestSpeech returns bytes, so the fold is even
 * more clear-cut). Registered STATICALLY at module load.
 */

export const GENERATE_AUDIO_WORKFLOW_NAME = WORKFLOW_NAMES.generateAudio;

// Re-exported so importers of this module (e.g. the e2e) keep importing the enqueue payload
// type from here (parity with generate-script/generate-image).
export type { GenerateAudioPayload };

export interface GenerateAudioResult {
  generationId: string;
  assetKey: string;
  kind: "narration" | "music";
}

async function generateAudioFn(
  payload: GenerateAudioPayload,
): Promise<GenerateAudioResult> {
  const genId = DBOS.workflowID ?? payload.generationId;
  if (!genId) {
    throw new Error("generateAudio: DBOS.workflowID unavailable inside the workflow");
  }
  const prisma = getAppDb();

  try {
    // 1) loadRequestAndCredentials — load the row, validate kind/project/input (per-kind
    //    schema), verify the OpenRouter connection EXISTS (fail fast, no secret returned),
    //    flip queued → running.
    const request = await DBOS.runStep<AudioRequest>(
      async () => {
        const row = await prisma.aiGeneration.findUnique({ where: { id: genId } });
        if (!row) {
          throw new GenerationRequestInvalidError(`no AiGeneration row for id ${genId}`);
        }
        const req = parseAudioRequest(row);
        // Verify the OpenRouter connection exists WITHOUT returning the plaintext secret.
        const cfg = getProviderConfig();
        await loadOpenRouterCredential({
          prisma,
          userId: req.userId,
          encryptionKey: cfg.secretsEncryptionKey,
        });
        await markAudioGenerationRunning(prisma, genId);
        return req;
      },
      {
        name: "loadRequestAndCredentials",
        ...DISCOVERY_RETRY,
        shouldRetry: retryUnlessPermanentGeneration,
      },
    );

    // 2) synthesizeAndUploadAudio (folds callSpeechEndpoint + uploadAssetToS3) — reload the
    //    key INSIDE the step (never checkpointed), call the speech endpoint (raw mp3 byte
    //    stream), PUT the bytes to the deterministic idempotent key. The bytes stay in
    //    step-local memory; only the small { providerGenerationId } is returned/checkpointed.
    const assetKey = buildAssetKey(request.projectId, genId);
    const { providerGenerationId } = await DBOS.runStep<{
      providerGenerationId: string | null;
    }>(
      async () => {
        const cfg = getProviderConfig();
        const cred = await loadOpenRouterCredential({
          prisma,
          userId: request.userId,
          encryptionKey: cfg.secretsEncryptionKey,
        });
        const speech = await requestSpeech(
          { openrouterBaseUrl: cfg.openrouterBaseUrl, apiKey: cred.apiKey },
          buildSpeechArgs(request),
        );
        const { client, bucket } = getS3Config();
        await uploadAsset(client, {
          bucket,
          key: assetKey,
          bytes: speech.bytes,
          contentType: speech.contentType ?? "audio/mpeg",
        });
        return { providerGenerationId: speech.generationId };
      },
      {
        name: "synthesizeAndUploadAudio",
        ...MEDIA_RETRY,
        shouldRetry: retryUnlessPermanentGeneration,
      },
    );

    // 3) persistResult — idempotent success upsert (status succeeded + resultAssetKey +
    //    resultJson metadata + completedAt).
    await DBOS.runStep(
      async () => {
        await persistAudioResult(prisma, genId, {
          assetKey,
          kind: request.kind,
          providerGenerationId,
        });
      },
      { name: "persistResult", retriesAllowed: true, maxAttempts: 3 },
    );

    return { generationId: genId, assetKey, kind: request.kind };
  } catch (err) {
    // Mark failed ONLY on a permanent typed failure (bad request row, not connected,
    // permanent 4xx) — transient failures and DBOS cancellation propagate for retry/recovery.
    if (isPermanentGenerationFailure(err)) {
      await DBOS.runStep(
        async () => {
          await markAudioGenerationFailed(prisma, genId, (err as Error).message);
        },
        { name: "recordFailure", retriesAllowed: true, maxAttempts: 3 },
      );
    }
    throw err;
  }
}

export const generateAudioWorkflow = DBOS.registerWorkflow(generateAudioFn, {
  name: GENERATE_AUDIO_WORKFLOW_NAME,
});
