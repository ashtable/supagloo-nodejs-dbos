import {
  DEFAULT_NARRATION_VOICE,
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
 * Richer descriptor→voice mapping remains future work.
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

export function buildNarrationSceneArgs(
  request: Extract<AudioRequest, { kind: "narration" }> | AudioRequest,
): NarrationSceneArgs[] {
  if (request.kind !== "narration") {
    throw new Error(`buildNarrationSceneArgs called with kind "${request.kind}"`);
  }
  // Array order is preserved verbatim: the workflow runs one DBOS step per entry, and DBOS
  // requires the same steps in the same order on replay. Deriving this list purely from the
  // already-checkpointed request is what makes that hold after a crash.
  return request.input.scenes.map((scene) => ({
    sceneId: scene.sceneId,
    speech: {
      modelId: request.model,
      input: scene.scriptText,
      voice: DEFAULT_NARRATION_VOICE,
    },
  }));
}

export function buildMusicArgs(request: AudioRequest): RequestMusicArgs {
  if (request.kind !== "music") {
    throw new Error(`buildMusicArgs called with kind "${request.kind}"`);
  }
  return { modelId: request.model, input: request.input.style };
}
