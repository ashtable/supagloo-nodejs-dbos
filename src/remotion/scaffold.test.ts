import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyManifest, writeRemotionScaffold } from "./scaffold";
import {
  emptyManifest,
  minimalManifest,
  shelterManifest,
} from "./__fixtures__/manifests";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "supagloo-scaffold-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function read(rel: string): string {
  return readFileSync(join(dir, rel), "utf8");
}

describe("writeRemotionScaffold (initial full scaffold)", () => {
  it("writes the Supagloo-project marker files and scene sources", async () => {
    const { filesWritten } = await writeRemotionScaffold(shelterManifest, dir);

    // remotion.config.ts at repo root is the verifySupaglooProject marker.
    expect(existsSync(join(dir, "remotion.config.ts"))).toBe(true);
    expect(existsSync(join(dir, "supagloo.project.json"))).toBe(true);
    expect(existsSync(join(dir, "src", "index.ts"))).toBe(true);
    expect(existsSync(join(dir, "src", "scenes", "Shelter.tsx"))).toBe(true);
    expect(existsSync(join(dir, "src", "scenes", "Refuge.tsx"))).toBe(true);

    expect(filesWritten).toContain("remotion.config.ts");
    expect(filesWritten).toContain("supagloo.project.json");
    expect(filesWritten).toContain("src/scenes/Shelter.tsx");
  });

  it("is idempotent — writing twice yields byte-identical files", async () => {
    await writeRemotionScaffold(shelterManifest, dir);
    const first = read("src/scenes/Shelter.tsx");
    const firstJson = read("supagloo.project.json");

    await writeRemotionScaffold(shelterManifest, dir);
    expect(read("src/scenes/Shelter.tsx")).toBe(first);
    expect(read("supagloo.project.json")).toBe(firstJson);
  });

  it("scaffolds a valid empty (zero-scene) project", async () => {
    await writeRemotionScaffold(emptyManifest, dir);
    expect(existsSync(join(dir, "remotion.config.ts"))).toBe(true);
    // No scene files, but the composition body still exists.
    expect(readdirSync(join(dir, "src", "scenes"))).toEqual([]);
    expect(existsSync(join(dir, "src", "Video.tsx"))).toBe(true);
  });
});

describe("applyManifest (regeneration = full scene-dir overwrite)", () => {
  it("overwrites scene sources and deletes stale ones removed from the manifest", async () => {
    await writeRemotionScaffold(shelterManifest, dir);
    expect(readdirSync(join(dir, "src", "scenes")).sort()).toEqual([
      "Refuge.tsx",
      "Shelter.tsx",
    ]);

    // Regenerate from a 1-scene manifest ("Intro"): Shelter/Refuge must vanish.
    const { removed } = await applyManifest(minimalManifest, dir);
    expect(readdirSync(join(dir, "src", "scenes"))).toEqual(["Intro.tsx"]);
    expect(removed).toContain("src/scenes/Shelter.tsx");
    expect(removed).toContain("src/scenes/Refuge.tsx");

    // Static files (marker/config) are left untouched by applyManifest.
    expect(existsSync(join(dir, "remotion.config.ts"))).toBe(true);
    // The canonical manifest is rewritten to the new manifest.
    expect(read("supagloo.project.json")).toContain('"Intro"');
  });

  it("is idempotent — re-applying the same manifest yields identical files", async () => {
    await writeRemotionScaffold(shelterManifest, dir);
    await applyManifest(minimalManifest, dir);
    const scene = read("src/scenes/Intro.tsx");
    const root = read("src/Root.tsx");

    await applyManifest(minimalManifest, dir);
    expect(read("src/scenes/Intro.tsx")).toBe(scene);
    expect(read("src/Root.tsx")).toBe(root);
    expect(readdirSync(join(dir, "src", "scenes"))).toEqual(["Intro.tsx"]);
  });
});
