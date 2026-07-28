import {
  effectiveSceneDurationSeconds,
  type ManifestScene,
  type ProjectManifest,
} from "@supagloo/database-lib";
import type { AssignedScene } from "./naming";
import { REACT_VERSION, REMOTION_VERSION } from "./versions";

/**
 * Pure template builders: functions that turn a validated manifest (and its assigned
 * scene names) into the exact text of each generated file. NO filesystem I/O — the
 * scaffold layer writes these bytes. Golden tests (src/remotion/__golden__) pin the
 * derived-file output byte-for-byte.
 *
 * Every generated file ends with exactly one trailing newline. String values baked
 * into sources go through JSON.stringify so arbitrary manifest text (quotes,
 * newlines, unicode) is always safely escaped.
 */

// ── frame math ──────────────────────────────────────────────────────────────

/** durationSeconds × fps → whole frames, clamped ≥ 1 (Remotion needs positive). */
export function frameCount(durationSeconds: number, fps: number): number {
  return Math.max(1, Math.round(durationSeconds * fps));
}

/**
 * How many frames a scene occupies — the ONE place the render turns a scene into a length.
 *
 * Goes through `effectiveSceneDurationSeconds`, so a scene whose measured narration is
 * longer than its authored `durationSeconds` STRETCHES rather than cutting the verse off
 * mid-sentence. Scene lengths originate in the LLM's `suggestedDurationSeconds`, which has
 * no relationship at all to how long the text takes to read aloud.
 */
export function sceneFrames(scene: ManifestScene, fps: number): number {
  return frameCount(effectiveSceneDurationSeconds(scene), fps);
}

/** Total composition length = Σ per-scene frames, clamped ≥ 1 (zero-scene → 1). */
export function totalFrames(manifest: ProjectManifest): number {
  const sum = manifest.scenes.reduce(
    (acc, scene) => acc + sceneFrames(scene, manifest.composition.fps),
    0,
  );
  return Math.max(1, sum);
}

/** How long the music bed fades out for at the end of the video. */
const MUSIC_FADE_SECONDS = 1.5;
/** The music bed's level under the narration. Matches the studio preview. */
const MUSIC_VOLUME = 0.4;

/**
 * Ken Burns motion, indexed by the scene's position (plan D8).
 *
 * Determinism is a hard requirement, not a preference: the generator is pure and is pinned
 * byte-for-byte by goldens, and `materializeRenderSources` re-runs it at render time — so a
 * `Math.random()` or a wall-clock read would make the goldens unmaintainable AND make two
 * renders of the same commit differ. Deriving the variant from the index gives per-scene
 * variety (a cut never looks like a continuation of the previous move) with none of that.
 *
 * Over-scan is deliberately modest: at most 1.10 scale with a ≤1.5% drift, so the image
 * always covers the frame and never letterboxes. This costs no extra decode memory —
 * `<Img>` decodes at the source's natural size regardless, and `scale`/`translate` are
 * compositing operations — so `render-sizing.md`'s (320×180-derived) budget is unaffected.
 *
 * `scale` MUST be emitted as a STRING. React's `isUnitlessNumber` table does not contain
 * `scale`, so a numeric value renders as `scale:1.1px` — invalid CSS, and the pan silently
 * does nothing. Verified with react-dom 18.3.1 directly.
 */
const KEN_BURNS: ReadonlyArray<{
  scale: [string, string];
  translate: [string, string];
}> = [
  { scale: ["1", "1.1"], translate: ["0% 0%", "1.5% 1%"] },
  { scale: ["1.1", "1"], translate: ["-1.5% -1%", "0% 0%"] },
  { scale: ["1", "1.1"], translate: ["0% 0%", "-1.5% 1%"] },
  { scale: ["1.1", "1"], translate: ["1.5% -1%", "0% 0%"] },
];

/** `["a","b"]` → `["a", "b"]` — matches the spacing of every other emitted literal. */
function jsxArray(values: readonly string[]): string {
  return `[${values.map((v) => JSON.stringify(v)).join(", ")}]`;
}

/** `Alpha` → `alpha`. Component names are already unique valid identifiers, and they are
 *  sanitized to start with an upper-case letter, so lower-casing the first char preserves
 *  uniqueness. Used to derive per-scene narration const names. */
function lowerFirst(name: string): string {
  return name.charAt(0).toLowerCase() + name.slice(1);
}

// ── static files (manifest-independent) ─────────────────────────────────────

