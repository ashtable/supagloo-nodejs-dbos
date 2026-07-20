import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkoutVersionBranch,
  ensureImportClone,
  hasRemotionConfig,
  importWorkspacePath,
  listRemoteBranchNames,
  removeImportWorkspace,
  type ImportContext,
} from "./workspace";

// The import workspace helpers, exercised against REAL git in hermetic temp dirs
// (house style — mock only the GitHub HTTP layer, never git itself). A bare origin is
// seeded with `remotion.config.ts` on the default branch plus several `vN.N.N`
// branches, so these tests cover the actual clone → list-remote-branches →
// checkout-version-branch cycle the workflow drives, plus the self-healing
// reuse/re-clone behaviour a crash/replay depends on.

const HERMETIC = {
  GIT_TERMINAL_PROMPT: "0",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_AUTHOR_NAME: "Import Test",
  GIT_AUTHOR_EMAIL: "import@supagloo.test",
  GIT_COMMITTER_NAME: "Import Test",
  GIT_COMMITTER_EMAIL: "import@supagloo.test",
};

function git(args: string[], cwd?: string): void {
  execFileSync("git", args, { cwd, env: { ...process.env, ...HERMETIC } });
}

let root: string;
let originUrl: string;
let ctx: ImportContext;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "import-ws-test-"));
  // Bare origin.
  const origin = join(root, "origin.git");
  git(["init", "--bare", "--initial-branch=main", origin]);
  originUrl = origin;

  // Seed the origin: remotion.config.ts + a manifest on main, then three version branches.
  const work = join(root, "work");
  git(["init", "--initial-branch=main", work]);
  writeFileSync(join(work, "remotion.config.ts"), "// supagloo marker\n");
  writeFileSync(join(work, "supagloo.project.json"), "{}\n");
  git(["add", "-A"], work);
  git(["commit", "-m", "supagloo scaffold"], work);
  git(["remote", "add", "origin", origin], work);
  git(["push", "origin", "main"], work);
  for (const branch of ["v0.0.1", "v0.2.3", "v0.10.0"]) {
    git(["branch", branch], work);
    git(["push", "origin", branch], work);
  }

  ctx = {
    jobId: `import-${Date.now()}`,
    cloneUrl: originUrl,
    workspaceRoot: join(root, "workspaces"),
  };
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("ensureImportClone", () => {
  it("clones the repo into the deterministic workspace path", async () => {
    const path = await ensureImportClone(ctx);
    expect(path).toBe(importWorkspacePath(ctx));
    expect(existsSync(join(path, ".git"))).toBe(true);
    expect(existsSync(join(path, "remotion.config.ts"))).toBe(true);
  });

  it("reuses a live workspace on a second call (no re-clone)", async () => {
    const path = await ensureImportClone(ctx);
    // Drop a marker; a reuse keeps it, a re-clone would wipe it.
    writeFileSync(join(path, ".reuse-marker"), "x");
    const again = await ensureImportClone(ctx);
    expect(again).toBe(path);
    expect(existsSync(join(path, ".reuse-marker"))).toBe(true);
  });

  it("rebuilds a lost workspace (crash/replay self-heal)", async () => {
    const path = await ensureImportClone(ctx);
    await removeImportWorkspace(ctx);
    expect(existsSync(path)).toBe(false);
    const rebuilt = await ensureImportClone(ctx);
    expect(rebuilt).toBe(path);
    expect(existsSync(join(path, "remotion.config.ts"))).toBe(true);
  });
});

describe("listRemoteBranchNames + hasRemotionConfig", () => {
  it("lists every remote-tracking branch (short name), excluding origin/HEAD", async () => {
    const path = await ensureImportClone(ctx);
    const branches = await listRemoteBranchNames(path);
    expect(branches.sort()).toEqual(["main", "v0.0.1", "v0.10.0", "v0.2.3"]);
    expect(branches).not.toContain("HEAD");
  });

  it("detects remotion.config.ts at the checkout root", async () => {
    const path = await ensureImportClone(ctx);
    expect(hasRemotionConfig(path)).toBe(true);
    rmSync(join(path, "remotion.config.ts"));
    expect(hasRemotionConfig(path)).toBe(false);
  });
});

describe("checkoutVersionBranch", () => {
  it("checks out the version branch from origin and returns its head sha", async () => {
    const path = await ensureImportClone(ctx);
    const sha = await checkoutVersionBranch(path, "v0.10.0");
    expect(sha).toMatch(/^[0-9a-f]{40}$/);
    // The version branch also carries the scaffold marker.
    expect(existsSync(join(path, "remotion.config.ts"))).toBe(true);
  });
});
