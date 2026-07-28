import { GenerateImageInputSchema } from "@supagloo/database-lib";
import { coerceTradition, type GlooTradition } from "../../providers/faith-alignment";
import { GenerationRequestInvalidError } from "./errors";

/**
 * Pure validator for the image-generation request row (the loadRequestAndCredentials step
 * wraps it). An image generation MUST be `image`-kind, MUST name a provider the workflow
 * actually implements, MUST be project-scoped (design §8 defines no project-less asset S3
 * layout — an image asset has nowhere to live without a project) and MUST carry a `prompt`
 * (the real `GenerateImageInputSchema`). Any violation is a PERMANENT
 * `GenerationRequestInvalidError` (the workflow marks the row `failed`, no retry).
 *
 * Returns the CHECKPOINT-SAFE request context (no secret) — the provider credential is
 * (re)loaded INSIDE the provider-call step so it never lands in a DBOS checkpoint.
 *
 * ── `faithAlignment` rides in `input`, on purpose ───────────────────────────────────
 * Not as a new top-level create field: every kind's input schema is already
 * `.passthrough()`, so carrying it there needs no change to
 * `CreateAiGenerationRequestSchema` and no api-side release dependency. It is narrowed to
 * Gloo's real `tradition` vocabulary HERE, because Gloo answers 200 for a bogus value and
 * silently degrades to neutral — there is no upstream 422 that could have caught it.
 */
export interface ImageRequestRow {
  userId: string;
  kind: string;
  provider: string;
  model: string;
  projectId: string | null;
  input: unknown;
}

/** The providers `generateImageWorkflow` has a real implementation for. Deliberately a
 *  statement about THIS workflow rather than a re-read of the enqueue-time compatibility
 *  matrix: the matrix is the gate on what may be created, this is the gate on what can
 *  actually be executed, and the workflow must not silently trust the upstream one. */
const IMPLEMENTED_PROVIDERS = ["openrouter", "gloo"] as const;
export type ImageProvider = (typeof IMPLEMENTED_PROVIDERS)[number];

export interface ImageRequest {
  userId: string;
  /** Which provider path to take — OpenRouter's chat/completions `modalities:["image"]`
   *  surface, or Gloo's `POST /ai/v2/responses`. */
  provider: ImageProvider;
  model: string;
  projectId: string;
  prompt: string;
  /** Gloo's faith-alignment steering, already narrowed. Absent for OpenRouter (which has
   *  no such concept) and absent whenever the persisted value was not one of the four
   *  real values. */
  tradition?: GlooTradition;
}

export function parseImageRequest(row: ImageRequestRow): ImageRequest {
  if (row.kind !== "image") {
    throw new GenerationRequestInvalidError(
      `generateImage does not handle the "${row.kind}" kind`,
    );
  }
  if (!(IMPLEMENTED_PROVIDERS as readonly string[]).includes(row.provider)) {
    throw new GenerationRequestInvalidError(
      `generateImageWorkflow supports ${IMPLEMENTED_PROVIDERS.join("/")}, got: "${row.provider}"`,
    );
  }
  if (!row.projectId) {
    throw new GenerationRequestInvalidError(
      "image generation requires a projectId (a generated image asset is stored under " +
        "projects/{projectId}/assets/…)",
    );
  }
  const parsed = GenerateImageInputSchema.safeParse(row.input);
  if (!parsed.success) {
    throw new GenerationRequestInvalidError(
      `image generation input failed validation: ${parsed.error.message}`,
    );
  }
  // `coerceTradition` DROPS anything unrecognised rather than throwing: a bad alignment
  // must degrade to the neutral result Gloo would have produced anyway, not fail a
  // generation the user has already spent.
  const tradition = coerceTradition(
    (parsed.data as { faithAlignment?: unknown }).faithAlignment,
  );
  return {
    userId: row.userId,
    provider: row.provider as ImageProvider,
    model: row.model,
    projectId: row.projectId,
    prompt: parsed.data.prompt,
    ...(tradition ? { tradition } : {}),
  };
}
