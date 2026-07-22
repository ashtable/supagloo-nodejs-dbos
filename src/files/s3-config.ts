import type { S3Client } from "@aws-sdk/client-s3";

/**
 * Process-scoped S3 configuration for the asset-uploading workflows (task #32+), injected
 * at launch (`runtime.ts` → `setS3Config`) from the validated env — the same singleton
 * discipline as `providers/config.ts`, `workflows/scaffold-project/config.ts`, and
 * `db/app-db.ts`. The upload step reads it via {@link getS3Config} so it never touches
 * `process.env`. Holds a LIVE `S3Client` (built once at launch, not per step) + the bucket.
 */
export interface S3Config {
  client: S3Client;
  bucket: string;
}

let config: S3Config | undefined;

export function setS3Config(next: S3Config): void {
  config = next;
}

export function getS3Config(): S3Config {
  if (!config) {
    throw new Error(
      "S3 config not initialized — launchDbos() must run setS3Config() before an " +
        "asset-uploading workflow executes",
    );
  }
  return config;
}

export function clearS3Config(): void {
  config?.client.destroy();
  config = undefined;
}
