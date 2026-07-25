import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  ProjectManifestSchema,
  type ProjectManifest,
} from "@supagloo/database-lib";
import { applyManifest } from "../../remotion/scaffold";
import { buildAssetsSource } from "../../remotion/templates";
import { cloneBranch } from "../commit-version/git";
import { buildScrubbedChildEnv } from "./child-env";
import { RenderChildFailedError, RenderRequestInvalidError } from "./errors";
import { buildInstallArgs, hasLockfile } from "./npm";

/**
 * The render workspace: an EPHEMERAL, deterministic temp directory per render job.
 *
 *   <tmp>/supagloo-render/<renderJobId>/
 *     repo/                  the shallow clone of the project at its version branch
 *       public/<assetKey>    every manifest-referenced S3 object, downloaded
 *       public/render-audio/ freshly-synthesized narration/music (fallback path)
 *     bundle/                the @remotion/bundler output (deterministic path)
 *     out/output.mp4         the encode
 *     out/thumb.jpg          the still
 *
 * Crash-safety, exactly as `scaffoldProjectWorkflow` solves it: the directory does NOT
 * survive a worker restart, so every workspace-touching step rebuilds idempotently from
 * durable sources (git + S3 + the checkpointed manifest) rather than assuming it is still
 * there. A genuine crash mid-`renderMedia` therefore re-executes the whole rendering step
 * — Remotion does not checkpoint partial frames and there is no way to resume an encode.
 * That is an ACCEPTED limitation (the plan's e2e explicitly allows "completes or restarts
 * step safely"), not an oversight.
 */

export const MANIFEST_FILE = "supagloo.project.json";
export const COMPOSITION_ID = "Main";

/** Root of all render workspaces — exported so an e2e can simulate a fresh worker. */
export function renderWorkspaceRoot(): string {
  return join(tmpdir(), "supagloo-render");
}

export interface RenderWorkspace {
  root: string;
  repoDir: string;
  publicDir: string;
  bundleDir: string;
  outDir: string;
  videoPath: string;
  thumbnailPath: string;
}

export function renderWorkspace(renderJobId: string): RenderWorkspace {
  const root = join(renderWorkspaceRoot(), renderJobId);
  const repoDir = join(root, "repo");
  const outDir = join(root, "out");
  return {
    root,
    repoDir,
    publicDir: join(repoDir, "public"),
    bundleDir: join(root, "bundle"),
    outDir,
    videoPath: join(outDir, "output.mp4"),
    thumbnailPath: join(outDir, "thumb.jpg"),
  };
}

/** Idempotent shallow clone of the version branch. A present clone is left alone. */
export async function ensureClone(
  ws: RenderWorkspace,
  cloneUrl: string,
  branch: string,
): Promise<void> {
  if (existsSync(join(ws.repoDir, ".git"))) return;
  await rm(ws.repoDir, { recursive: true, force: true });
  await mkdir(ws.root, { recursive: true });
  // Depth 1: the render never diffs or commits, it only needs the tree at the tip.
  await cloneBranch(cloneUrl, ws.repoDir, branch, { depth: 1 });
}

/** Read + Zod-validate the cloned project's manifest (the render's source of truth). */
export async function readWorkspaceManifest(
  ws: RenderWorkspace,
): Promise<ProjectManifest> {
  let raw: string;
  try {
    raw = await readFile(join(ws.repoDir, MANIFEST_FILE), "utf8");
  } catch {
    throw new RenderRequestInvalidError(
      `the cloned repo has no ${MANIFEST_FILE} — it is not a Supagloo project`,
    );
  }
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw);
  } catch (err) {
    throw new RenderRequestInvalidError(
      `${MANIFEST_FILE} is not valid JSON: ${(err as Error).message}`,
    );
  }
  const parsed = ProjectManifestSchema.safeParse(parsedJson);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    throw new RenderRequestInvalidError(`${MANIFEST_FILE} is invalid — ${details}`);
  }
  return parsed.data;
}

/**
 * Run `npm ci|install --ignore-scripts` in the clone, in a SCRUBBED-ENV child.
 * Idempotent: an existing `node_modules` is left alone, so a step retry after a
 * transient registry failure is cheap and a self-healing rebuild re-installs.
 */
export async function ensureDependencies(
  ws: RenderWorkspace,
  timeoutMs: number,
): Promise<{ usedLockfile: boolean; skipped: boolean }> {
  const lock = await hasLockfile(ws.repoDir);
  if (existsSync(join(ws.repoDir, "node_modules"))) {
    return { usedLockfile: lock, skipped: true };
  }
  const args = buildInstallArgs(lock);
  await runScrubbed("npm", args, ws.repoDir, timeoutMs);
  return { usedLockfile: lock, skipped: false };
}

