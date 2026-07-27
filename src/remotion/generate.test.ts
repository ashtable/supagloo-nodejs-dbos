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

  // Task #36 (plan D1): the renderWorkflow downloads every manifest-referenced asset
  // into the workspace `public/` dir, because our S3 buckets are PRIVATE (a bundle-baked
  // remote URL would need a public-read policy or per-object presigned URLs, neither of
  // which a single base URL can express) and because `bundle()` snapshots `public/` INTO
  // the bundle. So the default resolution path is `staticFile()`, with the
  // REMOTION_ASSET_BASE_URL remote origin kept as an explicit opt-in escape hatch.
  //
  // Verified against the pinned 4.0.490 sources: @remotion/bundler copies `<root>/public`
  // to `<outDir>/public` and serves it at `/public`, so the old bare `/${assetKey}`
  // fallback did NOT resolve to a bundled public file.
  it("src/lib/assets.ts resolves assets with staticFile by default", () => {
    const assets = files.get("src/lib/assets.ts") ?? "";
    expect(assets).toContain("export function getAssetUrl");
    expect(assets).toContain("staticFile");
    expect(assets).toContain('from "remotion"');
  });

  it("src/lib/assets.ts keeps REMOTION_ASSET_BASE_URL as an explicit remote override", () => {
    const assets = files.get("src/lib/assets.ts") ?? "";
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

// Task #36: the composition must actually REFERENCE the narration/music tracks, or
// "synthesize audio before bundling" (design-delta §7 workflow 9) is theatre — the audio
// would be snapshotted into the bundle and never played. <Audio> is emitted only when the
// manifest carries the corresponding asset key; the render workflow patches a
// freshly-synthesized track's key into the manifest before re-materializing the sources.
describe("audio tracks in the generated composition (task #36)", () => {
  it("emits <Audio> for a cached music bed", () => {
    const video = fileMap(generateProjectFiles(shelterManifest)).get("src/Video.tsx") ?? "";
    expect(video).toContain("Audio");
    expect(video).toContain("projects/demo/music/bed.mp3");
  });

  it("emits <Audio> for the narrator track when narratorVoice.assetKey is present", () => {
    const withNarration = {
      ...shelterManifest,
      narratorVoice: { ...shelterManifest.narratorVoice, assetKey: "render-audio/narration.wav" },
    };
    const video = fileMap(generateProjectFiles(withNarration)).get("src/Video.tsx") ?? "";
    expect(video).toContain("render-audio/narration.wav");
    expect(video.match(/<Audio/g) ?? []).toHaveLength(2);
  });

  it("emits <Audio> for the shelter fixture's own cached narration ref (item 15)", () => {
    // Since Step-11 item 15 the golden subject itself carries a narration ref, so the golden
    // `Video.tsx` is now a byte-level witness that `canonicalizeManifest` preserves it.
    const video = fileMap(generateProjectFiles(shelterManifest)).get("src/Video.tsx") ?? "";
    expect(video).toContain("projects/demo/narration/full.mp3");
    expect(video.match(/<Audio/g) ?? []).toHaveLength(2);
  });

  it("emits NO <Audio> when the manifest carries neither audio key", () => {
    // BOTH must be stripped now — the shelter fixture carries a narration ref of its own
    // since Step-11 item 15, so dropping only `music` no longer means "neither".
    const noAudio = {
      ...shelterManifest,
      narratorVoice: { description: shelterManifest.narratorVoice.description },
      music: { style: "ambient" },
    };
    const video = fileMap(generateProjectFiles(noAudio)).get("src/Video.tsx") ?? "";
    expect(video).not.toContain("<Audio");
  });

  it("resolves audio through the same getAssetUrl seam as visuals", () => {
    const video = fileMap(generateProjectFiles(shelterManifest)).get("src/Video.tsx") ?? "";
    expect(video).toContain("getAssetUrl");
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

  /**
   * Step-11 item 15 (RX-4 / R4850-7) — `narratorVoice.assetKey` WAS BEING ERASED.
   *
   * `canonicalizeManifest` copied `music.assetKey` and silently dropped
   * `narratorVoice.assetKey`, so every commit rewrote the manifest without the cached
   * narration reference. The consequences are all real spend, not tidiness:
   *
   *   • `templates.ts:216` reads `manifest.narratorVoice.assetKey ?? null`, so the emitted
   *     `Video.tsx` carried no narration `<Audio>` at all — a committed project's narration
   *     was simply not in the video;
   *   • `ensureNarrationAudio` could therefore NEVER see a cached ref, so every render of a
   *     committed version re-synthesized narration through a live TTS provider;
   *   • §10 R8's premise for row 45's published numbers ("use a manifest with cached audio
   *     refs so N costs time, not money") was unsatisfiable for narration.
   *
   * Not a schema decision: db-lib's `VoiceDescriptorSchema` accepts the field,
   * `schemas.test.ts:307` round-trips it, and `render/audio.ts:138` writes it back. It was a
   * canonicalizer omission — the branch for `music` exists ten lines below.
   */
  it("round-trips narratorVoice.assetKey — SYMMETRICALLY with music.assetKey (item 15)", () => {
    const withNarration = ProjectManifestSchema.parse({
      ...shelterManifest,
      narratorVoice: {
        description: "Warm, reverent male narrator",
        label: "Narrator",
        assetKey: "projects/demo/narration/full.mp3",
      },
      music: { style: "ambient cinematic pads", assetKey: "projects/demo/music/bed.mp3" },
    });

    const parsed = ProjectManifestSchema.parse(
      JSON.parse(serializeManifest(withNarration)),
    );

    expect(parsed.narratorVoice.assetKey).toBe("projects/demo/narration/full.mp3");
    // The symmetry is the point — the same statement must hold for both audio beds.
    expect(parsed.music?.assetKey).toBe("projects/demo/music/bed.mp3");
    expect(parsed).toEqual(withNarration);
  });

  it("keeps an explicitly null narration assetKey as null, and omits an absent one", () => {
    // `null` is a real value in this schema (the file header says so), and it is what
    // `render/audio.ts` writes to mean "no cached ref"; `undefined` must stay absent so the
    // canonical bytes do not gain a key.
    const explicitNull = ProjectManifestSchema.parse({
      ...shelterManifest,
      narratorVoice: { description: "N", assetKey: null },
    });
    const json = JSON.parse(serializeManifest(explicitNull)) as {
      narratorVoice: Record<string, unknown>;
    };
    expect("assetKey" in json.narratorVoice).toBe(true);
    expect(json.narratorVoice.assetKey).toBeNull();

    const absent = JSON.parse(
      serializeManifest(
        ProjectManifestSchema.parse({
          ...shelterManifest,
          narratorVoice: { description: "N" },
        }),
      ),
    ) as { narratorVoice: Record<string, unknown> };
    expect("assetKey" in absent.narratorVoice).toBe(false);
  });
});
