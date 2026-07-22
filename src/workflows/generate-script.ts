import { DBOS } from "@dbos-inc/dbos-sdk";
import { NoObjectGeneratedError } from "ai";
import {
  GenerateScriptInputSchema,
  type AiGenerationKind,
  type AiProvider,
  type GenerateScriptPayload,
} from "@supagloo/database-lib";
import { WORKFLOW_NAMES } from "../dbos/registry";
import { getAppDb } from "../db/app-db";
import { getProviderConfig } from "../providers/config";
import {
  loadGlooCredential,
  loadOpenRouterCredential,
} from "../providers/credentials";
import { mintGlooToken } from "../providers/gloo";
import {
  callLlmStructuredWithUsage,
  type StructuredProvider,
} from "../providers/generate-object";
import { DISCOVERY_RETRY, LLM_STRUCTURED_RETRY } from "../providers/errors";
import { fetchPassage, getBibleCollection } from "../providers/youversion";
import {
  GenerationRequestInvalidError,
  isPermanentGenerationFailure,
  retryUnlessPermanentGeneration,
} from "./generate-script/errors";
import { selectResultSchema } from "./generate-script/schema-selection";
import { resolveTranslation } from "./generate-script/translation";
import {
  buildGenerationPrompt,
  type ResolvedPassage,
} from "./generate-script/prompt";
import {
  runStructuredWithRepair,
  type AttemptResult,
} from "./generate-script/repair";
import {
  markGenerationFailed,
  markGenerationRunning,
  persistGenerationResult,
} from "./generate-script/finalize";

/**
 * `generateScriptWorkflow` (queue `ai-generation`) — the first `ai-generation` workflow,
 * on top of the task-29 provider layer. Design-delta §7 workflow 5 + §6d diagram (d).
 * Handles BOTH text kinds — `storyboard` (full scene breakdown, GeneratedStoryboardSchema)
 * and `script` (single-scene text, GeneratedScriptSchema) — selecting the target Zod schema
 * by the request row's `kind`.
 *
 * Steps: loadRequestAndCredentials → optional fetchScripturePassage → callLlmStructured
 * (LLM_STRUCTURED_RETRY: maxAttempts 5 + backoff, 4xx fail-fast) inside a BOUNDED static
 * re-prompt loop (max 3 repairs) → persistResult. It ONLY writes the `AiGeneration` row
 * (§6d step 8) — never `ProjectVersion` or the manifest.
 *
 * SECRET HANDLING: `loadRequestAndCredentials` verifies the provider connection exists but
 * returns NO plaintext; the OpenRouter key / Gloo token are (re)loaded INSIDE each LLM step
 * so they never land in a DBOS checkpoint.
 *
 * REPAIR-LOOP CRASH-SAFETY: schema-validation failures (`NoObjectGeneratedError`) are CAUGHT
 * inside the LLM step and returned as a `{ok:false}` union — a SUCCESSFUL checkpointed step
 * return. So every attempt (good or bad) is checkpointed; on crash/replay after a successful
 * repair, all attempts replay from their checkpoints with NO extra LLM HTTP call. Only
 * HTTP `APICallError`s throw → step-level retry via LLM_STRUCTURED_RETRY. Registered
 * STATICALLY at module load.
 */

export const GENERATE_SCRIPT_WORKFLOW_NAME = WORKFLOW_NAMES.generateScript;

// Re-exported so importers of this module (e.g. the e2e) keep importing the enqueue payload
// type from here.
export type { GenerateScriptPayload };

export interface GenerateScriptResult {
  generationId: string;
  kind: AiGenerationKind;
  provider: AiProvider;
}

/** The non-secret request context loadRequestAndCredentials returns (checkpoint-safe). */
interface GenerationRequest {
  userId: string;
  provider: AiProvider;
  model: string;
  kind: AiGenerationKind;
  input: ReturnType<typeof GenerateScriptInputSchema.parse>;
}

