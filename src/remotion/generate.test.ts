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

// ===========================================================================
// Render-bug work: per-scene narration sync, music coverage, Ken Burns.
// The fixture below is a small manifest carrying every new manifest field, so the
// three claims are asserted against generated SOURCE rather than against prose.
// ===========================================================================

const richManifest = {
  manifestVersion: 1 as const,
  composition: { width: 320, height: 180, fps: 10, aspectRatio: "16:9" },
  scenes: [
    {
      id: "sc-1",
      name: "Alpha",
      scriptText: "In the beginning God created the heaven and the earth.",
      reference: "Genesis 1:1",
      translation: "KJV",
      visualPrompt: "a formless void",
      durationSeconds: 2,
      captions: true,
      visualAssetKey: "projects/p/assets/img-1",
      narrationAssetKey: "projects/p/assets/gen-1-scene-sc-1",
      narrationDurationSeconds: 1.5,
    },
    {
      id: "sc-2",
      name: "Beta",
      scriptText: "And the earth was without form, and void.",
      reference: "Genesis 1:2",
      translation: "KJV",
      visualPrompt: "dark waters",
      // Authored 2s but the narration measured 3.4s — the scene must STRETCH.
      durationSeconds: 2,
      captions: true,
      visualAssetKey: "projects/p/assets/img-2",
      narrationAssetKey: "projects/p/assets/gen-1-scene-sc-2",
      narrationDurationSeconds: 3.4,
    },
    {
      id: "sc-3",
      name: "Gamma",
      scriptText: "And God said, Let there be light.",
      reference: "Genesis 1:3",
      translation: "KJV",
      visualPrompt: "first light",
      durationSeconds: 2,
      captions: false,
      visualAssetKey: "projects/p/assets/clip-3",
      visualAssetKind: "video" as const,
    },
  ],
  narratorVoice: { description: "Warm narrator" },
  music: {
    style: "ambient pads",
    assetKey: "projects/p/assets/music-1",
    durationSeconds: 3, // deliberately SHORTER than the 8.4s composition
  },
};

describe("bug 1 — narration is mounted per scene, inside that scene's own Sequence", () => {
  const files = fileMap(generateManifestFiles(richManifest));
  const video = files.get("src/Video.tsx") as string;

  it("U-T1: each scene's narration <Audio> sits INSIDE its own <Sequence>", () => {
    // The shipped composition mounted ONE whole-project <Audio> at frame 0, outside every
    // <Sequence>. There was no sync mechanism of any kind: scene 3's verse could be playing
    // over scene 1's picture. Nesting the audio inside the Sequence IS the sync.
    for (const [seq, constName, key] of [
      ["Alpha", "alphaNarration", "projects/p/assets/gen-1-scene-sc-1"],
      ["Beta", "betaNarration", "projects/p/assets/gen-1-scene-sc-2"],
    ]) {
      const start = video.indexOf(`<Sequence name="${seq}"`);
      const block = video.slice(start, video.indexOf("</Sequence>", start));
      expect(block, `${seq} sequence body`).toContain("<Audio");
      expect(block, `${seq} sequence body`).toContain(`src={${constName}Src}`);
      // ...and that binding really resolves to THAT scene's asset, not another's.
      expect(video).toContain(`const ${constName}Key = ${JSON.stringify(key)};`);
      expect(video).toContain(
        `  const ${constName}Src = getAssetUrl(${constName}Key);`,
      );
    }
    // Nothing is mounted at frame 0 outside a Sequence — that was the whole bug.
    const preamble = video.slice(
      video.indexOf('<AbsoluteFill style={{ backgroundColor: "#000000" }}>'),
      video.indexOf("<Sequence"),
    );
    expect(preamble).not.toContain("Narration");
  });

  it("U-T2: a scene with no narration key gets no narration <Audio>", () => {
    const block = video.slice(
      video.indexOf('<Sequence name="Gamma"'),
      video.indexOf("</Sequence>", video.indexOf('<Sequence name="Gamma"')),
    );
    expect(block).not.toContain("Narration");
  });

  it("U-T3: the scene STRETCHES to fit a narration longer than its authored duration", () => {
    // sc-2 is authored at 2s (=20 frames) but its narration measured 3.4s (=34 frames).
    // Cutting the verse off mid-sentence is the bug; the scene grows instead.
    expect(video).toContain('<Sequence name="Beta" from={20} durationInFrames={34}>');
    // ...and everything after it shifts, so the timeline stays contiguous.
    expect(video).toContain('<Sequence name="Gamma" from={54} durationInFrames={20}>');
    // Total = 20 + 34 + 20 = 74 frames, not the naive 60.
    expect(files.get("src/Root.tsx")).toContain("durationInFrames={74}");
  });

  it("U-T4: a v1 manifest with only the whole-project narratorVoice.assetKey is unchanged", () => {
    // Backward compatibility: manifests committed before per-scene narration existed must
    // keep emitting exactly the whole-video <Audio> they emit today.
    const legacy = fileMap(generateManifestFiles(shelterManifest)).get(
      "src/Video.tsx",
    ) as string;
    // The emitted LINE, not a substring of the const NAME. `toContain("narrationAssetKey")`
    // was satisfied by `const narrationAssetKey = …` and would have stayed green through any
    // change to how (or whether) that key is actually mounted.
    expect(legacy).toContain(
      "{narrationAssetKeySrc ? <Audio src={narrationAssetKeySrc} /> : null}",
    );
    // ...and it is the WHOLE-VIDEO track: emitted before the first <Sequence>.
    expect(legacy.indexOf("narrationAssetKeySrc ? <Audio")).toBeLessThan(
      legacy.indexOf("<Sequence"),
    );
    // ...with no per-scene narration const anywhere. Per-scene consts are named
    // `${lowerFirst(component)}NarrationKey` (templates.ts), so this is the discriminator
    // that a v1 manifest did not silently acquire the new per-scene shape.
    expect(legacy).not.toMatch(/NarrationKey/);
  });
});

