import type { ManifestScene } from "@supagloo/database-lib";

/**
 * Deterministic scene-name → source-file naming. `ManifestScene.name` is free text
 * (`z.string().min(1)`) — not guaranteed to be a valid JS identifier, filename-safe,
 * or unique — so we sanitize + dedup it into a stable PascalCase component name that
 * doubles as the `.tsx` filename base (design ref: `src/scenes/Shelter.tsx`). Pure.
 */
export interface AssignedScene {
  scene: ManifestScene;
  /** PascalCase, valid-identifier, unique component name (also the filename base). */
  component: string;
  /** `${component}.tsx`. */
  fileName: string;
}

/**
 * Sanitize a free-text scene name into a PascalCase JS identifier:
 * split on runs of non-alphanumerics, drop empties, upper-case each word's first
 * char, join. Fallbacks keep the result a valid identifier + filename:
 *   - empty result (e.g. "!!!") → "Scene"
 *   - leading digit (e.g. "123abc") → prefix "Scene" ("Scene123abc")
 */
export function toComponentName(name: string): string {
  const pascal = name
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join("");
  if (pascal.length === 0) {
    return "Scene";
  }
  if (/^[0-9]/.test(pascal)) {
    return `Scene${pascal}`;
  }
  return pascal;
}

/**
 * Assign a unique component/file name to each scene, in array order. Collisions are
 * resolved case-insensitively (safe on case-insensitive filesystems) by appending
 * the next integer ≥ 2 (`Shelter`, `Shelter2`, `Shelter3`, …). Deterministic given
 * the manifest; keeps the scene object + order association.
 */
export function assignSceneFileNames(scenes: ManifestScene[]): AssignedScene[] {
  const used = new Set<string>();
  return scenes.map((scene) => {
    const base = toComponentName(scene.name);
    let candidate = base;
    let n = 2;
    while (used.has(candidate.toLowerCase())) {
      candidate = `${base}${n}`;
      n += 1;
    }
    used.add(candidate.toLowerCase());
    return { scene, component: candidate, fileName: `${candidate}.tsx` };
  });
}
