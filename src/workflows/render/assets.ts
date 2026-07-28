import type { ProjectManifest } from "@supagloo/database-lib";

/**
 * The S3 asset keys `downloadSceneAssets` materializes into the render workspace's
 * `public/` dir, where `getAssetUrl` → `staticFile(assetKey)` resolves them.
 *
 * WHY THIS LIVES IN ITS OWN MODULE: `render.ts` calls `DBOS.registerWorkflow` at module
 * load, so importing it from a test costs a 40-line `vi.mock("@dbos-inc/dbos-sdk", …)`
 * (see `render.order.test.ts`). This module is pure, matching the `render/audio.ts` +
 * `render/audio.test.ts` convention, so `assets.test.ts` needs no mock.
 *
 * THE INVARIANT THIS MODULE IS ONE HALF OF — stated carefully, because the obvious
 * phrasing ("every `getAssetUrl` key the composition emits must appear here") is FALSE:
 *
 *   Every key the generated composition resolves through `getAssetUrl(...)` is
 *   materialized by exactly one of the two materializers — `ensureSceneAssets`, which
 *   downloads `manifestAssetKeys(manifest)` from S3, or `ensureAudioOnDisk`, which writes
 *   the workspace-local `render-audio/…` keys the active `AudioPlans` carry.
 *
 * The two are fed DIFFERENT manifests on purpose (`render.ts`): `ensureSceneAssets` gets
 * the manifest as committed, while the generator gets `applyAudioPlans(manifest, plans)`.
 * So on the render-time synthesis fallback the composition legitimately emits keys —
 * `render-audio/narration-{id}.mp3`, `render-audio/music.wav` — that `manifestAssetKeys`
 * must NOT contain, because there is no S3 object behind them. `assets.test.ts` holds the
 * union, not the half.
 *
 * A MISSING KEY IS A HARD FAILURE, NOT A DEGRADED VIDEO. Verified in the pinned
 * `@remotion/renderer@4.0.490`: `dist/assets/read-file.js` throws on any `statusCode >=
 * 400`, and `dist/assets/download-and-map-assets-to-file.js` calls it with no catch. An
 * unmaterialized key 404s off the dev server and the render fails outright.
 */
export function manifestAssetKeys(manifest: ProjectManifest): string[] {
  const keys = new Set<string>();
  for (const scene of manifest.scenes) {
    if (scene.visualAssetKey) keys.add(scene.visualAssetKey);
    // Per-scene narration. Omitting this was R1: `templates.ts` suppresses the whole-video
    // track as soon as ANY scene carries its own clip, so every emitted per-scene `<Audio>`
    // pointed at a `staticFile()` path with no file behind it — and Remotion throws on the
    // 404 rather than degrading, so the render failed outright.
    if (scene.narrationAssetKey) keys.add(scene.narrationAssetKey);
  }
  if (manifest.narratorVoice.assetKey) keys.add(manifest.narratorVoice.assetKey);
  if (manifest.music?.assetKey) keys.add(manifest.music.assetKey);
  return [...keys];
}
