import { RenderOutputSpecSchema, type RenderOutputSpec } from "@supagloo/database-lib";
import { RenderRequestInvalidError } from "./errors";

/**
 * Parse the joined `RenderJob` row (with its Project + ProjectVersion relations) into the
 * small, JSON-serializable context the workflow threads through its steps.
 *
 * The output spec lives on the RenderJob's OWN columns (design §2.7 — width/height/fps/
 * aspectRatio/codec), not in a JSON blob, so "parsing" means validating those columns
 * against the SHARED `RenderOutputSpecSchema` — the same schema the render API (task 37)
 * validates its request body with, so the two can never drift.
 *
 * Everything rejected here is PERMANENT: a missing or malformed row will not heal on
 * retry, so the step's `shouldRetry` fails it fast rather than burning the backoff budget.
 *
 * Pure — no Prisma, no DBOS — so it unit-tests against plain fixtures.
 */

export interface RenderRequest {
  renderJobId: string;
  projectId: string;
  versionId: string;
  userId: string;
  repoOwner: string;
  repoName: string;
  /** The version branch to clone at (e.g. `v0.0.1`) — design's `cloneAtVersion`. */
  branchName: string;
  outputSpec: RenderOutputSpec;
  /** Purely a UI affordance (§7 workflow 9) — the workflow is always asynchronous. */
  runInBackground: boolean;
}

interface JoinedRow {
  id?: unknown;
  projectId?: unknown;
  versionId?: unknown;
  userId?: unknown;
  width?: unknown;
  height?: unknown;
  fps?: unknown;
  aspectRatio?: unknown;
  codec?: unknown;
  runInBackground?: unknown;
  project?: {
    id?: unknown;
    repoOwner?: unknown;
    repoName?: unknown;
    ownerId?: unknown;
  } | null;
  version?: { id?: unknown; semver?: unknown; branchName?: unknown } | null;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new RenderRequestInvalidError(`missing or empty ${label}`);
  }
  return value;
}

export function parseRenderRequest(row: JoinedRow | null | undefined): RenderRequest {
  if (!row || typeof row !== "object") {
    throw new RenderRequestInvalidError("no RenderJob row for this workflow id");
  }
  if (!row.project) {
    throw new RenderRequestInvalidError("RenderJob has no Project relation");
  }
  if (!row.version) {
    throw new RenderRequestInvalidError("RenderJob has no ProjectVersion relation");
  }

  const spec = RenderOutputSpecSchema.safeParse({
    width: row.width,
    height: row.height,
    fps: row.fps,
    aspectRatio: row.aspectRatio,
    codec: row.codec,
  });
  if (!spec.success) {
    const details = spec.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    throw new RenderRequestInvalidError(`output spec — ${details}`);
  }

  return {
    renderJobId: requireString(row.id, "RenderJob.id"),
    projectId: requireString(row.projectId, "RenderJob.projectId"),
    versionId: requireString(row.versionId, "RenderJob.versionId"),
    userId: requireString(row.userId, "RenderJob.userId"),
    repoOwner: requireString(row.project.repoOwner, "Project.repoOwner"),
    repoName: requireString(row.project.repoName, "Project.repoName"),
    branchName: requireString(row.version.branchName, "ProjectVersion.branchName"),
    outputSpec: spec.data,
    runInBackground: row.runInBackground === true,
  };
}
