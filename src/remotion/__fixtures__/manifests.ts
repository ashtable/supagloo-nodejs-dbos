import type { ProjectManifest } from "@supagloo/database-lib";

/**
 * Typed ProjectManifest fixtures shared by the generator unit tests and the
 * bundle e2e. Each is a valid `ProjectManifestSchema` value (the round-trip test
 * asserts this). Kept as a typed module (not JSON) so TypeScript proves they stay
 * schema-shaped as the schema evolves.
 */

/** Primary golden fixture: two scenes, ALL optional fields present, captions on. */
export const shelterManifest: ProjectManifest = {
  manifestVersion: 1,
  composition: { width: 1080, height: 1920, fps: 30, aspectRatio: "9:16" },
  scenes: [
    {
      id: "scene-1",
      name: "Shelter",
      scriptText:
        "He who dwells in the shelter of the Most High will rest in the shadow of the Almighty.",
      reference: "Psalm 91:1",
      translation: "BSB",
      visualPrompt: "A traveler resting under a vast starlit desert sky",
      durationSeconds: 5,
      captions: true,
      visualAssetKey: "projects/demo/scenes/scene-1.jpg",
    },
    {
      id: "scene-2",
      name: "Refuge",
      scriptText:
        "I will say of the LORD, He is my refuge and my fortress, my God, in whom I trust.",
      reference: "Psalm 91:2",
      translation: "BSB",
      visualPrompt: "A stone fortress on a hill at golden hour",
      durationSeconds: 7,
      captions: true,
      visualAssetKey: "projects/demo/scenes/scene-2.jpg",
    },
  ],
  narratorVoice: { description: "Warm, reverent male narrator", label: "Narrator" },
  music: { style: "ambient cinematic pads", assetKey: "projects/demo/music/bed.mp3" },
  endCard: { headline: "Find shelter today", subtext: "Psalm 91" },
};

/** Freshly-scaffolded project: zero scenes, no optional music/endCard. */
export const emptyManifest: ProjectManifest = {
  manifestVersion: 1,
  composition: { width: 1920, height: 1080, fps: 30, aspectRatio: "16:9" },
  scenes: [],
  narratorVoice: { description: "Calm female narrator" },
};

/** Single scene, all optionals omitted — a clean round-trip (no null/undefined noise). */
export const minimalManifest: ProjectManifest = {
  manifestVersion: 1,
  composition: { width: 1080, height: 1080, fps: 24, aspectRatio: "1:1" },
  scenes: [
    {
      id: "s1",
      name: "Intro",
      scriptText: "In the beginning was the Word.",
      reference: "John 1:1",
      translation: "KJV",
      visualPrompt: "abstract light rays",
      durationSeconds: 3,
      captions: false,
    },
  ],
  narratorVoice: { description: "Narrator" },
};

/**
 * Naming/sanitization edge cases. Expected assigned component names (in order):
 *   "Shelter", "Shelter2", "TheShelter", "Scene123abc", "Scene".
 */
export const collisionManifest: ProjectManifest = {
  manifestVersion: 1,
  composition: { width: 1080, height: 1920, fps: 30, aspectRatio: "9:16" },
  scenes: [
    scene("a", "Shelter"),
    scene("b", "shelter"),
    scene("c", "The Shelter!"),
    scene("d", "123abc"),
    scene("e", "!!!"),
  ],
  narratorVoice: { description: "Narrator" },
};

function scene(id: string, name: string) {
  return {
    id,
    name,
    scriptText: "text",
    reference: "Ref 1:1",
    translation: "KJV" as const,
    visualPrompt: "prompt",
    durationSeconds: 2,
    captions: false,
  };
}
