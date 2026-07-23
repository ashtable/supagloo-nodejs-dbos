import type { VideoRequest } from "./request";

/**
 * Pure builder: turn a parsed {@link VideoRequest}'s (camelCase, domain-shaped) `input` into the
 * OpenRouter `POST /api/v1/videos` request-body fields (snake_case). Mirrors generateAudio's
 * `buildSpeechArgs`. `model` is passed separately (submitVideoJob's `modelId`), so this returns
 * only the fields that get spread alongside `model` into the request body.
 *
 * Absent optionals are OMITTED (no `undefined` keys leak to the provider); present falsy values
 * (`generate_audio: false`, `seed: 0`) are preserved. `frame_images` carries source frames for
 * image-to-video. IMPLEMENTATION NOTE: the snake_case field names are OpenRouter's video-API
 * contract (design §7 workflow 8); the stub ignores the params beyond `prompt`, so the shape is
 * exercised by this pure test rather than the e2e's byte assertions.
 */
export function buildVideoSubmitInput(
  request: VideoRequest,
): Record<string, unknown> {
  const i = request.input;
  return {
    prompt: i.prompt,
    ...(i.durationSeconds !== undefined ? { duration: i.durationSeconds } : {}),
    ...(i.resolution !== undefined ? { resolution: i.resolution } : {}),
    ...(i.aspectRatio !== undefined ? { aspect_ratio: i.aspectRatio } : {}),
    ...(i.frameImages !== undefined ? { frame_images: i.frameImages } : {}),
    ...(i.generateAudio !== undefined ? { generate_audio: i.generateAudio } : {}),
    ...(i.seed !== undefined ? { seed: i.seed } : {}),
  };
}
