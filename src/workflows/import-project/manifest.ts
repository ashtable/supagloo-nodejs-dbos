import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  ProjectManifestSchema,
  type ProjectManifest,
} from "@supagloo/database-lib";
import { ManifestInvalidError } from "./errors";

/**
 * `parseManifest` — import's manifest validation gate (design-delta §2.11:
 * `ProjectManifestSchema` is validated at "import verify"). Reads
 * `supagloo.project.json` from the checked-out version-branch workspace, JSON-parses it,
 * and validates it against the shared Zod schema. Missing file / bad JSON / schema
 * mismatch all raise a PERMANENT {@link ManifestInvalidError} (retrying re-reads
 * identical bytes). The parsed manifest is NOT persisted — composition lives in the repo
 * (source of truth); this step only proves the imported project is well-formed.
 */

export const MANIFEST_FILE = "supagloo.project.json";

export async function parseManifestFile(dir: string): Promise<ProjectManifest> {
  let raw: string;
  try {
    raw = await readFile(join(dir, MANIFEST_FILE), "utf8");
  } catch {
    throw new ManifestInvalidError(
      `${MANIFEST_FILE} is missing or unreadable at the repository root`,
    );
  }

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new ManifestInvalidError(`${MANIFEST_FILE} is not valid JSON`);
  }

  const parsed = ProjectManifestSchema.safeParse(json);
  if (!parsed.success) {
    throw new ManifestInvalidError(
      `${MANIFEST_FILE} does not match the project manifest schema`,
    );
  }
  return parsed.data;
}
