import { describe, it, expect } from "vitest";
import {
  DeleteObjectsCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  type S3Client,
} from "@aws-sdk/client-s3";
import { buildAssetKey } from "@supagloo/database-lib";
import {
  deleteAssets,
  downloadAsset,
  listAssets,
  makeInternalS3Client,
  uploadAsset,
} from "./s3-client";

// Task #32 — the FIRST real S3 WRITE in the codebase. The DBOS image/audio/video
// workflows upload generated assets against the INTERNAL endpoint (`S3_ENDPOINT`,
// server-to-server inside the Docker network), unlike the API which only ever
// PRESIGNS against the public endpoint. `forcePathStyle` is mandatory for MinIO. The
// key layout is the SHARED db-lib helper so writer (here) + reader (the API presign
// route) never drift.

const CFG = {
  endpoint: "http://minio:9000",
  region: "us-east-1",
  bucket: "supagloo-dev",
  accessKey: "supagloo",
  secretKey: "supagloo-dev",
};

describe("makeInternalS3Client", () => {
  it("builds a path-style client against the internal endpoint", async () => {
    const client = makeInternalS3Client(CFG);
    expect(client).toBeInstanceOf(Object);
    expect(await client.config.forcePathStyle).toBe(true);
    expect(await client.config.region()).toBe("us-east-1");
    const endpoint = await client.config.endpoint!();
    expect(endpoint.hostname).toBe("minio");
    expect(endpoint.port).toBe(9000);
  });
});

describe("uploadAsset", () => {
  it("sends a PutObjectCommand with the buildAssetKey'd Key, bucket, bytes, and content-type", async () => {
    const sent: PutObjectCommand[] = [];
    const fakeClient = {
      send: (cmd: PutObjectCommand) => {
        sent.push(cmd);
        return Promise.resolve({});
      },
    } as unknown as S3Client;

    const key = buildAssetKey("proj-1", "gen-1");
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    await uploadAsset(fakeClient, {
      bucket: "supagloo-dev",
      key,
      bytes,
      contentType: "image/png",
    });

    expect(sent).toHaveLength(1);
    expect(sent[0]).toBeInstanceOf(PutObjectCommand);
    const input = sent[0].input;
    expect(input.Bucket).toBe("supagloo-dev");
    expect(input.Key).toBe("projects/proj-1/assets/gen-1");
    expect(input.ContentType).toBe("image/png");
    expect(Buffer.isBuffer(input.Body)).toBe(true);
    expect((input.Body as Buffer).equals(bytes)).toBe(true);
  });
});

// Task #36 — dbos becomes an S3 READER too. renderWorkflow's `downloadSceneAssets`
// pulls each manifest-referenced object into the workspace `public/` dir so the
// Remotion bundle can snapshot it (plan D1): our buckets are private, so a
// bundle-baked remote URL is not an option. Still the INTERNAL endpoint / internal
// role — the API remains the only presigner.
describe("downloadAsset", () => {
  it("sends a GetObjectCommand for the bucket+key and returns the object bytes", async () => {
    const bytes = Buffer.from([1, 2, 3, 4]);
    const sent: GetObjectCommand[] = [];
    const fakeClient = {
      send: (cmd: GetObjectCommand) => {
        sent.push(cmd);
        return Promise.resolve({
          Body: {
            transformToByteArray: async () => new Uint8Array(bytes),
          },
          ContentType: "image/jpeg",
        });
      },
    } as unknown as S3Client;

    const result = await downloadAsset(fakeClient, {
      bucket: "supagloo-dev",
      key: "projects/proj-1/assets/gen-1",
    });

    expect(sent).toHaveLength(1);
    expect(sent[0]).toBeInstanceOf(GetObjectCommand);
    expect(sent[0].input.Bucket).toBe("supagloo-dev");
    expect(sent[0].input.Key).toBe("projects/proj-1/assets/gen-1");
    expect(result.bytes.equals(bytes)).toBe(true);
    expect(result.contentType).toBe("image/jpeg");
  });

  it("surfaces a missing object as an error rather than an empty buffer", async () => {
    const fakeClient = {
      send: () => Promise.resolve({ Body: undefined }),
    } as unknown as S3Client;
    await expect(
      downloadAsset(fakeClient, { bucket: "b", key: "missing" }),
    ).rejects.toThrow();
  });
});

// --- Plan row 42: the ONLY S3 LIST + DELETE path in the entire design ---------------
//
// design-delta §8:1401-1403 dropped `presign-upload` and `DELETE /v1/files` *because*
// workflow 10 (`cleanupOrphanedAssetsWorkflow`) exists, so there was no delete helper
// anywhere in product code to copy — these two are it. They are the mechanism by which a
// bug in the selection rules would become permanent data loss in the one shared bucket,
// which is why they get their own tests rather than riding on the workflow's.

