import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ManifestInvalidError } from "./errors";
import { parseManifestFile } from "./manifest";

// parseManifest is import's validation gate (design-delta §2.11: ProjectManifestSchema
// is validated at "import verify"). It reads supagloo.project.json from the checked-out
// version branch, JSON-parses it, and validates it against the shared Zod schema. Any
// of missing file / bad JSON / schema mismatch is a PERMANENT ManifestInvalidError
// (retrying re-reads identical bytes). Tested against real files in a temp dir.

const VALID_MANIFEST = {
  manifestVersion: 1,
  composition: { width: 1080, height: 1920, fps: 30, aspectRatio: "9:16" },
  scenes: [],
  narratorVoice: { description: "Calm narrator" },
};

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "import-manifest-test-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("parseManifestFile", () => {
  it("parses a valid supagloo.project.json into a ProjectManifest", async () => {
    writeFileSync(
      join(dir, "supagloo.project.json"),
      JSON.stringify(VALID_MANIFEST),
    );
    const manifest = await parseManifestFile(dir);
    expect(manifest.manifestVersion).toBe(1);
    expect(manifest.scenes).toEqual([]);
    expect(manifest.composition.width).toBe(1080);
  });

  it("throws ManifestInvalidError when the file is missing", async () => {
    await expect(parseManifestFile(dir)).rejects.toBeInstanceOf(
      ManifestInvalidError,
    );
  });

  it("throws ManifestInvalidError when the JSON is malformed", async () => {
    writeFileSync(join(dir, "supagloo.project.json"), "{ not json");
    await expect(parseManifestFile(dir)).rejects.toBeInstanceOf(
      ManifestInvalidError,
    );
  });

  it("throws ManifestInvalidError when the JSON does not match the schema", async () => {
    writeFileSync(
      join(dir, "supagloo.project.json"),
      JSON.stringify({ manifestVersion: 2 }),
    );
    let thrown: unknown;
    try {
      await parseManifestFile(dir);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(ManifestInvalidError);
    expect((thrown as ManifestInvalidError).permanent).toBe(true);
  });
});
