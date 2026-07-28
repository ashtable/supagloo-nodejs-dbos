import type { ProjectManifest } from "@supagloo/database-lib";
import {
  DEFAULT_NARRATION_VOICE,
  type RequestMusicArgs,
  type RequestSpeechArgs,
} from "../../providers/media-client";

/**
 * `ensureNarrationAudio` / `ensureMusicAudio` — the pure DECISION half (design-delta §7
 * workflow 9: "synthesize only if the manifest lacks cached asset refs").
 *
 * Why this is a checkpointed step return rather than something re-derived on the fly:
 * the workflow BRANCHES on it, and DBOS requires a workflow to invoke the same steps in
 * the same order on replay. Re-deriving the decision from an ephemeral workspace could
 * produce a different branch after a crash.
 *
 * Three outcomes:
 *  - `cached`      — the manifest already carries the S3 asset key; `downloadSceneAssets`
 *                    has already materialized it into the workspace `public/` dir.
 *  - `synthesize`  — no ref, but we have a configured model, source text/style, and an
 *                    OpenRouter connection. One `requestSpeech` call, written to a
 *                    WORKSPACE-LOCAL key, which is then patched into the manifest so the
 *                    re-materialized composition actually references it.
 *  - `skipped`     — anything else. Deliberately NOT a failure: the normal path is that
 *                    the studio (task 35) already generated and committed the refs, so
 *                    render-time synthesis is a fallback, and a project with no narrator
 *                    model configured should still render silently rather than 500.
 *
 * The synthesized track is intentionally NOT uploaded to S3 nor written back to the
 * manifest in git: a git commit from the render workflow would collide with the task-18
 * per-project 409 git-ops guard. The cost is re-synthesis on every render of a
 * ref-less manifest — accepted and documented (plan D5).
 */

export type AudioTrackKind = "narration" | "music";

/** One scene's narration synthesis: which scene, where the file goes, what to say, and —
 *  once synthesized — how long it actually turned out to be. */
export interface NarrationScenePlan {
  sceneId: string;
  assetKey: string;
  speechArgs: RequestSpeechArgs;
  /** MEASURED after synthesis and folded back into the CHECKPOINTED plan, so it survives
   *  replay and reaches `applyAudioPlans`. */
  durationSeconds?: number;
}

export type AudioPlan =
  // Narration synthesizes N clips (one per scene) so each can be mounted inside its own
  // <Sequence>; music synthesizes one bed for the whole video.
  | { action: "cached"; assetKey: string }
  | {
      action: "synthesize";
      kind: "narration";
      scenes: NarrationScenePlan[];
    }
  | {
      action: "synthesize";
      kind: "music";
      assetKey: string;
      musicArgs: RequestMusicArgs;
      /** MEASURED bed length — the number the composition needs in order to loop it. */
      durationSeconds?: number;
    }
  | { action: "skipped"; reason: string };

/** The workspace-local `public/` subdirectory freshly-synthesized tracks are written to. */
export const RENDER_AUDIO_DIR = "render-audio";

/**
 * The workspace-local "asset key" for a synthesized track. Deliberately NOT shaped like
 * an S3 key (`projects/…` / `renders/…`) so it can never be confused for one — it only
 * ever names a file under the workspace's `public/` dir and a `staticFile()` path.
 */
export function renderAudioAssetKey(kind: AudioTrackKind): string {
  return `${RENDER_AUDIO_DIR}/${kind}.wav`;
}

/** The workspace-local key for ONE scene's narration clip. Distinct per scene, since
 *  narration is no longer a single whole-video file. */
export function renderSceneNarrationAssetKey(sceneId: string): string {
  // The scene id is sanitized because this becomes a path segment under the workspace
  // `public/` dir and is handed to `staticFile()`.
  const safe = sceneId.replace(/[^A-Za-z0-9_-]/g, "-");
  return `${RENDER_AUDIO_DIR}/narration-${safe}.mp3`;
}

/**
 * The provider `voice` for narration. A FIXED valid enum value — the manifest's freeform
 * voice DESCRIPTOR (e.g. "JAMES EARL JONES-STYLE") is not a valid provider voice id, so
 * it cannot be passed through. Identical rule to `generate-audio/synthesize.ts`.
 */
const NARRATION_VOICE = DEFAULT_NARRATION_VOICE;