/**
 * `remotion.config.ts` at repo root is the "is this a Supagloo project" marker
 * (design-delta workflow 2, verifySupaglooProject). bundle() never reads it (that's
 * the CLI), so the `@remotion/cli/config` import — not installed in dbos — is inert
 * during bundling; it exists for users running Remotion Studio/CLI on the project.
 */
export function buildRemotionConfig(): string {
  return [
    "// Supagloo-generated Remotion config — DO NOT EDIT.",
    "// Presence of this file at the repo root marks a Supagloo project.",
    'import { Config } from "@remotion/cli/config";',
    "",
    'Config.setVideoImageFormat("jpeg");',
    "Config.setOverwriteOutput(true);",
    "",
  ].join("\n");
}

/** Standalone, installable Remotion project package.json (versions stamped in). */
export function buildPackageJson(): string {
  const pkg = {
    name: "supagloo-remotion-project",
    version: "1.0.0",
    private: true,
    license: "UNLICENSED",
    scripts: {
      dev: "remotion studio",
      render: "remotion render",
      bundle: "remotion bundle",
      upgrade: "remotion upgrade",
    },
    dependencies: {
      "@remotion/cli": REMOTION_VERSION,
      react: REACT_VERSION,
      "react-dom": REACT_VERSION,
      remotion: REMOTION_VERSION,
    },
    devDependencies: {
      "@types/react": "18.3.12",
      "@types/react-dom": "18.3.1",
      typescript: "5.7.2",
    },
  };
  return `${JSON.stringify(pkg, null, 2)}\n`;
}

export function buildTsconfig(): string {
  const tsconfig = {
    compilerOptions: {
      target: "ESNext",
      module: "ESNext",
      moduleResolution: "bundler",
      jsx: "react-jsx",
      strict: true,
      esModuleInterop: true,
      skipLibCheck: true,
      forceConsistentCasingInFileNames: true,
      noEmit: true,
    },
    include: ["src"],
  };
  return `${JSON.stringify(tsconfig, null, 2)}\n`;
}

export function buildGitignore(): string {
  return [
    "# Supagloo-generated. Media assets live in S3 (referenced by key), never in git.",
    "node_modules",
    "out",
    "build",
    ".remotion",
    ".env",
    ".env.*",
    "",
  ].join("\n");
}

/** Remotion entry point: registerRoot(RemotionRoot). */
export function buildIndexSource(): string {
  return [
    "// Supagloo-generated entry point — DO NOT EDIT.",
    'import { registerRoot } from "remotion";',
    'import { RemotionRoot } from "./Root";',
    "",
    "registerRoot(RemotionRoot);",
    "",
  ].join("\n");
}

/**
 * Asset-key → URL resolver: the single documented seam between manifest asset keys and
 * media URLs.
 *
 * Assets live in S3 (design-delta §2), referenced by key, never committed. Task #36's
 * `renderWorkflow` DOWNLOADS every referenced object into the project's `public/`
 * directory before bundling, so the DEFAULT resolution is `staticFile(assetKey)` — the
 * asset key's `/`-separated shape simply becomes subdirectories under `public/`, which
 * `staticFile()` handles (it splits on `/` and encodes each segment).
 *
 * Why local files and not a remote URL (plan D1): our S3 buckets are PRIVATE, so a
 * bundle-baked remote URL would need either a public-read bucket policy (a security
 * regression) or per-object presigned URLs (which a single base URL cannot express). And
 * `bundle()` SNAPSHOTS `public/` into the bundle — verified in @remotion/bundler 4.0.490,
 * which copies `<root>/public` to `<outDir>/public` and serves it at `/public` — which is
 * exactly why the design requires audio to be synthesized BEFORE bundling.
 *
 * `REMOTION_ASSET_BASE_URL` remains as an explicit opt-in override for anyone serving
 * assets from a reachable origin (Remotion exposes every `REMOTION_`-prefixed env var to
 * the composition via `process.env`). The render workflow deliberately leaves it unset.
 */
export function buildAssetsSource(): string {
  return [
    "// Supagloo-generated asset resolver — DO NOT EDIT.",
    'import { staticFile } from "remotion";',
    "",
    "export function getAssetUrl(",
    "  assetKey: string | null | undefined,",
    "): string | null {",
    "  if (!assetKey) {",
    "    return null;",
    "  }",
    "  // Explicit remote-origin override (opt-in).",
    '  const base = (process.env.REMOTION_ASSET_BASE_URL ?? "").replace(/\\/+$/, "");',
    "  if (base) {",
    "    return `${base}/${assetKey}`;",
    "  }",
    "  // Default: the asset was materialized into public/ before the bundle was built.",
    "  return staticFile(assetKey);",
    "}",
    "",
  ].join("\n");
}

