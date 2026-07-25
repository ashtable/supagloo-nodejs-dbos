import type { ProjectManifest } from "@supagloo/database-lib";
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

/** Total composition length = Σ per-scene frames, clamped ≥ 1 (zero-scene → 1). */
export function totalFrames(manifest: ProjectManifest): number {
  const sum = manifest.scenes.reduce(
    (acc, scene) => acc + frameCount(scene.durationSeconds, manifest.composition.fps),
    0,
  );
  return Math.max(1, sum);
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
  const narrationKey = manifest.narratorVoice.assetKey ?? null;
  const musicKey = manifest.music?.assetKey ?? null;
  const audioKeys: Array<{ name: string; key: string }> = [];
  if (narrationKey) audioKeys.push({ name: "narrationAssetKey", key: narrationKey });
  if (musicKey) audioKeys.push({ name: "musicAssetKey", key: musicKey });

  const audioConsts = audioKeys.map(
    (a) => `const ${a.name} = ${JSON.stringify(a.key)};`,
  );
  const audioSrcs = audioKeys.map(
    (a) => `  const ${a.name}Src = getAssetUrl(${a.name});`,
  );
  const audioElements = audioKeys.flatMap((a) => [
    `      {${a.name}Src ? <Audio src={${a.name}Src} /> : null}`,
  ]);

  if (assigned.length === 0 && audioKeys.length === 0) {
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

  const remotionImports = ["AbsoluteFill"];
  if (audioKeys.length > 0) remotionImports.push("Audio");
  if (assigned.length > 0) remotionImports.push("Sequence");

  const imports = [
    `import { ${remotionImports.join(", ")} } from "remotion";`,
    ...(audioKeys.length > 0
      ? ['import { getAssetUrl } from "./lib/assets";']
      : []),
    ...assigned.map(
      (a) => `import { ${a.component} } from "./scenes/${a.component}";`,
    ),
  ];

  const body: string[] = [];
  if (audioConsts.length > 0) body.push(...audioConsts, "");
  body.push("export const VideoComposition = () => {");
  if (audioSrcs.length > 0) body.push(...audioSrcs, "");
  body.push("  return (", '    <AbsoluteFill style={{ backgroundColor: "#000000" }}>');
  body.push(...audioElements);
  let from = 0;
  for (const a of assigned) {
    const frames = frameCount(a.scene.durationSeconds, manifest.composition.fps);
    body.push(
      `      <Sequence name="${a.component}" from={${from}} durationInFrames={${frames}}>`,
      `        <${a.component} />`,
      "      </Sequence>",
    );
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
export function buildSceneSource(assigned: AssignedScene): string {
  const scene = assigned.scene;
  const lines: string[] = [
    "// Supagloo-generated scene source — DO NOT EDIT.",
    `// Regenerated from supagloo.project.json (scene id ${JSON.stringify(scene.id)}).`,
    'import { AbsoluteFill, Img, interpolate, useCurrentFrame } from "remotion";',
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
    "        <Img",
    "          src={src}",
    '          style={{ width: "100%", height: "100%", objectFit: "cover" }}',
    "        />",
    "      ) : null}",
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
