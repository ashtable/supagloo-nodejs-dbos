import {
  type RequestMusicArgs,
  type RequestSpeechArgs,
} from "../../providers/media-client";
import type { AudioRequest } from "./request";

/**
 * Pure builders: turn a parsed {@link AudioRequest} into the provider-call args. Kept pure so
 * the per-scene split and the music mapping are unit-testable without HTTP or DBOS.
 *
 * ## NARRATION — one call PER SCENE (was: one concatenated call)
 *
 * This used to join every scene's `scriptText` with `\n\n` into a single synthesis call,
 * producing ONE whole-project asset. That made scene-synced narration impossible by
 * construction: a single track has no scene boundaries, so the composition could only mount
 * it at frame 0 and hope — which is exactly what it did, while scene lengths came from the
 * LLM's suggested durations. The result was narration drifting away from the picture.
 *
 * Splitting per scene gives each scene its own clip and its own measured length, which is
 * what lets the generated composition put the audio inside that scene's `<Sequence>` and let
 * the scene stretch to fit it. The `AiGeneration` row keeps exactly one `resultAssetKey`;
 * the extra keys travel in `resultJson` (`NarrationResultSchema`).
 *
 * The provider `voice` is a valid provider voice id, NOT the request's freeform DESCRIPTOR
 * ("JEJ-STYLE") — the live endpoint rejects an unknown voice and enumerates the valid ones.
 *
 * It is the id the STUDIO chose (`input.voiceId`), and when the project has never picked
 * one this builder leaves `voice` UNSET rather than substituting a default. Until this, the
 * descriptor was written, validated, persisted, committed and snapshotted, and read by zero
 * provider-facing code — every project narrated in the same voice however the studio was
 * configured.
 *
 * CORRECTED 2026-07-30. This used to fall back to `DEFAULT_NARRATION_VOICE = "alloy"`, and
 * the claim above it — that "no provider publishes a voice-enumeration API" — was false:
 * `supported_voices` is a top-level key on every speech-catalogue entry. `alloy` is not in
 * the narration model's vocabulary and only ever worked through an undocumented alias
 * layer. Resolving an absent voice now belongs to `requestSpeech`, the one place that reads
 * the model's OWN published list. This file stays a PASS-THROUGH and holds no voice
 * catalogue of its own — which is now true of the studio too.
 *
 * `render/audio.ts` resolves the same value from `manifest.narratorVoice.voiceId`. Both
 * paths must agree or the studio preview and the final render narrate in different voices.
 *
 * ## MUSIC — one call, and deliberately NO duration
 *
 * `durationSeconds` is validated on the request (the studio computes it from the storyboard)
 * but is not forwarded, because there is nothing to forward it to. Verified live against real
 * OpenRouter: `supported_parameters` for BOTH `google/lyria-3-pro-preview` and
 * `google/lyria-3-clip-preview` is `["max_tokens","response_format","seed","temperature",
 * "top_p"]`. Clip length is a property of the model chosen (clip ≈ 30 s, pro = a full song),
 * not a request parameter. Making the bed span the video is therefore the composition's job:
 * it measures what came back and loops it. Sending an undocumented `duration` field would be
 * an invented contract, which is the precise failure mode this area has already suffered.
 */

export interface NarrationSceneArgs {
  /** The manifest scene this clip belongs to — the key to the whole sync mechanism. */
  sceneId: string;
  speech: RequestSpeechArgs;
}

/**
 * The chosen provider voice id, read STRUCTURALLY off the parsed narration input.
 *
 * `GenerateNarrationInputSchema` is `NarrationSpecSchema.passthrough()`, so a top-level
 * key survives validation here even though this repo's pinned `@supagloo/database-lib`
 * copy does not yet DECLARE it — the same mechanism `faithAlignment` already rides for
 * image generations. The cast is the forward declaration.
 *
 * DELETE THE CAST AT THE db-lib BUMP (`NarrationSpecSchema.voiceId` types it).
 *
 * Anything that is not a non-empty string is treated as absent rather than forwarded: an
 * unknown voice is a hard provider 400, and degrading to the default narrator is a far
 * better outcome than failing the whole generation on a malformed id.
 */
function chosenVoiceId(input: unknown): string | undefined {
  const raw = (input as { voiceId?: unknown } | null | undefined)?.voiceId;
  return typeof raw === "string" && raw.length > 0 ? raw : undefined;
}

export function buildNarrationSceneArgs(
  request: Extract<AudioRequest, { kind: "narration" }> | AudioRequest,
): NarrationSceneArgs[] {
  if (request.kind !== "narration") {
    throw new Error(`buildNarrationSceneArgs called with kind "${request.kind}"`);
  }
  // ONE voice for the whole video, resolved once: a narrator that changed between scenes
  // would be a different person reading each verse.
  const voice = chosenVoiceId(request.input);
  // Array order is preserved verbatim: the workflow runs one DBOS step per entry, and DBOS
  // requires the same steps in the same order on replay. Deriving this list purely from the
  // already-checkpointed request is what makes that hold after a crash.
  return request.input.scenes.map((scene) => ({
    sceneId: scene.sceneId,
    speech: {
      modelId: request.model,
      input: scene.scriptText,
      voice,
    },
  }));
}

export function buildMusicArgs(request: AudioRequest): RequestMusicArgs {
  if (request.kind !== "music") {
    throw new Error(`buildMusicArgs called with kind "${request.kind}"`);
  }
  return { modelId: request.model, input: request.input.style };
}