// ── derived files (manifest-dependent) ──────────────────────────────────────

/** `src/Root.tsx`: one <Composition id="Main"> registering the whole video. */
export function buildRootSource(manifest: ProjectManifest): string {
  const { fps, width, height } = manifest.composition;
  return [
    "// Supagloo-generated Remotion root — DO NOT EDIT.",
    "// Regenerated from supagloo.project.json.",
    'import { Composition } from "remotion";',
    'import { VideoComposition } from "./Video";',
    "",
    "export const RemotionRoot = () => {",
    "  return (",
    "    <Composition",
    '      id="Main"',
    "      component={VideoComposition}",
    `      durationInFrames={${totalFrames(manifest)}}`,
    `      fps={${fps}}`,
    `      width={${width}}`,
    `      height={${height}}`,
    "    />",
    "  );",
    "};",
    "",
  ].join("\n");
}

/**
 * `src/Video.tsx`: <AbsoluteFill> wrapping one named <Sequence> per scene with a
 * cumulative `from` offset (best-practices pattern — named sequences give a labeled
 * Studio timeline). Zero scenes → a plain <AbsoluteFill> (still bundles); the token
 * `Series` never appears.
 */
export function buildVideoSource(
  manifest: ProjectManifest,
  assigned: AssignedScene[],
): string {
  const header = [
    "// Supagloo-generated composition body — DO NOT EDIT.",
    "// Regenerated from supagloo.project.json.",
  ];

  // Task #36: the whole-video audio beds. Emitted ONLY when the manifest carries the
  // corresponding asset key, because that key is what `getAssetUrl` resolves. This is the
  // half that makes "synthesize audio BEFORE bundling" (design-delta §7 workflow 9)
  // meaningful — without a reference in the composition, an audio file snapshotted into
  // the bundle is never played. The render workflow patches a freshly-synthesized track's
  // (workspace-local) key into the manifest and re-materializes these sources, so both the
  // cached-ref and the synthesized-fallback paths land here identically.
  const { fps } = manifest.composition;
  const total = totalFrames(manifest);

  // PER-SCENE NARRATION (bug 1, second half). The shipped composition mounted ONE
  // whole-project narration <Audio> at frame 0, OUTSIDE every <Sequence>, while scene
  // lengths came from the LLM's suggested durations — so there was no sync mechanism of any
  // kind and scene 3's verse could play over scene 1's picture. Mounting each scene's clip
  // inside that scene's own <Sequence> IS the sync: Remotion starts a nested media element
  // when its Sequence starts.
  const narrationScenes = assigned
    .map((a) => ({
      assigned: a,
      key: a.scene.narrationAssetKey ?? null,
      constName: `${lowerFirst(a.component)}Narration`,
    }))
    .filter((n): n is typeof n & { key: string } => Boolean(n.key));

  // The whole-video narration track is the BACKWARD-COMPATIBLE fallback: manifests
  // committed before per-scene narration existed carry only `narratorVoice.assetKey`, and
  // must keep rendering exactly as they do today. Once any scene has its own clip the
  // whole-video track would double up, so it yields.
  const legacyNarrationKey =
    narrationScenes.length === 0 ? (manifest.narratorVoice.assetKey ?? null) : null;
  const musicKey = manifest.music?.assetKey ?? null;
  // Only a MEASURED length can drive a loop. Absent (every v1 manifest) ⇒ the plain <Audio>
  // this file already emitted — old behaviour is the honest fallback, whereas inventing an
  // iteration length would mis-time the bed on every render.
  const musicLoopFrames = manifest.music?.durationSeconds
    ? frameCount(manifest.music.durationSeconds, fps)
    : null;
  const musicLoops = musicLoopFrames !== null && musicLoopFrames < total;

  const topLevelKeys: Array<{ name: string; key: string }> = [];
  if (legacyNarrationKey) {
    topLevelKeys.push({ name: "narrationAssetKey", key: legacyNarrationKey });
  }
  if (musicKey) topLevelKeys.push({ name: "musicAssetKey", key: musicKey });

  const hasAudio = topLevelKeys.length > 0 || narrationScenes.length > 0;

  if (assigned.length === 0 && !hasAudio) {
    return [
      ...header,
      'import { AbsoluteFill } from "remotion";',
      "",
      "export const VideoComposition = () => {",
      '  return <AbsoluteFill style={{ backgroundColor: "#000000" }} />;',
      "};",
      "",
    ].join("\n");
  }

  const audioConsts = [
    ...topLevelKeys.map((a) => `const ${a.name} = ${JSON.stringify(a.key)};`),
    ...narrationScenes.map(
      (n) => `const ${n.constName}Key = ${JSON.stringify(n.key)};`,
    ),
  ];
  const audioSrcs = [
    ...topLevelKeys.map((a) => `  const ${a.name}Src = getAssetUrl(${a.name});`),
    ...narrationScenes.map(
      (n) => `  const ${n.constName}Src = getAssetUrl(${n.constName}Key);`,
    ),
  ];

  const remotionImports = ["AbsoluteFill"];
  if (hasAudio) remotionImports.push("Audio");
  if (musicLoops) remotionImports.push("Loop");
  if (assigned.length > 0) remotionImports.push("Sequence");
  if (musicLoops) remotionImports.push("interpolate");

  const imports = [
    `import { ${remotionImports.join(", ")} } from "remotion";`,
    ...(hasAudio ? ['import { getAssetUrl } from "./lib/assets";'] : []),
    ...assigned.map(
      (a) => `import { ${a.component} } from "./scenes/${a.component}";`,
    ),
  ];

  const body: string[] = [];
  if (audioConsts.length > 0) body.push(...audioConsts, "");
  body.push("export const VideoComposition = () => {");
  if (audioSrcs.length > 0) body.push(...audioSrcs, "");
  body.push("  return (", '    <AbsoluteFill style={{ backgroundColor: "#000000" }}>');

  if (legacyNarrationKey) {
    body.push("      {narrationAssetKeySrc ? <Audio src={narrationAssetKeySrc} /> : null}");
  }

  if (musicKey) {
    if (musicLoops) {
      // MUSIC COVERAGE (bug 2, arm B). <Loop> renders
      // `ceil(compositionDuration / durationInFrames)` iterations and the composition's own
      // end trims the final partial one — coverage and trim in a single construct, with no
      // dependence on the provider returning a conveniently-sized clip (verified live: no
      // music model accepts a requested length at all).
      //
      // `loopVolumeCurveBehavior="extend"` is what makes the fade a WHOLE-VIDEO tail rather
      // than a duck at the end of every iteration: remotion's `useFrameForVolumeProp` adds
      // `loop.durationInFrames * loop.iteration` under "extend", so `f` is a composition
      // frame. Under the default "repeat" the bed would dip repeatedly through the video.
      const fadeStart = Math.max(0, total - frameCount(MUSIC_FADE_SECONDS, fps));
      body.push(
        "      {musicAssetKeySrc ? (",
        `        <Loop durationInFrames={${musicLoopFrames}}>`,
        "          <Audio",
        "            src={musicAssetKeySrc}",
        '            loopVolumeCurveBehavior="extend"',
        "            volume={(f) =>",
        `              interpolate(f, [${fadeStart}, ${total}], [${MUSIC_VOLUME}, 0], {`,
        '                extrapolateLeft: "clamp",',
        '                extrapolateRight: "clamp",',
        "              })",
        "            }",
        "          />",
        "        </Loop>",
        "      ) : null}",
      );
    } else {
      body.push(
        `      {musicAssetKeySrc ? <Audio src={musicAssetKeySrc} volume={${MUSIC_VOLUME}} /> : null}`,
      );
    }
  }

  const narrationByComponent = new Map(
    narrationScenes.map((n) => [n.assigned.component, n.constName]),
  );
  let from = 0;
  for (const a of assigned) {
    const frames = sceneFrames(a.scene, fps);
    body.push(
      `      <Sequence name="${a.component}" from={${from}} durationInFrames={${frames}}>`,
      `        <${a.component} />`,
    );
    const narration = narrationByComponent.get(a.component);
    if (narration) {
      body.push(
        `        {${narration}Src ? <Audio src={${narration}Src} /> : null}`,
      );
    }
    body.push("      </Sequence>");
    from += frames;
  }
  body.push("    </AbsoluteFill>", "  );", "};", "");

  return [...header, ...imports, "", ...body].join("\n");
}

