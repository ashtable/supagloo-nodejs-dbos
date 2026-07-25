import { describe, it, expect } from "vitest";
import { GetObjectCommand, PutObjectCommand, type S3Client } from "@aws-sdk/client-s3";
import { buildAssetKey } from "@supagloo/database-lib";
import { downloadAsset, makeInternalS3Client, uploadAsset } from "./s3-client";

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