describe("listAssets", () => {
  it("U-S3L1: lists a single page, prefix-scoped to exactly the requested prefix", async () => {
    const sent: ListObjectsV2Command[] = [];
    const fakeClient = {
      send: (cmd: ListObjectsV2Command) => {
        sent.push(cmd);
        return Promise.resolve({
          Contents: [{ Key: "renders/rj-1/output.mp4" }, { Key: "renders/rj-1/thumb.jpg" }],
          IsTruncated: false,
        });
      },
    } as unknown as S3Client;

    const keys = await listAssets(fakeClient, {
      bucket: "supagloo-dev",
      prefix: "renders/rj-1/",
    });

    expect(keys).toEqual(["renders/rj-1/output.mp4", "renders/rj-1/thumb.jpg"]);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toBeInstanceOf(ListObjectsV2Command);
    expect(sent[0].input.Bucket).toBe("supagloo-dev");
    // A widened prefix here would enumerate every render in the bucket.
    expect(sent[0].input.Prefix).toBe("renders/rj-1/");
  });

  it("U-S3L2: follows ContinuationToken until the listing is complete", async () => {
    const tokens: Array<string | undefined> = [];
    let call = 0;
    const fakeClient = {
      send: (cmd: ListObjectsV2Command) => {
        tokens.push(cmd.input.ContinuationToken);
        call += 1;
        if (call === 1) {
          return Promise.resolve({
            Contents: [{ Key: "a" }],
            IsTruncated: true,
            NextContinuationToken: "page-2",
          });
        }
        return Promise.resolve({ Contents: [{ Key: "b" }], IsTruncated: false });
      },
    } as unknown as S3Client;

    // Truncation is not hypothetical: S3/MinIO cap a page at 1000 keys, and a cleanup that
    // silently stopped at page 1 would leave orphans behind forever while reporting success.
    expect(
      await listAssets(fakeClient, { bucket: "supagloo-dev", prefix: "renders/" }),
    ).toEqual(["a", "b"]);
    expect(tokens).toEqual([undefined, "page-2"]);
  });

  it("U-S3L3: an empty prefix listing is an empty array, not a throw", async () => {
    const fakeClient = {
      send: () => Promise.resolve({ IsTruncated: false }),
    } as unknown as S3Client;
    expect(
      await listAssets(fakeClient, { bucket: "supagloo-dev", prefix: "renders/none/" }),
    ).toEqual([]);
  });
});

describe("deleteAssets", () => {
  it("U-S3D1: sends one DeleteObjectsCommand carrying exactly the requested keys", async () => {
    const sent: DeleteObjectsCommand[] = [];
    const fakeClient = {
      send: (cmd: DeleteObjectsCommand) => {
        sent.push(cmd);
        return Promise.resolve({
          Deleted: (cmd.input.Delete?.Objects ?? []).map((o) => ({ Key: o.Key })),
        });
      },
    } as unknown as S3Client;

    const result = await deleteAssets(fakeClient, {
      bucket: "supagloo-dev",
      keys: ["renders/rj-1/output.mp4", "renders/rj-1/thumb.jpg"],
    });

    expect(sent).toHaveLength(1);
    expect(sent[0].input.Bucket).toBe("supagloo-dev");
    expect(sent[0].input.Delete?.Objects?.map((o) => o.Key)).toEqual([
      "renders/rj-1/output.mp4",
      "renders/rj-1/thumb.jpg",
    ]);
    expect(result.deleted).toEqual([
      "renders/rj-1/output.mp4",
      "renders/rj-1/thumb.jpg",
    ]);
    expect(result.errors).toEqual([]);
  });

  it("U-S3D2: no keys ⇒ NO request at all (an empty Delete request is an S3 400)", async () => {
    const fakeClient = {
      send: () => {
        throw new Error("deleteAssets must not call S3 with an empty key set");
      },
    } as unknown as S3Client;
    expect(await deleteAssets(fakeClient, { bucket: "supagloo-dev", keys: [] })).toEqual({
      deleted: [],
      errors: [],
    });
  });

  it("U-S3D3: chunks at S3's 1000-key-per-request limit", async () => {
    const batches: number[] = [];
    const fakeClient = {
      send: (cmd: DeleteObjectsCommand) => {
        const objs = cmd.input.Delete?.Objects ?? [];
        batches.push(objs.length);
        return Promise.resolve({ Deleted: objs.map((o) => ({ Key: o.Key })) });
      },
    } as unknown as S3Client;

    const keys = Array.from({ length: 1001 }, (_, i) => `renders/rj-${i}/output.mp4`);
    const result = await deleteAssets(fakeClient, { bucket: "supagloo-dev", keys });

    expect(batches).toEqual([1000, 1]);
    expect(result.deleted).toHaveLength(1001);
  });

  it("U-S3D4: surfaces S3's per-key Errors instead of reporting a silent success", async () => {
    const fakeClient = {
      send: () =>
        Promise.resolve({
          Deleted: [{ Key: "ok" }],
          Errors: [{ Key: "denied", Code: "AccessDenied", Message: "no" }],
        }),
    } as unknown as S3Client;

    const result = await deleteAssets(fakeClient, {
      bucket: "supagloo-dev",
      keys: ["ok", "denied"],
    });

    expect(result.deleted).toEqual(["ok"]);
    expect(result.errors).toEqual([
      { key: "denied", code: "AccessDenied", message: "no" },
    ]);
  });
});
