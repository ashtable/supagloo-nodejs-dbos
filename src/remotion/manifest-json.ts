import type { AiModelChoice, ProjectManifest } from "@supagloo/database-lib";

/** The kinds the Inspector offers a model selector for, in their canonical on-disk
 *  order. Iterating a FIXED list (rather than the input object's keys) is what makes the
 *  emitted field order independent of however the studio happened to build the object. */
const AI_SETTING_KINDS = ["image", "narration", "music", "video"] as const;

/** Rebuild one `{provider, model?}` choice with `model` omitted when unset — an
 *  `undefined` key would break the byte-stable on-disk form. */
function canonicalizeChoice(choice: AiModelChoice): Record<string, unknown> {
  const out: Record<string, unknown> = { provider: choice.provider };
  if (choice.model !== undefined) out.model = choice.model;
  return out;
}

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
    // The SAME symmetry invariant recorded below for `narratorVoice.assetKey`: a field the
    // generator READS but this function does not WRITE is silently erased on every commit.
    // These three drive the per-scene narration <Audio>, the scene/narration duration
    // reconciliation, and the still-vs-clip branch respectively — dropping any of them
    // would quietly restore the exact bug it was added to fix, one commit later.
    if (scene.visualAssetKind !== undefined) {
      out.visualAssetKind = scene.visualAssetKind;
    }
    if (scene.narrationAssetKey !== undefined) {
      out.narrationAssetKey = scene.narrationAssetKey;
    }
    if (scene.narrationDurationSeconds !== undefined) {
      out.narrationDurationSeconds = scene.narrationDurationSeconds;
    }
    return out;
  });

  const narratorVoice: Record<string, unknown> = {
    description: manifest.narratorVoice.description,
  };
  if (manifest.narratorVoice.label !== undefined) {
    narratorVoice.label = manifest.narratorVoice.label;
  }
  // Step-11 item 15 (RX-4 / R4850-7). This branch was MISSING while `music.assetKey`'s
  // equivalent existed forty lines below, so every commit silently erased the cached
  // narration reference. Three consequences, all of them real spend rather than tidiness:
  // `templates.ts` reads `narratorVoice.assetKey ?? null`, so the emitted `Video.tsx` had no
  // narration `<Audio>` at all; `ensureNarrationAudio` could never find a cached ref, so
  // every render of a committed version re-synthesized narration through a live TTS
  // provider; and §10 R8's "use cached audio refs so N renders cost time, not money" was
  // unsatisfiable for narration. Symmetry with `music` below is the invariant to preserve.
  if (manifest.narratorVoice.assetKey !== undefined) {
    narratorVoice.assetKey = manifest.narratorVoice.assetKey;
  }
  // Feature 1 — the CHOSEN provider voice id, under the same symmetry invariant. Omitting
  // this branch would erase the user's narrator on the next commit while the studio still
  // displayed the choice it had already lost, and the next render would silently revert to
  // the default voice. Read through the DECLARED type: `VoiceDescriptorSchema.voiceId`
  // exists at the pinned db-lib (`fc5cf2c`), so the forward-declaring cast that used to
  // stand here is gone and a rename or removal upstream now breaks this line at compile
  // time instead of silently emitting nothing. The `!== undefined` check is not a type
  // guard and stays: it is the omit-unset-optionals rule that keeps the on-disk form
  // byte-stable, exactly as `label`/`assetKey` above and `music` below do.
  const { voiceId } = manifest.narratorVoice;
  if (voiceId !== undefined) {
    narratorVoice.voiceId = voiceId;
  }

  const out: Record<string, unknown> = {
    manifestVersion: manifest.manifestVersion,
    composition,
    scenes,
    narratorVoice,
  };

  // Feature 2 — the project's ORIGIN passage, picked in the new-project wizard's step 2
  // before any scene existed. Same symmetry invariant again: the scaffold seeds it, so
  // without this branch the very first commit from the studio would erase it and the
  // first-time storyboard generation would lose the passage the project was created for.
  // Fixed key order, `undefined` optionals omitted, byte-stable on disk.
  // Read through the DECLARED type: `ProjectManifestSchema.scripture` exists at the pinned
  // db-lib (`fc5cf2c`), so the hand-written forward shape that used to sit here is gone.
  // That shape had to be kept in sync by eye; the real `ManifestScriptureSchema` now
  // enforces it, and a field added upstream fails this block at compile time rather than
  // being quietly dropped on every commit.
  const { scripture } = manifest;
  if (scripture !== undefined) {
    const out2: Record<string, unknown> = {
      reference: scripture.reference,
      translation: scripture.translation,
    };
    if (scripture.language !== undefined) out2.language = scripture.language;
    if (scripture.passageId !== undefined) out2.passageId = scripture.passageId;
    out.scripture = out2;
  }

  if (manifest.music !== undefined) {
    const music: Record<string, unknown> = { style: manifest.music.style };
    if (manifest.music.assetKey !== undefined) {
      music.assetKey = manifest.music.assetKey;
    }
    // The MEASURED bed length. Without it surviving a commit the composition cannot loop
    // the bed, and the music silently reverts to "plays once, then silence".
    if (manifest.music.durationSeconds !== undefined) {
      music.durationSeconds = manifest.music.durationSeconds;
    }
    out.music = music;
  }

  // Genesis-1: the project's provider/model choices + faith alignment. Written under the
  // SAME symmetry invariant recorded above for `narratorVoice.assetKey` and the per-scene
  // fields: a value the studio writes but this function does not is silently ERASED on
  // every commit. Here that would mean the user's model choice appearing to save, lasting
  // until the next commit, and then reverting to the system default with nothing to
  // indicate it -- which is worse than not persisting at all, because there is no reason
  // to go and look.
  const aiSettings = manifest.aiSettings;
  if (aiSettings !== undefined) {
    const out2: Record<string, unknown> = {};
    if (aiSettings.faithAlignment !== undefined) {
      out2.faithAlignment = aiSettings.faithAlignment;
    }
    for (const kind of AI_SETTING_KINDS) {
      const choice = aiSettings[kind];
      if (choice !== undefined) out2[kind] = canonicalizeChoice(choice);
    }
    out.aiSettings = out2;
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
