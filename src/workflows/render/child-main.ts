/**
 * The SCRUBBED-ENV CHILD PROCESS entry point (design-delta §7 workflow 9, "Untrusted-code
 * isolation").
 *
 * `@remotion/bundler` runs webpack over the cloned repo's sources and `@remotion/renderer`
 * evaluates them inside Chromium — both execute code we did not write. They therefore run
 * HERE, in a child process whose environment is an explicit allowlist (see `child-env.ts`)
 * containing no `SECRETS_ENCRYPTION_KEY`, no `GITHUB_APP_PRIVATE_KEY`, no provider hosts,
 * and no database credentials.
 *
 * Protocol (see `child-runner.ts` for the parent half):
 *   - the command is `argv[2]`: `bundle` | `render` | `still`
 *   - the JSON spec arrives on stdin, terminated by EOF
 *   - stdout is NDJSON: `{"type":"progress",…}` lines, then exactly one
 *     `{"type":"result",…}` or `{"type":"error",…}` line
 *   - SIGTERM = cancel: the Remotion cancel signal fires and the process exits
 *
 * Nothing here imports the app database, the DBOS SDK, Prisma, or the provider layer —
 * keeping this module's dependency graph free of anything secret-bearing is part of the
 * isolation story, not an accident.
 */
import { bundle } from "@remotion/bundler";
import { buildRenderMediaOptions } from "./media-options";
import {
  ensureBrowser,
  makeCancelSignal,
  renderMedia,
  renderStill,
  selectComposition,
  type Codec,
} from "@remotion/renderer";

export interface BundleSpec {
  /** The cloned project's root (its `public/` dir is snapshotted into the bundle). */
  projectDir: string;
  /** Deterministic output dir so a replayed step can detect/reuse it. */
  outDir: string;
  compositionId: string;
}

export interface RenderSpec {
  serveUrl: string;
  compositionId: string;
  outputLocation: string;
  codec: string;
  /** Output-spec overrides applied on top of the composition Remotion resolves. */
  width: number;
  height: number;
  fps: number;
  durationInFrames: number;
  /**
   * Plan row 45 (§9-Q8). The parent's child-process KILL DEADLINE, carried across the
   * boundary only so `buildRenderMediaOptions` can enforce `frameTimeoutMs < mediaTimeoutMs`
   * in the process that actually calls `renderMedia` (Step-11 item 9). The parent enforces
   * its own copy of the deadline with a timer; this is not a second timeout.
   */
  mediaTimeoutMs: number;
  /**
   * Plan row 45 / Step-11 item 9. Remotion's OWN per-frame budget — a DIFFERENT quantity
   * from the kill deadline above, and necessarily strictly below it. Without it a single
   * wedged frame is invisible until the deadline SIGTERMs the whole child with no
   * attribution; equal to it (what row 45 first shipped) it can never fire at all, because
   * Remotion's clock starts only after browser launch and composition resolution. See
   * `render/media-options.ts`.
   */
  frameTimeoutMs: number;
  /**
   * Plan row 45. Remotion resolves an unset concurrency to `round(min(8, max(1, cpus / 2)))`,
   * and each unit is a Chromium tab holding decoded frames — the biggest unbounded memory
   * lever here. OMITTED unless the operator sets `RENDER_MEDIA_CONCURRENCY`, so the default
   * behaviour is unchanged until a measurement justifies a number.
   */
  concurrency?: number;
}

export interface StillSpec {
  serveUrl: string;
  compositionId: string;
  outputLocation: string;
  frame: number;
  width: number;
  height: number;
}

type Line =
  | { type: "progress"; renderedFrames: number; encodedFrames: number }
  | { type: "result"; result: unknown }
  | { type: "error"; message: string; stack?: string };