/** Write one materialized asset into the bundle-visible `public/` tree. */
export async function writeWorkspaceAsset(
  ws: RenderWorkspace,
  assetKey: string,
  bytes: Buffer,
): Promise<string> {
  const target = join(ws.publicDir, assetKey);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, bytes);
  return target;
}

/** True when an asset is already present on disk (so a rebuild can skip re-downloading). */
export function hasWorkspaceAsset(ws: RenderWorkspace, assetKey: string): boolean {
  return existsSync(join(ws.publicDir, assetKey));
}

/**
 * True when a usable Remotion bundle is on disk. Checked by `index.html` rather than by
 * the directory's existence: an interrupted bundle can leave the directory behind
 * half-written, and `renderMedia` fails with "the file …/index.html does not exist" —
 * which is exactly how the crash/replay e2e caught the missing self-heal.
 */
export function hasBundle(ws: RenderWorkspace): boolean {
  return existsSync(join(ws.bundleDir, "index.html"));
}

/** True when the encode is on disk. */
export function hasRenderedVideo(ws: RenderWorkspace): boolean {
  return existsSync(ws.videoPath);
}

/** True when the thumbnail still is on disk. */
export function hasThumbnail(ws: RenderWorkspace): boolean {
  return existsSync(ws.thumbnailPath);
}

/**
 * Regenerate the manifest-derived Remotion sources in the workspace, plus the static
 * asset resolver.
 *
 * Why the render regenerates at all (plan D2): `applyManifest` already overwrites
 * hand-edited scene sources on every commit — v1 declares the manifest the sole source of
 * truth — so this is a no-op for any project whose last commit went through
 * `commitVersionWorkflow`. What it buys is (a) freshly-synthesized audio can be REFERENCED
 * by the composition without the render workflow making a git commit (which would collide
 * with the per-project 409 git-ops guard), and (b) a repo scaffolded by an older generator
 * still renders correctly. `package.json`, `remotion.config.ts`, and everything else the
 * user controls are untouched — which is why the untrusted-code posture still applies.
 */
export async function materializeRenderSources(
  ws: RenderWorkspace,
  manifest: ProjectManifest,
): Promise<{ filesWritten: string[] }> {
  const assetsPath = join(ws.repoDir, "src", "lib", "assets.ts");
  await mkdir(dirname(assetsPath), { recursive: true });
  await writeFile(assetsPath, buildAssetsSource(), "utf8");
  const { filesWritten } = await applyManifest(manifest, ws.repoDir);
  return { filesWritten };
}

/** Read the two encoded artifacts back off disk for upload (bytes never checkpointed). */
export async function readRenderOutputs(
  ws: RenderWorkspace,
): Promise<{ video: Buffer; thumbnail: Buffer }> {
  const [video, thumbnail] = await Promise.all([
    readFile(ws.videoPath),
    readFile(ws.thumbnailPath),
  ]);
  return { video, thumbnail };
}

export async function ensureOutDir(ws: RenderWorkspace): Promise<void> {
  await mkdir(ws.outDir, { recursive: true });
}

/** Delete the whole workspace (terminal cleanup). Never throws. */
export async function removeWorkspace(ws: RenderWorkspace): Promise<void> {
  await rm(ws.root, { recursive: true, force: true }).catch(() => {});
}

/**
 * Run a command in a SCRUBBED environment with a kill deadline. Used for `npm`, which —
 * like the bundler and the renderer — resolves and executes user-controlled package
 * metadata and must never see the worker's secrets.
 */
async function runScrubbed(
  command: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: buildScrubbedChildEnv(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderrTail = "";
    let timedOut = false;
    child.stdout.on("data", () => {
      /* npm chatter is not surfaced */
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderrTail = `${stderrTail}${chunk}`.slice(-4000);
    });
    const deadline = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    deadline.unref();
    child.once("error", (err) => {
      clearTimeout(deadline);
      reject(new RenderChildFailedError(command, null, (err as Error).message));
    });
    child.once("close", (code) => {
      clearTimeout(deadline);
      if (timedOut) {
        reject(
          new RenderChildFailedError(
            command,
            code,
            `exceeded its ${Math.round(timeoutMs / 1000)}s deadline`,
          ),
        );
        return;
      }
      if (code !== 0) {
        reject(
          new RenderChildFailedError(command, code, stderrTail.trim() || "no output"),
        );
        return;
      }
      resolve();
    });
  });
}
