import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ProjectManifestSchema } from "@supagloo/database-lib";
import {
  generateManifestFiles,
  generateProjectFiles,
  serializeManifest,
  type GeneratedFile,
} from "./generate";
import { REACT_VERSION, REMOTION_VERSION } from "./versions";
import {
  emptyManifest,
  minimalManifest,
  shelterManifest,
} from "./__fixtures__/manifests";

const GOLDEN_DIR = join(__dirname, "__golden__", "shelter");

function fileMap(files: GeneratedFile[]): Map<string, string> {
  return new Map(files.map((f) => [f.path, f.contents]));
}

function golden(relPath: string): string {
  // Golden files carry a `.golden` suffix so they never match the tsconfig
  // (`src/**/*.ts`) or unit-test (`src/**/*.test.ts`) globs.
  return readFileSync(join(GOLDEN_DIR, `${relPath}.golden`), "utf8");
}

const FULL_PATHS = [
  ".gitignore",
  "package.json",
  "remotion.config.ts",
  "src/Root.tsx",
  "src/Video.tsx",
  "src/index.ts",
  "src/lib/assets.ts",
  "src/scenes/Refuge.tsx",
  "src/scenes/Shelter.tsx",
  "supagloo.project.json",
  "tsconfig.json",
];

const DERIVED_PATHS = [
  "src/Root.tsx",
  "src/Video.tsx",
  "src/scenes/Refuge.tsx",
  "src/scenes/Shelter.tsx",
  "supagloo.project.json",
];

describe("generateProjectFiles — exact file set", () => {
  it("emits exactly the full scaffold path set for the shelter fixture", () => {
    const paths = generateProjectFiles(shelterManifest)
      .map((f) => f.path)
      .sort();
    expect(paths).toEqual([...FULL_PATHS].sort());
  });

  it("emits deterministic output (idempotent, pure)", () => {
    expect(generateProjectFiles(shelterManifest)).toEqual(
      generateProjectFiles(shelterManifest),
    );
  });
});

describe("generateProjectFiles — golden derived files (shelter fixture)", () => {
  const files = fileMap(generateProjectFiles(shelterManifest));

  for (const relPath of DERIVED_PATHS) {
    it(`emits ${relPath} byte-for-byte per golden`, () => {
      expect(files.get(relPath)).toBe(golden(relPath));
    });
  }

  it("duration math: Root=360 frames total, scenes=150/210", () => {
    expect(files.get("src/Root.tsx")).toContain("durationInFrames={360}");
    expect(files.get("src/Video.tsx")).toContain("durationInFrames={150}");
    expect(files.get("src/Video.tsx")).toContain("durationInFrames={210}");
  });
});

describe("generateProjectFiles — static file spec checks", () => {
  const files = fileMap(generateProjectFiles(shelterManifest));

  it("remotion.config.ts is the project marker and configures Remotion", () => {
    const cfg = files.get("remotion.config.ts") ?? "";
    expect(cfg).toContain('from "@remotion/cli/config"');
    expect(cfg).toContain("Config.");
  });

  it("src/index.ts registers the root composition", () => {
    expect(files.get("src/index.ts")).toContain("registerRoot(RemotionRoot)");
  });

  it("src/lib/assets.ts exports getAssetUrl over REMOTION_ASSET_BASE_URL", () => {
    const assets = files.get("src/lib/assets.ts") ?? "";
    expect(assets).toContain("export function getAssetUrl");
    expect(assets).toContain("REMOTION_ASSET_BASE_URL");
  });

  it("package.json pins the exact remotion/react versions", () => {
    const pkg = JSON.parse(files.get("package.json") ?? "{}");
    expect(pkg.dependencies.remotion).toBe(REMOTION_VERSION);
    expect(pkg.dependencies["@remotion/cli"]).toBe(REMOTION_VERSION);
    expect(pkg.dependencies.react).toBe(REACT_VERSION);
    expect(pkg.dependencies["react-dom"]).toBe(REACT_VERSION);
  });
});

describe("generateManifestFiles — the regeneration subset", () => {
  it("emits exactly the manifest-derived files (no static files)", () => {
    const paths = generateManifestFiles(shelterManifest)
      .map((f) => f.path)
      .sort();
    expect(paths).toEqual([...DERIVED_PATHS].sort());
  });

  it("derived files are byte-identical to the full scaffold (one code path)", () => {
    const full = fileMap(generateProjectFiles(shelterManifest));
    for (const f of generateManifestFiles(shelterManifest)) {
      expect(f.contents).toBe(full.get(f.path));
    }
  });
});

describe("empty-scenes manifest (freshly scaffolded project)", () => {
  const files = fileMap(generateProjectFiles(emptyManifest));

  it("emits no scene sources", () => {
    const scenePaths = [...files.keys()].filter((p) =>
      p.startsWith("src/scenes/"),
    );
    expect(scenePaths).toEqual([]);
  });

  it("Video uses AbsoluteFill (no Series) and Root duration is clamped >= 1", () => {
    expect(files.get("src/Video.tsx")).toContain("AbsoluteFill");
    expect(files.get("src/Video.tsx")).not.toContain("Series");
    expect(files.get("src/Root.tsx")).toContain("durationInFrames={1}");
  });
});

describe("supagloo.project.json round-trips ProjectManifestSchema", () => {
  for (const [label, manifest] of [
    ["shelter", shelterManifest],
    ["empty", emptyManifest],
    ["minimal", minimalManifest],
  ] as const) {
    it(`${label}: emitted json parses and equals the input manifest`, () => {
      const json = serializeManifest(manifest);
      const parsed = ProjectManifestSchema.parse(JSON.parse(json));
      expect(parsed).toEqual(ProjectManifestSchema.parse(manifest));
    });
  }

  it("serialization is canonical/deterministic (idempotent)", () => {
    expect(serializeManifest(shelterManifest)).toBe(
      serializeManifest(shelterManifest),
    );
    // Re-serializing the parsed output reproduces the same bytes (round-trip stable).
    const once = serializeManifest(shelterManifest);
    const twice = serializeManifest(ProjectManifestSchema.parse(JSON.parse(once)));
    expect(twice).toBe(once);
  });
});