describe("bug 2 — the music bed covers the whole composition", () => {
  const files = fileMap(generateManifestFiles(richManifest));
  const video = files.get("src/Video.tsx") as string;

  it("U-T5: a measured music length shorter than the video is LOOPED to cover it", () => {
    // Remotion's <Loop> fills `ceil(compositionDuration / durationInFrames)` iterations and
    // the composition end trims the last one, so this is coverage AND trim in one.
    // 3s at 10fps = 30 frames per iteration, over a 74-frame composition.
    expect(video).toContain("<Loop durationInFrames={30}>");
    expect(video).toContain("musicAssetKeySrc");
  });

  it("U-T6: the bed fades out at the END OF THE VIDEO, not at the end of each loop", () => {
    // `loopVolumeCurveBehavior="extend"` makes the volume callback's frame a COMPOSITION
    // frame (verified in remotion 4.0.490 `useFrameForVolumeProp`, which adds
    // `loop.durationInFrames * loop.iteration`). Without it the fade would re-run every
    // single loop iteration, ducking the bed repeatedly through the video.
    expect(video).toContain('loopVolumeCurveBehavior="extend"');
    expect(video).toContain("volume={(f) =>");
    expect(video).toContain("[59, 74]"); // last 1.5s of the 74-frame composition
  });

  it("U-T7: with NO measured duration the bed stays a plain <Audio> (no guessing)", () => {
    // A v1 manifest has no measured length. Emitting a <Loop> would require inventing an
    // iteration length, which would mis-time the bed. Old behaviour is the honest fallback.
    const noDuration = {
      ...richManifest,
      music: { style: "ambient pads", assetKey: "projects/p/assets/music-1" },
    };
    const v = fileMap(generateManifestFiles(noDuration)).get("src/Video.tsx") as string;
    expect(v).toContain("musicAssetKeySrc");
    expect(v).not.toContain("<Loop");
  });
});