/**
 * `src/scenes/<Component>.tsx`: a prop-free scene with its manifest data baked in as
 * consts (the manifest is the parameter source in v1). Renders a black background,
 * the scene visual via <Img src={getAssetUrl(key)}> (only when the key resolves),
 * and a caption overlay that fades in via useCurrentFrame() + interpolate() inlined
 * in the style prop (no CSS transitions — forbidden by the guide). `scriptText` is
 * shown only when `scene.captions` is true; the `reference` label always renders.
 */
export function buildSceneSource(
  assigned: AssignedScene,
  fps: number,
  index: number,
): string {
  const scene = assigned.scene;
  // A clip already moves; only a STILL gets the pan/zoom. `visualAssetKind` absent means
  // image, which is exactly what every pre-existing v1 manifest was rendered as.
  const isVideo = scene.visualAssetKind === "video";
  const frames = sceneFrames(scene, fps);
  const motion = KEN_BURNS[index % KEN_BURNS.length];
  const visualComponent = isVideo ? "OffthreadVideo" : "Img";

  const lines: string[] = [
    "// Supagloo-generated scene source — DO NOT EDIT.",
    `// Regenerated from supagloo.project.json (scene id ${JSON.stringify(scene.id)}).`,
    `import { AbsoluteFill, ${visualComponent}, interpolate, useCurrentFrame } from "remotion";`,
    'import { getAssetUrl } from "../lib/assets";',
    "",
    `const visualAssetKey = ${JSON.stringify(scene.visualAssetKey ?? null)};`,
  ];
  if (scene.captions) {
    lines.push(`const scriptText = ${JSON.stringify(scene.scriptText)};`);
  }
  lines.push(`const reference = ${JSON.stringify(scene.reference)};`);
  lines.push(
    "",
    `export const ${assigned.component} = () => {`,
    "  const frame = useCurrentFrame();",
    "  const src = getAssetUrl(visualAssetKey);",
    "",
    "  return (",
    '    <AbsoluteFill style={{ backgroundColor: "#000000" }}>',
    "      {src ? (",
  );
  if (isVideo) {
    // A video-kind asset used to be rendered through <Img> — a latent second bug that the
    // manifest had no way to express, since the image and video workflows write the same
    // extensionless S3 key and the content-type is discarded on download.
    lines.push(
      "        <OffthreadVideo",
      "          src={src}",
      '          style={{ width: "100%", height: "100%", objectFit: "cover" }}',
      "        />",
    );
  } else {
    // KEN BURNS. Normalized over this scene's OWN frame count so the move completes exactly
    // once whatever the scene's length, and clamped at both ends so a scene held past its
    // Sequence never over-travels. `scale` is a STRING because React's unitless-property
    // table omits `scale` and would otherwise emit `scale:1.1px`, silently doing nothing.
    lines.push(
      "        <Img",
      "          src={src}",
      "          style={{",
      '            width: "100%",',
      '            height: "100%",',
      '            objectFit: "cover",',
      `            scale: interpolate(frame, [0, ${frames}], ${jsxArray(motion.scale)}, {`,
      '              extrapolateLeft: "clamp",',
      '              extrapolateRight: "clamp",',
      "            }),",
      `            translate: interpolate(frame, [0, ${frames}], ${jsxArray(motion.translate)}, {`,
      '              extrapolateLeft: "clamp",',
      '              extrapolateRight: "clamp",',
      "            }),",
      "          }}",
      "        />",
    );
  }
  lines.push("      ) : null}");
  lines.push(
    "      <AbsoluteFill",
    "        style={{",
    '          justifyContent: "flex-end",',
    '          alignItems: "center",',
    "          padding: 80,",
    "          gap: 16,",
    "          opacity: interpolate(frame, [0, 15], [0, 1], {",
    '            extrapolateLeft: "clamp",',
    '            extrapolateRight: "clamp",',
    "          }),",
    "        }}",
    "      >",
  );
  if (scene.captions) {
    lines.push(
      "        <p",
      "          style={{",
      "            margin: 0,",
      '            color: "#ffffff",',
      "            fontSize: 48,",
      "            fontWeight: 700,",
      '            textAlign: "center",',
      '            textShadow: "0 2px 12px rgba(0, 0, 0, 0.8)",',
      "          }}",
      "        >",
      "          {scriptText}",
      "        </p>",
    );
  }
  lines.push(
    "        <p",
    "          style={{",
    "            margin: 0,",
    '            color: "#ffffff",',
    "            fontSize: 28,",
    "            fontWeight: 500,",
    "            opacity: 0.85,",
    '            textShadow: "0 2px 12px rgba(0, 0, 0, 0.8)",',
    "          }}",
    "        >",
    "          {reference}",
    "        </p>",
    "      </AbsoluteFill>",
    "    </AbsoluteFill>",
    "  );",
    "};",
    "",
  );
  return lines.join("\n");
}
