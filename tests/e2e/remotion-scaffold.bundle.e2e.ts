import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { bundle } from "@remotion/bundler";
import {
  writeRemotionScaffold,
  type GeneratedFile,
} from "../../src/remotion";
import {
  emptyManifest,
  shelterManifest,
} from "../../src/remotion/__fixtures__/manifests";

// End-to-end proof that a generated Remotion project actually BUNDLES with
// @remotion/bundler — the real esbuild/webpack static build, NO render, NO browser
// (that's @remotion/renderer, out of scope). No DB/DBOS/Postgres: this runs under
// the dedicated vitest.e2e.bundle.config.ts (no globalSetup). Non-UI → no Playwright.

// The scaffold is written to an os-tmp dir OUTSIDE the repo tree, so webpack cannot
// resolve `remotion`/`react` by walking up. We point resolve.modules at the dbos
// repo's own node_modules (where the pinned deps are installed).
const REPO_NODE_MODULES = resolve(__dirname, "..", "..", "node_modules");

const tempDirs: string[] = [];

function scaffoldDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "supagloo-remotion-bundle-"));
  tempDirs.push(dir);
  return dir;
}

async function bundleProject(dir: string): Promise<string> {
  return bundle({
    entryPoint: join(dir, "src", "index.ts"),
    webpackOverride: (config) => ({
      ...config,
      resolve: {
        ...config.resolve,
        modules: [REPO_NODE_MODULES, "node_modules"],
      },
    }),
  });
}

afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

describe("generated Remotion project bundles with @remotion/bundler", () => {
  it("scaffolds and bundles a populated (multi-scene) manifest, no render", async () => {
    const dir = scaffoldDir();
    const { filesWritten } = await writeRemotionScaffold(shelterManifest, dir);

    // Scaffold markers land on disk before bundling.
    expect(existsSync(join(dir, "remotion.config.ts"))).toBe(true);
    expect(existsSync(join(dir, "src", "index.ts"))).toBe(true);
    expect(existsSync(join(dir, "supagloo.project.json"))).toBe(true);
    expect(filesWritten).toContain("src/scenes/Shelter.tsx");

    const out = await bundleProject(dir);
    expect(typeof out).toBe("string");
    expect(out.length).toBeGreaterThan(0);
    expect(statSync(out).isDirectory()).toBe(true);
  }, 240_000);

  it("scaffolds and bundles a zero-scene manifest (fresh project), no render", async () => {
    const dir = scaffoldDir();
    await writeRemotionScaffold(emptyManifest, dir);

    const out = await bundleProject(dir);
    expect(statSync(out).isDirectory()).toBe(true);
  }, 240_000);
});

// Type-only touch so an unused import doesn't get pruned by tooling.
export type _BundleFile = GeneratedFile;