describe("bug 3 — Ken Burns on stills, OffthreadVideo on clips", () => {
  const files = fileMap(generateManifestFiles(richManifest));

  it("U-T8: a still scene pans and zooms over its own frame count", () => {
    const alpha = files.get("src/scenes/Alpha.tsx") as string;
    expect(alpha).toContain("<Img");
    expect(alpha).toContain("scale: interpolate(");
    expect(alpha).toContain("translate: interpolate(");
    // Normalized over the scene's OWN frame count, so the motion completes exactly once per
    // scene whatever its length. sc-1 is authored at 2s and its narration measured 1.5s, so
    // it does NOT stretch: effective 2s × 10fps = 20 frames.
    expect(alpha).toContain("[0, 20]");
  });

  it("U-T9: the pan variant is derived from the scene INDEX, never from randomness", () => {
    // The generator is required to be deterministic and is pinned byte-for-byte by goldens.
    // Any wall-clock or Math.random input would make the goldens unmaintainable and the
    // render non-reproducible.
    const a = generateManifestFiles(richManifest);
    const b = generateManifestFiles(richManifest);
    expect(a).toEqual(b);
    const alpha = files.get("src/scenes/Alpha.tsx") as string;
    const beta = files.get("src/scenes/Beta.tsx") as string;
    // Adjacent scenes get different motion so a cut never looks like a continuation. The
    // VALUES are asserted, not merely that the two files differ — Alpha.tsx and Beta.tsx also
    // differ in component name, scriptText, reference, visualAssetKey and frame count, so
    // `expect(alpha).not.toBe(beta)` was satisfied even if both scenes used variant 0.
    //
    // BOTH scale and translate, deliberately: variants 0 and 2 share `["1", "1.1"]`, so a
    // scale-only assertion would survive an `index % 2` regression. Alpha is index 0 (20
    // frames, pinned by U-T8), Beta is index 1 (34 frames, pinned by U-T3).
    expect(alpha).toContain('scale: interpolate(frame, [0, 20], ["1", "1.1"]');
    expect(alpha).toContain('translate: interpolate(frame, [0, 20], ["0% 0%", "1.5% 1%"]');
    expect(beta).toContain('scale: interpolate(frame, [0, 34], ["1.1", "1"]');
    expect(beta).toContain(
      'translate: interpolate(frame, [0, 34], ["-1.5% -1%", "0% 0%"]',
    );
    for (const src of [alpha, beta]) {
      expect(src).not.toContain("Math.random");
      expect(src).not.toContain("Date.now");
    }
  });

  it("U-T10: a VIDEO-kind asset renders through <OffthreadVideo> and gets NO pan", () => {
    // Latent second bug: before the manifest could distinguish a still from a clip, EVERY
    // visual — including a generated video — went through <Img>, which renders a single
    // frame of it at best.
    //
    // SCOPE OF THIS TEST, stated plainly: it drives `visualAssetKind: "video"` EXPLICITLY
    // via the fixture. Nothing in this suite — or anywhere else — asserts that the field is
    // ever POPULATED, because no producer writes it: it is read here and in the nextjs
    // preview, and plumbed through all four schema mirrors, but `setSceneVisual` /
    // `IMAGE_GENERATED` write only `visualAssetKey`. So this makes closing the latent bug
    // possible; it does not close it. A generated video asset is still rendered through
    // <Img> in production until a producer sets the kind.
    const gamma = files.get("src/scenes/Gamma.tsx") as string;
    expect(gamma).toContain("<OffthreadVideo");
    expect(gamma).not.toContain("<Img");
    expect(gamma).not.toContain("scale: interpolate(");
  });

  it("U-T11: an absent visualAssetKind still means IMAGE (v1 manifests keep working)", () => {
    const shelter = fileMap(generateManifestFiles(shelterManifest));
    expect(shelter.get("src/scenes/Shelter.tsx")).toContain("<Img");
  });
});

describe("canonicalizeManifest symmetry for the new fields", () => {
  it("U-T12: every new field survives a serialize→parse round trip", () => {
    // The invariant `manifest-json.ts` already records in prose: a field the generator
    // reads but `canonicalizeManifest` does not write is silently ERASED on every commit.
    // That regression already happened once, to narratorVoice.assetKey.
    const json = fileMap(generateManifestFiles(richManifest)).get(
      "supagloo.project.json",
    ) as string;
    const parsed = ProjectManifestSchema.safeParse(JSON.parse(json));
    expect(parsed.success, JSON.stringify(parsed)).toBe(true);
    if (parsed.success) expect(parsed.data).toEqual(richManifest);
  });
});