function emit(line: Line): void {
  process.stdout.write(`${JSON.stringify(line)}\n`);
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * Resolve the composition Remotion reports for the bundle, then stamp the RenderJob's
 * output spec over it. Overriding fps without rescaling `durationInFrames` would silently
 * change the wall-clock length, so the PARENT does that arithmetic
 * (`composition.applyOutputSpec`) and passes the final numbers down.
 */
async function resolveComposition(serveUrl: string, compositionId: string) {
  return selectComposition({ serveUrl, id: compositionId });
}

async function main(): Promise<void> {
  const command = process.argv[2];
  const spec = JSON.parse(await readStdin());

  const { cancelSignal, cancel } = makeCancelSignal();
  // SIGTERM is the parent's cancel: unwind Remotion cleanly (kill Chromium, remove
  // partial output) rather than leaving an orphaned browser behind.
  process.on("SIGTERM", () => {
    cancel();
    // Give Remotion a moment to tear down, then leave regardless.
    setTimeout(() => process.exit(143), 5000).unref();
  });

  if (command === "bundle") {
    const s = spec as BundleSpec;
    // Chromium is needed by selectComposition below (and by every later step), so make
    // sure it is present before we do the expensive webpack build.
    await ensureBrowser();
    const bundleDir = await bundle({
      entryPoint: `${s.projectDir}/src/index.ts`,
      outDir: s.outDir,
      // Default publicDir (`<projectDir>/public`) is exactly where the workflow
      // materialized the scene assets and the audio — bundle() copies it into the bundle,
      // which is WHY audio must be synthesized before this runs.
      publicPath: "/",
      onProgress: () => {
        /* webpack progress is not surfaced to the RenderJob row */
      },
    });
    const composition = await resolveComposition(bundleDir, s.compositionId);
    emit({
      type: "result",
      result: {
        bundleDir,
        composition: {
          id: composition.id,
          width: composition.width,
          height: composition.height,
          fps: composition.fps,
          durationInFrames: composition.durationInFrames,
        },
      },
    });
    return;
  }

  if (command === "render") {
    const s = spec as RenderSpec;
    await ensureBrowser();
    const base = await resolveComposition(s.serveUrl, s.compositionId);
    const composition = {
      ...base,
      width: s.width,
      height: s.height,
      fps: s.fps,
      durationInFrames: s.durationInFrames,
    };
    let lastReported = -1;
    const result = await renderMedia({
      composition,
      serveUrl: s.serveUrl,
      codec: s.codec as Codec,
      outputLocation: s.outputLocation,
      overwrite: true,
      cancelSignal,
      // Plan row 45 (§9-Q8) — the tuned knobs, built by `render/media-options.ts` in the
      // parent and carried across the process boundary in the spec (the child reads no
      // configuration of its own; its env is scrubbed by design).
      ...buildRenderMediaOptions({
        mediaTimeoutMs: s.mediaTimeoutMs,
        frameTimeoutMs: s.frameTimeoutMs,
        concurrency: s.concurrency,
      }),
      onProgress: ({ renderedFrames, encodedFrames }) => {
        // Emit only on change — the parent throttles again before it touches the DB.
        if (renderedFrames === lastReported) return;
        lastReported = renderedFrames;
        emit({ type: "progress", renderedFrames, encodedFrames });
      },
    });
    emit({
      type: "result",
      result: {
        outputPath: s.outputLocation,
        framesRendered: composition.durationInFrames,
        contentType: result.contentType,
      },
    });
    return;
  }

  if (command === "still") {
    const s = spec as StillSpec;
    await ensureBrowser();
    const base = await resolveComposition(s.serveUrl, s.compositionId);
    await renderStill({
      composition: { ...base, width: s.width, height: s.height },
      serveUrl: s.serveUrl,
      output: s.outputLocation,
      frame: s.frame,
      imageFormat: "jpeg",
      overwrite: true,
      cancelSignal,
    });
    emit({ type: "result", result: { outputPath: s.outputLocation } });
    return;
  }

  throw new Error(`unknown render child command: ${String(command)}`);
}

// Only run when executed as a process, never when imported (the parent imports the TYPES).
if (require.main === module) {
  main().then(
    () => {
      process.exit(0);
    },
    (err: unknown) => {
      const error = err as Error;
      emit({ type: "error", message: error?.message ?? String(err), stack: error?.stack });
      process.exit(1);
    },
  );
}
