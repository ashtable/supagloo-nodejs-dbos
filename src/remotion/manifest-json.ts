import type { ProjectManifest } from "@supagloo/database-lib";

/**
 * Canonical, deterministic serialization of the `supagloo.project.json` manifest —
 * the sole source of truth carried in every project repo (design-delta §2). Pure.
 *
 * The object is rebuilt in a FIXED field order (regardless of the input object's key
 * order) with undefined optionals OMITTED (an explicitly `null` asset key is kept —
 * `null` is a real value). This gives a byte-stable on-disk form that round-trips
 * `ProjectManifestSchema` (asserted in generate.test.ts).
 */
export function canonicalizeManifest(
  manifest: ProjectManifest,
): Record<string, unknown> {
  const composition = {
    width: manifest.composition.width,
    height: manifest.composition.height,
    fps: manifest.composition.fps,
    aspectRatio: manifest.composition.aspectRatio,
  };

  const scenes = manifest.scenes.map((scene) => {
    const out: Record<string, unknown> = {
      id: scene.id,
      name: scene.name,
      scriptText: scene.scriptText,
      reference: scene.reference,
      translation: scene.translation,
      visualPrompt: scene.visualPrompt,
      durationSeconds: scene.durationSeconds,
      captions: scene.captions,
    };
    if (scene.visualAssetKey !== undefined) {
      out.visualAssetKey = scene.visualAssetKey;
    }
    return out;
  });

  const narratorVoice: Record<string, unknown> = {
    description: manifest.narratorVoice.description,
  };
  if (manifest.narratorVoice.label !== undefined) {
    narratorVoice.label = manifest.narratorVoice.label;
  }

  const out: Record<string, unknown> = {
    manifestVersion: manifest.manifestVersion,
    composition,
    scenes,
    narratorVoice,
  };

  if (manifest.music !== undefined) {
    const music: Record<string, unknown> = { style: manifest.music.style };
    if (manifest.music.assetKey !== undefined) {
      music.assetKey = manifest.music.assetKey;
    }
    out.music = music;
  }

  if (manifest.endCard !== undefined) {
    const endCard: Record<string, unknown> = {
      headline: manifest.endCard.headline,
    };
    if (manifest.endCard.subtext !== undefined) {
      endCard.subtext = manifest.endCard.subtext;
    }
    out.endCard = endCard;
  }

  return out;
}

/** Canonical JSON text (2-space indent, trailing newline). */
export function serializeManifest(manifest: ProjectManifest): string {
  return `${JSON.stringify(canonicalizeManifest(manifest), null, 2)}\n`;
}