/**
 * TEST-ONLY DI seam (undefined in production ⇒ a pure no-op). The workflow awaits this hook
 * at each step BOUNDARY so a test can park the workflow and drive a crash/replay. Reading a
 * module-level ref (never mutating one) is a DI read, not workflow state; the hook never
 * changes which steps run, so determinism is preserved.
 */
export type BoundaryHook = (label: string) => void | Promise<void>;
let boundaryHook: BoundaryHook | undefined;
export function __setGenerateScriptBoundaryHook(
  hook: BoundaryHook | undefined,
): void {
  boundaryHook = hook;
}
async function boundary(label: string): Promise<void> {
  if (boundaryHook) await boundaryHook(label);
}

/** Extract a readable validation-error string from a NoObjectGeneratedError for re-prompting. */
function describeValidation(e: unknown): string {
  const cause = (e as { cause?: unknown }).cause;
  if (cause instanceof Error) return cause.message;
  if (e instanceof Error) return e.message;
  return String(e);
}

async function generateScriptFn(
  payload: GenerateScriptPayload,
): Promise<GenerateScriptResult> {
  const genId = DBOS.workflowID ?? payload.generationId;
  if (!genId) {
    throw new Error("generateScript: DBOS.workflowID unavailable inside the workflow");
  }
  const prisma = getAppDb();

  try {
    // 1) loadRequestAndCredentials — load the row, validate kind + input, verify the provider
    //    connection EXISTS (fail fast, no secret returned), flip queued → running.
    await boundary("loadRequestAndCredentials");
    const request = await DBOS.runStep<GenerationRequest>(
      async () => {
        const row = await prisma.aiGeneration.findUnique({ where: { id: genId } });
        if (!row) {
          throw new GenerationRequestInvalidError(`no AiGeneration row for id ${genId}`);
        }
        // Reject non-text kinds loudly (media kinds are #32–34).
        selectResultSchema(row.kind);
        const parsed = GenerateScriptInputSchema.safeParse(row.input);
        if (!parsed.success) {
          throw new GenerationRequestInvalidError(
            `AiGeneration ${genId} input failed validation: ${parsed.error.message}`,
          );
        }
        // Verify the connection exists WITHOUT returning the plaintext secret.
        const cfg = getProviderConfig();
        if (row.provider === "openrouter") {
          await loadOpenRouterCredential({
            prisma,
            userId: row.userId,
            encryptionKey: cfg.secretsEncryptionKey,
          });
        } else {
          await loadGlooCredential({
            prisma,
            userId: row.userId,
            encryptionKey: cfg.secretsEncryptionKey,
          });
        }
        await markGenerationRunning(prisma, genId);
        return {
          userId: row.userId,
          provider: row.provider,
          model: row.model,
          kind: row.kind,
          input: parsed.data,
        };
      },
      {
        name: "loadRequestAndCredentials",
        ...DISCOVERY_RETRY,
        shouldRetry: retryUnlessPermanentGeneration,
      },
    );

    // 2) fetchScripturePassage (optional — only for scripture-origin generations). Resolves
    //    the requested translation against the LIVE collection (licensing gate), then fetches
    //    the passage. The collection lookup is best-effort: on any failure fall back to the
    //    public-domain KJV/BSB (§9-Q10) rather than guessing another translation's licensing.
    let passage: ResolvedPassage | null = null;
    if (request.input.scripture) {
      const scripture = request.input.scripture;
      await boundary("fetchScripturePassage");
      passage = await DBOS.runStep<ResolvedPassage>(
        async () => {
          const cfg = getProviderConfig();
          let collection = null;
          try {
            collection = await getBibleCollection({
              youversionBaseUrl: cfg.youversionBaseUrl,
              appKey: cfg.youversionAppKey,
              language: scripture.language,
            });
          } catch {
            collection = null; // live API unavailable → KJV/BSB fallback
          }
          const resolved = resolveTranslation({
            requested: scripture.translation,
            collection,
          });
          const fetched = await fetchPassage({
            youversionBaseUrl: cfg.youversionBaseUrl,
            appKey: cfg.youversionAppKey,
            version: resolved.versionId,
            reference: scripture.reference,
          });
          return {
            reference: fetched.reference,
            translation: resolved.label,
            text: fetched.text,
          };
        },
        {
          name: "fetchScripturePassage",
          ...DISCOVERY_RETRY,
          shouldRetry: retryUnlessPermanentGeneration,
        },
      );
    }

    // 3) callLlmStructured + bounded repair loop. The schema is selected by kind; each attempt
    //    is a registered step; schema-validation failures are surfaced as {ok:false} (a
    //    checkpointed success) so the loop re-prompts without a step-level retry, and replay is
    //    exactly-once. HTTP failures throw → LLM_STRUCTURED_RETRY handles them.
    const schema = selectResultSchema(request.kind);
    const { system, prompt: initialPrompt } = buildGenerationPrompt({
      kind: request.kind,
      input: request.input,
      passage,
    });
    const provider: StructuredProvider = request.provider;

    const repaired = await runStructuredWithRepair<unknown>({
      initialPrompt,
      attempt: (prompt, i) =>
        DBOS.runStep<AttemptResult<unknown>>(
          async () => {
            const cfg = getProviderConfig();
            let apiKey: string;
            let baseUrl: string;
            if (provider === "openrouter") {
              const cred = await loadOpenRouterCredential({
                prisma,
                userId: request.userId,
                encryptionKey: cfg.secretsEncryptionKey,
              });
              apiKey = cred.apiKey;
              baseUrl = cfg.openrouterBaseUrl;
            } else {
              const cred = await loadGlooCredential({
                prisma,
                userId: request.userId,
                encryptionKey: cfg.secretsEncryptionKey,
              });
              const token = await mintGlooToken({
                glooBaseUrl: cfg.glooBaseUrl,
                clientId: cred.clientId,
                clientSecret: cred.clientSecret,
              });
              apiKey = token.accessToken;
              baseUrl = cfg.glooBaseUrl;
            }
            try {
              const { object, usage } = await callLlmStructuredWithUsage({
                provider,
                baseUrl,
                apiKey,
                modelId: request.model,
                schema,
                system,
                prompt,
              });
              return { ok: true, object, usage };
            } catch (e) {
              // Schema-validation failure ⇒ hand back to the repair loop (NOT a step retry).
              if (NoObjectGeneratedError.isInstance(e)) {
                return { ok: false, validationText: describeValidation(e) };
              }
              throw e; // HTTP/network → classified by LLM_STRUCTURED_RETRY.shouldRetry
            }
          },
          {
            name: i === 0 ? "callLlmStructured" : `callLlmStructured:repair:${i}`,
            ...LLM_STRUCTURED_RETRY,
          },
        ),
    });

    // 4) persistResult — idempotent success upsert (status/resultJson/tokenUsage/completedAt).
    await boundary("persistResult");
    await DBOS.runStep(
      async () => {
        await persistGenerationResult(prisma, genId, {
          resultJson: repaired.object,
          tokenUsage: repaired.usage,
        });
      },
      { name: "persistResult", retriesAllowed: true, maxAttempts: 3 },
    );

    return { generationId: genId, kind: request.kind, provider: request.provider };
  } catch (err) {
    // Mark the generation `failed` ONLY on a permanent typed failure (repair exhausted, not
    // licensed, unsupported kind, not connected, permanent 4xx) — transient failures and DBOS
    // cancellation are left to propagate for retry/recovery (the crash/replay test relies on
    // the cancellation NOT being one of these typed errors).
    if (isPermanentGenerationFailure(err)) {
      await DBOS.runStep(
        async () => {
          await markGenerationFailed(prisma, genId, (err as Error).message);
        },
        { name: "recordFailure", retriesAllowed: true, maxAttempts: 3 },
      );
    }
    throw err;
  }
}

export const generateScriptWorkflow = DBOS.registerWorkflow(generateScriptFn, {
  name: GENERATE_SCRIPT_WORKFLOW_NAME,
});
