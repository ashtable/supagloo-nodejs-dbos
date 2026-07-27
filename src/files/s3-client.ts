import {
  DeleteObjectsCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";

/**
 * The FIRST real S3 WRITER in the codebase (design-delta §4/§8, task #32). Unlike the API
 * — which only ever PRESIGNS download URLs against the browser-reachable PUBLIC endpoint —
 * the DBOS generation/render workflows UPLOAD generated assets server-to-server against the
 * INTERNAL endpoint (`S3_ENDPOINT`, e.g. `minio:9000` inside the Docker network). So this
 * factory is deliberately internal-role-only.
 *
 * NOT promoted to database-lib (unlike the S3 KEY layout, which IS shared there): a client
 * FACTORY is wiring, not a cross-service format — writer (here) and reader (the API presign
 * route) never share a client, only the key format. Promoting it would push the heavy
 * `@aws-sdk/client-s3` dependency into every db-lib consumer for zero format benefit.
 *
 * `forcePathStyle: true` is mandatory for MinIO (no vhost-style bucket DNS).
 */
export interface S3InternalConfig {
  /** Internal endpoint (`S3_ENDPOINT`) — server-to-server, inside the Docker network. */
  endpoint: string;
  region: string;
  bucket: string;
  accessKey: string;
  secretKey: string;
}

/** Build a path-style S3 client against the INTERNAL endpoint (the only role dbos uses). */
export function makeInternalS3Client(config: S3InternalConfig): S3Client {
  return new S3Client({
    endpoint: config.endpoint,
    region: config.region,
    forcePathStyle: true,
    credentials: {
      accessKeyId: config.accessKey,
      secretAccessKey: config.secretKey,
    },
  });
}

export interface UploadAssetArgs {
  bucket: string;
  /** The object key — build with db-lib's `buildAssetKey`/`buildRender*Key` (shared format). */
  key: string;
  bytes: Buffer;
  /** The object's media type (from the download response), stored as S3 ContentType. */
  contentType?: string;
}

/**
 * PUT an asset object. Idempotent by key — a replayed/retried upload to the same
 * deterministic key overwrites the same object, so this is safe under DBOS step retry.
 */
export async function uploadAsset(
  client: S3Client,
  args: UploadAssetArgs,
): Promise<void> {
  await client.send(
    new PutObjectCommand({
      Bucket: args.bucket,
      Key: args.key,
      Body: args.bytes,
      ContentType: args.contentType,
    }),
  );
}

export interface DownloadAssetArgs {
  bucket: string;
  /** The object key — the same shared db-lib layout the writer used. */
  key: string;
}

export interface DownloadedAsset {
  bytes: Buffer;
  contentType?: string;
}

/**
 * GET an object's bytes. Task #36 makes dbos an S3 READER as well as a writer:
 * `renderWorkflow`'s `downloadSceneAssets` pulls every manifest-referenced object into
 * the render workspace's `public/` dir so `@remotion/bundler` can snapshot it INTO the
 * bundle (verified: bundle() copies `<root>/public` → `<outDir>/public`). Our buckets are
 * private, so a bundle-baked remote URL is not an option — see the plan's decision D1.
 *
 * Still internal-role, internal-endpoint: the API remains the only presigner.
 * A missing/!empty body throws rather than yielding an empty buffer, so a vanished object
 * surfaces as a step failure instead of a silently blank frame.
 */
export async function downloadAsset(
  client: S3Client,
  args: DownloadAssetArgs,
): Promise<DownloadedAsset> {
  const res = await client.send(
    new GetObjectCommand({ Bucket: args.bucket, Key: args.key }),
  );
  const body = res.Body as
    | { transformToByteArray: () => Promise<Uint8Array> }
    | undefined;
  if (!body || typeof body.transformToByteArray !== "function") {
    throw new Error(
      `S3 object ${args.bucket}/${args.key} returned no readable body`,
    );
  }
  return {
    bytes: Buffer.from(await body.transformToByteArray()),
    contentType: res.ContentType,
  };
}

/**
 * --- Plan row 42: the ONLY S3 LIST + DELETE path in the entire design ---------------
 *
 * design-delta §8:1401-1403 dropped `presign-upload` and `DELETE /v1/files` *because*
 * workflow 10 (`cleanupOrphanedAssetsWorkflow`) exists — so nothing in product code
 * deleted an object before this. These two helpers are that path, and they are the
 * mechanism by which a bug in the selection rules would become permanent data loss in
 * the single shared `supagloo-dev` bucket. They deliberately do nothing clever: no
 * recursive "delete the prefix", no `--force`, no implicit widening. The caller supplies
 * an explicit key list that `cleanup-orphaned-assets/selection.ts` has already admitted
 * through db-lib's `parseS3Key`.
 */

export interface ListAssetsArgs {
  bucket: string;
  /** Prefix to enumerate. ALWAYS as narrow as the caller can make it. */
  prefix: string;
}

/**
 * Enumerate every key under `prefix`, following `ContinuationToken` to the end.
 *
 * The pagination is not hypothetical tidiness: S3/MinIO cap a page at 1000 keys, and a
 * sweep that silently stopped at page one would leave orphans behind forever while
 * reporting success.
 */
export async function listAssets(
  client: S3Client,
  args: ListAssetsArgs,
): Promise<string[]> {
  const keys: string[] = [];
  let continuationToken: string | undefined;
  do {
    const page = await client.send(
      new ListObjectsV2Command({
        Bucket: args.bucket,
        Prefix: args.prefix,
        ContinuationToken: continuationToken,
      }),
    );
    for (const obj of page.Contents ?? []) {
      if (typeof obj.Key === "string") keys.push(obj.Key);
    }
    continuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (continuationToken);
  return keys;
}

export interface DeleteAssetsArgs {
  bucket: string;
  /** The EXACT keys to remove. Never a prefix — there is no prefix-delete here. */
  keys: string[];
}

export interface DeleteAssetsResult {
  deleted: string[];
  errors: Array<{ key?: string; code?: string; message?: string }>;
}

/** S3's hard limit on `DeleteObjects` — a larger request is rejected outright. */
const DELETE_BATCH_SIZE = 1000;

/**
 * Remove exactly the given keys, batched at S3's 1000-key limit.
 *
 * Per-key failures are RETURNED rather than thrown: `DeleteObjects` is a partial-success
 * API, and a caller that treated a 200 as "all gone" would report a clean sweep while
 * objects remained. An empty key set sends NO request at all (an empty `Delete` is a 400).
 */
export async function deleteAssets(
  client: S3Client,
  args: DeleteAssetsArgs,
): Promise<DeleteAssetsResult> {
  const result: DeleteAssetsResult = { deleted: [], errors: [] };
  for (let i = 0; i < args.keys.length; i += DELETE_BATCH_SIZE) {
    const batch = args.keys.slice(i, i + DELETE_BATCH_SIZE);
    const res = await client.send(
      new DeleteObjectsCommand({
        Bucket: args.bucket,
        Delete: { Objects: batch.map((Key) => ({ Key })) },
      }),
    );
    for (const d of res.Deleted ?? []) {
      if (typeof d.Key === "string") result.deleted.push(d.Key);
    }
    for (const e of res.Errors ?? []) {
      result.errors.push({ key: e.Key, code: e.Code, message: e.Message });
    }
  }
  return result;
}
