import { describe, expect, it } from "vitest";
import { RenderRequestInvalidError } from "./errors";
import { parseRenderRequest } from "./request";

/**
 * Task #36 — parse the joined `RenderJob` (+ its Project + ProjectVersion) into the
 * small, checkpoint-safe context the workflow threads through its steps.
 *
 * The output spec lives on the RenderJob's own columns (design §2.7: width/height/fps/
 * aspectRatio/codec) rather than in a JSON blob, so "parsing" it means validating those
 * columns against the SHARED `RenderOutputSpecSchema` — the same schema the render API
 * (task 37) will validate the request body with, so the two can never drift.
 *
 * Every rejection here is PERMANENT: a malformed row will not heal on retry.
 */

const row = () => ({
  id: "rj-1",
  projectId: "proj-1",
  versionId: "ver-1",
  userId: "user-1",
  status: "queued" as const,
  framesDone: 0,
  framesTotal: 0,
  width: 1080,
  height: 1920,
  fps: 30,
  aspectRatio: "9:16",
  codec: "h264",
  outputAssetKey: null,
  thumbnailAssetKey: null,
  runInBackground: true,
  error: null,
  project: {
    id: "proj-1",
    repoOwner: "acme",
    repoName: "psalm-91",
    ownerId: "user-1",
  },
  version: { id: "ver-1", branchName: "v0.0.1", semver: "0.0.1" },
});

describe("parseRenderRequest", () => {
  it("extracts the repo coordinates, the version branch, and the output spec", () => {
    const req = parseRenderRequest(row());
    expect(req.renderJobId).toBe("rj-1");
    expect(req.projectId).toBe("proj-1");
    expect(req.versionId).toBe("ver-1");
    expect(req.userId).toBe("user-1");
    expect(req.repoOwner).toBe("acme");
    expect(req.repoName).toBe("psalm-91");
    expect(req.branchName).toBe("v0.0.1");
    expect(req.outputSpec).toEqual({
      width: 1080,
      height: 1920,
      fps: 30,
      aspectRatio: "9:16",
      codec: "h264",
    });
  });

  it("carries runInBackground through as the UI hint it is (never branches the workflow)", () => {
    expect(parseRenderRequest({ ...row(), runInBackground: false }).runInBackground).toBe(
      false,
    );
  });

  it("rejects a null row (no RenderJob for that workflow id) as PERMANENT", () => {
    expect(() => parseRenderRequest(null)).toThrow(RenderRequestInvalidError);
  });

  it("rejects a row whose output-spec columns fail RenderOutputSpecSchema", () => {
    expect(() => parseRenderRequest({ ...row(), aspectRatio: "9-16" })).toThrow(
      RenderRequestInvalidError,
    );
    expect(() => parseRenderRequest({ ...row(), fps: 0 })).toThrow(
      RenderRequestInvalidError,
    );
    expect(() => parseRenderRequest({ ...row(), codec: "" })).toThrow(
      RenderRequestInvalidError,
    );
    expect(() => parseRenderRequest({ ...row(), width: -1 })).toThrow(
      RenderRequestInvalidError,
    );
  });

  it("rejects a row missing its project/version join (repo coordinates unknowable)", () => {
    const { project: _p, ...noProject } = row();
    expect(() => parseRenderRequest(noProject)).toThrow(RenderRequestInvalidError);
    const { version: _v, ...noVersion } = row();
    expect(() => parseRenderRequest(noVersion)).toThrow(RenderRequestInvalidError);
  });

  it("rejects a version with no branch name (nothing to clone at)", () => {
    expect(() =>
      parseRenderRequest({ ...row(), version: { id: "ver-1", branchName: "", semver: "0.0.1" } }),
    ).toThrow(RenderRequestInvalidError);
  });
});
