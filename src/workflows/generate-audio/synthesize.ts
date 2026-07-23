import type { RequestSpeechArgs } from "../../providers/media-client";
import type { AudioRequest } from "./request";

/**
 * Pure builder: turn a parsed {@link AudioRequest} into the {@link RequestSpeechArgs} the media
 * client's `requestSpeech` (STREAMING chat-completions audio) consumes. Kept pure so the
 * narration-concatenation / music-mapping rules are unit-testable without HTTP or DBOS.
 *
 * NARRATION (decision D5): the whole-project narration spec carries a per-scene script array, but
 * an `AiGeneration` row has ONE `resultAssetKey`. We synthesize ONE combined track — the per-scene
 * `scriptText`s are concatenated in array order (blank-line-joined) into a single `input` string,
 * one `requestSpeech` call. The provider `voice` is a FIXED valid enum (`"alloy"`) — the request's
 * freeform voice DESCRIPTOR (e.g. "JEJ-STYLE") is not a valid OpenAI voice id, so it cannot be
 * passed through; richer descriptor→voice mapping is future work.
 *
 * MUSIC (decision D2 — CONFIRMED against real OpenRouter, task 34-E4): music uses the SAME
 * streaming chat-completions audio path as narration, just with a Lyria model and NO `voice`
 * (Lyria returns `delta.audio.data` PCM16 identically). The style label is the `input`.
 * `durationSeconds` is validated but not yet plumbed (Lyria clip length is model-determined).
 */
export function buildSpeechArgs(request: AudioRequest): RequestSpeechArgs {
  if (request.kind === "narration") {
    const input = request.input.scenes.map((s) => s.scriptText).join("\n\n");
    return { modelId: request.model, input, voice: "alloy" };
  }
  return { modelId: request.model, input: request.input.style };
}