export interface PlanAudioArgs {
  kind: AudioTrackKind;
  manifest: ProjectManifest;
  /** From `RENDER_NARRATION_MODEL` / `RENDER_MUSIC_MODEL`; undefined ⇒ no fallback. */
  modelId?: string;
  hasOpenRouterConnection: boolean;
}

export function planAudioTrack(args: PlanAudioArgs): AudioPlan {
  const { kind, manifest, modelId, hasOpenRouterConnection } = args;

  const cachedKey =
    kind === "narration"
      ? manifest.narratorVoice.assetKey
      : manifest.music?.assetKey;
  if (cachedKey) {
    return { action: "cached", assetKey: cachedKey };
  }

  if (!modelId) {
    return {
      action: "skipped",
      reason: `no render ${kind} model configured (RENDER_${kind.toUpperCase()}_MODEL)`,
    };
  }
  if (!hasOpenRouterConnection) {
    return {
      action: "skipped",
      reason: "the project owner has no OpenRouter connection",
    };
  }

  if (kind === "narration") {
    // ONE CLIP PER SCENE. This used to concatenate every scene's script into a single
    // synthesis call, producing one whole-video track that the composition could only mount
    // at frame 0 — there was no sync mechanism at all, so the narration drifted away from
    // the picture. Splitting per scene is what lets each clip live inside its own
    // <Sequence>, and what gives each scene a measurable length to stretch to.
    const scenes = manifest.scenes
      .filter((scene) => scene.scriptText.trim().length > 0)
      .map((scene) => ({
        sceneId: scene.id,
        assetKey: renderSceneNarrationAssetKey(scene.id),
        speechArgs: {
          modelId,
          input: scene.scriptText,
          voice: NARRATION_VOICE,
        },
      }));
    if (scenes.length === 0) {
      return { action: "skipped", reason: "no narration script text in the manifest" };
    }
    return { action: "synthesize", kind: "narration", scenes };
  }

  const style = manifest.music?.style;
  if (!style) {
    return { action: "skipped", reason: "the manifest has no music bed" };
  }
  // Music uses the streaming chat-audio contract with NO voice, and sends no duration —
  // no discovered music model accepts one.
  return {
    action: "synthesize",
    kind: "music",
    assetKey: renderAudioAssetKey("music"),
    musicArgs: { modelId, input: style },
  };
}

export interface AudioPlans {
  narration: AudioPlan;
  music: AudioPlan;
}

/**
 * Patch the freshly-synthesized tracks' workspace-local keys onto a COPY of the manifest.
 * `cached` and `skipped` tracks are left exactly as they were. The result drives
 * `applyManifest`, which regenerates `src/Video.tsx` with the matching `<Audio>` elements
 * — the half that makes the audio audible rather than merely present in the bundle.
 */
export function applyAudioPlans(
  manifest: ProjectManifest,
  plans: AudioPlans,
): ProjectManifest {
  let next = manifest;
  if (plans.narration.action === "synthesize" && plans.narration.kind === "narration") {
    // Per-scene keys + measured lengths. The whole-project `narratorVoice.assetKey` is
    // deliberately left alone: the composition prefers per-scene clips and ignores the
    // whole-video track once any exist, so setting both would double the narration up.
    const bySceneId = new Map(plans.narration.scenes.map((s) => [s.sceneId, s]));
    next = {
      ...next,
      scenes: next.scenes.map((scene) => {
        const hit = bySceneId.get(scene.id);
        if (!hit) return scene;
        return {
          ...scene,
          narrationAssetKey: hit.assetKey,
          ...(hit.durationSeconds !== undefined
            ? { narrationDurationSeconds: hit.durationSeconds }
            : {}),
        };
      }),
    };
  }
  if (plans.music.action === "synthesize" && plans.music.kind === "music" && next.music) {
    next = {
      ...next,
      music: {
        ...next.music,
        assetKey: plans.music.assetKey,
        // Only when it was really measured — a guessed length would mis-time the loop.
        ...(plans.music.durationSeconds !== undefined
          ? { durationSeconds: plans.music.durationSeconds }
          : {}),
      },
    };
  }
  return next;
}

/** The small, checkpoint-safe summary a plan reduces to for the workflow's result. */
export function audioPlanOutcome(plan: AudioPlan): "cached" | "synthesized" | "skipped" {
  if (plan.action === "cached") return "cached";
  if (plan.action === "synthesize") return "synthesized";
  return "skipped";
}
