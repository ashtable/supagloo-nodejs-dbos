import type { ProjectManifest } from "@supagloo/database-lib";
import { assignSceneFileNames } from "./naming";
import { serializeManifest } from "./manifest-json";
import {
  buildAssetsSource,
  buildGitignore,
  buildIndexSource,
  buildPackageJson,
  buildRemotionConfig,
  buildRootSource,
  buildSceneSource,
  buildTsconfig,
  buildVideoSource,
} from "./templates";

/** One generated file: a POSIX-relative path + its exact byte contents. */
export interface GeneratedFile {
  path: string;
  contents: string;
}

/**
 * The MANIFEST-DERIVED file set — regenerated on every commit by the future
 * `applyManifest` step. This is the single code path that produces the derived files
 * (also embedded in the full scaffold below), so scaffold + regen can never drift.
 * Deterministic + pure → golden-testable + trivially idempotent (same input → deep-
 * equal output).
 */
export function generateManifestFiles(manifest: ProjectManifest): GeneratedFile[] {
  const assigned = assignSceneFileNames(manifest.scenes);
  const files: GeneratedFile[] = [
    { path: "supagloo.project.json", contents: serializeManifest(manifest) },
    { path: "src/Root.tsx", contents: buildRootSource(manifest) },
    { path: "src/Video.tsx", contents: buildVideoSource(manifest, assigned) },
  ];
  for (const a of assigned) {
    files.push({
      path: `src/scenes/${a.fileName}`,
      contents: buildSceneSource(a),
    });
  }
  return files;
}

/**
 * The STATIC (manifest-independent) file set — written once at initial scaffold and
 * never touched by regeneration. Includes the `remotion.config.ts` project marker.
 */
export function generateStaticFiles(): GeneratedFile[] {
  return [
    { path: "remotion.config.ts", contents: buildRemotionConfig() },
    { path: "package.json", contents: buildPackageJson() },
    { path: "tsconfig.json", contents: buildTsconfig() },
    { path: ".gitignore", contents: buildGitignore() },
    { path: "src/index.ts", contents: buildIndexSource() },
    { path: "src/lib/assets.ts", contents: buildAssetsSource() },
  ];
}

/** The FULL initial scaffold: static files ∪ manifest-derived files. */
export function generateProjectFiles(manifest: ProjectManifest): GeneratedFile[] {
  return [...generateStaticFiles(), ...generateManifestFiles(manifest)];
}

export { serializeManifest } from "./manifest-json";
