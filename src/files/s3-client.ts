import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";

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
