import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { buildScrubbedChildEnv } from "./child-env";
import { RenderCanceledError, RenderChildFailedError } from "./errors";
import { watchForCancellation } from "./cancellation";
import type { BundleSpec, RenderSpec, StillSpec } from "./child-main";
import type { ResolvedComposition } from "./composition";

/**
 * The PARENT half of the scrubbed-env child protocol (see `child-main.ts`).
 *
 * Responsibilities:
 *   - spawn `child-main` with an ALLOWLIST-built environment (never `process.env`);
 *   - stream its NDJSON stdout, relaying `progress` lines to the caller;
 *   - enforce a kill DEADLINE — DBOS has no per-step timeout, so this IS the design's
 *     "generous step timeout" for `renderMedia`, and it doubles as the bound on the
 *     untrusted code we are executing;
 *   - drive COOPERATIVE cancellation: poll this workflow's own DBOS status and, on
 *     CANCELLED, SIGTERM the child so Remotion tears Chromium down promptly instead of
 *     rendering for another twenty minutes before DBOS preempts at the next step boundary.
 */

export interface ChildCallbacks {
  /** Frame progress from `renderMedia`'s `onProgress`. */
  onProgress?: (renderedFrames: number, encodedFrames: number) => void;
  /** Poll for cancellation; returns the workflow's DBOS status. */
  getWorkflowStatus?: (
    workflowId: string,
  ) => Promise<{ status?: string | null } | null | undefined>;
}

export interface RunChildArgs<S> {
  command: "bundle" | "render" | "still";
  spec: S;
  timeoutMs: number;
  /** Used for the cooperative-cancel poll and for error messages. */
  workflowId: string;
  cancelPollMs: number;
  callbacks?: ChildCallbacks;
}

/**
 * Locate the child entry point. In a built image it is `child-main.js` beside this module;
 * under Vitest/tsx (the e2e runs the DBOS runtime in-process from `src/`) only the `.ts`
 * exists, so we run it through tsx's own CLI — resolved from node_modules, never via a
 * `npx` shell-out.
 */
function resolveChildEntry(): { execArgs: string[]; script: string } {
  const compiled = join(__dirname, "child-main.js");
  if (existsSync(compiled)) return { execArgs: [], script: compiled };

  const source = join(__dirname, "child-main.ts");
  if (existsSync(source)) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return { execArgs: [require.resolve("tsx/cli")], script: source };
  }
  throw new Error(
    `render child entry not found next to ${__dirname} (looked for child-main.js/.ts)`,
  );
}

interface ChildOutcome {
  result?: unknown;
  error?: { message: string; stack?: string };
}

function killTree(child: ChildProcess): void {
  try {
    child.kill("SIGTERM");
  } catch {
    /* already gone */
  }
  setTimeout(() => {
    try {
      child.kill("SIGKILL");
    } catch {
      /* already gone */
    }
  }, 10_000).unref();
}

async function runChild<S, R>(args: RunChildArgs<S>): Promise<R> {
  const { execArgs, script } = resolveChildEntry();
  const child = spawn(
    process.execPath,
    [...execArgs, script, args.command],
    {
      // THE isolation boundary: an explicit allowlist, not `{ ...process.env }`.
      env: buildScrubbedChildEnv(),
      stdio: ["pipe", "pipe", "pipe"],
    },
  );

  child.stdin.write(JSON.stringify(args.spec));
  child.stdin.end();

  const outcome: ChildOutcome = {};
  let stdoutBuffer = "";
  let stderrTail = "";
  let canceled = false;
  let timedOut = false;

  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdoutBuffer += chunk;
    let newline = stdoutBuffer.indexOf("\n");
    while (newline !== -1) {
      const line = stdoutBuffer.slice(0, newline).trim();
      stdoutBuffer = stdoutBuffer.slice(newline + 1);
      newline = stdoutBuffer.indexOf("\n");
      if (!line) continue;
      try {
        const parsed = JSON.parse(line) as {
          type?: string;
          renderedFrames?: number;
          encodedFrames?: number;
          result?: unknown;
          message?: string;
          stack?: string;
        };
        if (parsed.type === "progress") {
          args.callbacks?.onProgress?.(
            parsed.renderedFrames ?? 0,
            parsed.encodedFrames ?? 0,
          );
        } else if (parsed.type === "result") {
          outcome.result = parsed.result;
        } else if (parsed.type === "error") {
          outcome.error = { message: parsed.message ?? "unknown", stack: parsed.stack };
        }
      } catch {
        // Not our NDJSON (a stray console.log from user code) — ignore.
      }
    }
  });

  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    // Keep only the tail: user-code stack traces can be enormous and this string ends up
    // in an error message (and potentially a DBOS checkpoint).
    stderrTail = `${stderrTail}${chunk}`.slice(-4000);
  });

  const deadline = setTimeout(() => {
    timedOut = true;
    killTree(child);
  }, args.timeoutMs);
  deadline.unref();

  const watch = args.callbacks?.getWorkflowStatus
    ? watchForCancellation({
        workflowId: args.workflowId,
        intervalMs: args.cancelPollMs,
        getStatus: args.callbacks.getWorkflowStatus,
        onCancel: () => {
          canceled = true;
          killTree(child);
        },
      })
    : undefined;

  try {
    const exitCode = await new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code) => resolve(code));
    });

    if (canceled) throw new RenderCanceledError(args.workflowId);
    if (timedOut) {
      throw new RenderChildFailedError(
        args.command,
        exitCode,
        `exceeded its ${Math.round(args.timeoutMs / 1000)}s deadline`,
      );
    }
    if (outcome.error) {
      // A child error is attributable to the cloned project's own code/config far more
      // often than to us, but we cannot tell reliably — so it stays TRANSIENT (the shared
      // rule: never mark something permanent by accident).
      throw new RenderChildFailedError(args.command, exitCode, outcome.error.message);
    }
    if (exitCode !== 0) {
      throw new RenderChildFailedError(
        args.command,
        exitCode,
        stderrTail.trim() || "no output",
      );
    }
    if (outcome.result === undefined) {
      throw new RenderChildFailedError(
        args.command,
        exitCode,
        "child exited 0 without emitting a result",
      );
    }
    return outcome.result as R;
  } finally {
    clearTimeout(deadline);
    watch?.stop();
  }
}

export interface BundleChildResult {
  bundleDir: string;
  composition: ResolvedComposition;
}

export function runBundleChild(
  spec: BundleSpec,
  opts: { timeoutMs: number; workflowId: string; cancelPollMs: number; callbacks?: ChildCallbacks },
): Promise<BundleChildResult> {
  return runChild<BundleSpec, BundleChildResult>({ command: "bundle", spec, ...opts });
}

export interface RenderChildResult {
  outputPath: string;
  framesRendered: number;
  contentType?: string;
}

export function runRenderChild(
  spec: RenderSpec,
  opts: { timeoutMs: number; workflowId: string; cancelPollMs: number; callbacks?: ChildCallbacks },
): Promise<RenderChildResult> {
  return runChild<RenderSpec, RenderChildResult>({ command: "render", spec, ...opts });
}

export interface StillChildResult {
  outputPath: string;
}

export function runStillChild(
  spec: StillSpec,
  opts: { timeoutMs: number; workflowId: string; cancelPollMs: number; callbacks?: ChildCallbacks },
): Promise<StillChildResult> {
  return runChild<StillSpec, StillChildResult>({ command: "still", spec, ...opts });
}
