import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ProjectManifest } from "@supagloo/database-lib";
import {
  generateManifestFiles,
  generateProjectFiles,
  type GeneratedFile,
} from "./generate";

/**
 * Thin filesystem wrappers around the pure generator. The future DBOS steps
 * (`writeRemotionScaffold` in the scaffold workflow, `applyManifest` in the commit
 * workflow) wrap THESE in `DBOS.runStep` — this task builds only the plain functions.
 */

const SCENES_DIR = "src/scenes";

async function writeFiles(
  targetDir: string,
  files: GeneratedFile[],
): Promise<string[]> {
  for (const file of files) {
    const abs = join(targetDir, file.path);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, file.contents, "utf8");
  }
  return files.map((file) => file.path);
}

/**
 * Initial scaffold: write the FULL project file set (incl. the `remotion.config.ts`
 * marker, package.json, tsconfig, entry, asset helper, and all derived files). The
 * scene dir is created even for a zero-scene project so the layout is always valid.
 */
export async function writeRemotionScaffold(
  manifest: ProjectManifest,
  targetDir: string,
): Promise<{ filesWritten: string[] }> {
  const written = await writeFiles(targetDir, generateProjectFiles(manifest));
  await mkdir(join(targetDir, SCENES_DIR), { recursive: true });
  return { filesWritten: written.sort() };
}

/**
 * Regeneration: a FULL deterministic overwrite of the manifest-derived files from the
 * manifest — the sole source of truth in v1. Hand-edits to generated scene sources
 * are NOT preserved (design-delta §2). Every existing file in `src/scenes/` that the
 * new manifest no longer produces is deleted (a scene removed from the manifest loses
 * its stale `.tsx`); the static files (config/marker/package.json/…) are left
 * untouched. Byte-for-byte idempotent on repeat.
 */
export async function applyManifest(
  manifest: ProjectManifest,
  targetDir: string,
): Promise<{ filesWritten: string[]; removed: string[] }> {
  const files = generateManifestFiles(manifest);
  const nextScenePaths = new Set(
    files
      .filter((file) => file.path.startsWith(`${SCENES_DIR}/`))
      .map((file) => file.path),
  );

  const scenesAbs = join(targetDir, SCENES_DIR);
  await mkdir(scenesAbs, { recursive: true });
  const existing = await readdir(scenesAbs);
  const removed: string[] = [];
  for (const name of existing) {
    const rel = `${SCENES_DIR}/${name}`;
    if (!nextScenePaths.has(rel)) {
      await rm(join(scenesAbs, name), { force: true, recursive: true });
      removed.push(rel);
    }
  }

  const written = await writeFiles(targetDir, files);
  return { filesWritten: written.sort(), removed: removed.sort() };
}
