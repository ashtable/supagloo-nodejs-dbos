import type { RequestSpeechArgs } from "../../providers/media-client";
import type { AudioRequest } from "./request";

/**
 * Pure builder: turn a parsed {@link AudioRequest} into the {@link RequestSpeechArgs} the
 * media client's `requestSpeech` (`POST /api/v1/audio/speech`) consumes. Kept pure so the
 * narration-concatenation / music-mapping rules are unit-testable without HTTP or DBOS.
 *
 * NARRATION (decision D5): the whole-project narration spec carries a per-scene script
 * array, but an `AiGeneration` row has ONE `resultAssetKey`. We synthesize ONE combined
 * track — the per-scene `scriptText`s are concatenated in array order (blank-line-joined)
 * into a single `input` string, one `requestSpeech` call. The voice descriptor maps to the
 * provider `voice` hint (label if present, else the freeform description; provider-dependent
 * per §7 — the stub ignores it). Future work may split this into true per-scene assets.
 *
 * MUSIC (decision D2): OpenRouter does NOT pin a music-generation REST contract, so we treat
 * music as OpenAI-Audio-Speech-compatible — the SAME `/api/v1/audio/speech` byte-stream
 * mechanism with a music-capable model id and the style label as the `input`. This literally
 * satisfies design §7's "same step shape" and reuses the tested `requestSpeech`. IMPLEMENTATION
 * -TIME ASSUMPTION — verify against the real OpenRouter music API before production; if music
 * turns out to be a distinct endpoint, only this builder + the media client need to change.
 * `durationSeconds` is validated but not yet plumbed to the (assumed) endpoint.
 */
export function buildSpeechArgs(request: AudioRequest): RequestSpeechArgs {
  if (request.kind === "narration") {
    const input = request.input.scenes.map((s) => s.scriptText).join("\n\n");
    return {
      modelId: request.model,
      input,
      voice: request.input.voice.label ?? request.input.voice.description,
      format: "mp3",
    };
  }
  return {
    modelId: request.model,
    input: request.input.style,
    format: "mp3",
  };
}
