import { FsBlobStore, type BlobStore } from "./blob-store.ts";
import { S3BlobStore } from "./s3-blob-store.ts";

export type StorageEnv = {
  STORAGE_DRIVER?: string; STORAGE_LOCAL_DIR?: string;
  S3_ENDPOINT?: string; S3_REGION?: string; S3_BUCKET?: string; S3_ACCESS_KEY_ID?: string; S3_SECRET_ACCESS_KEY?: string;
};

/**
 * Picks the provider from env. Returns undefined when nothing is configured (the default): the attachment feature then degrades to metadata only and uploads answer `storage_not_configured`.
 * A half-configured driver throws at startup rather than failing on the first upload.
 */
export function createBlobStore(env: StorageEnv): BlobStore | undefined {
  const driver = (env.STORAGE_DRIVER ?? "").trim().toLowerCase();
  if (driver === "" || driver === "none") return undefined;
  if (driver === "local") {
    if (!env.STORAGE_LOCAL_DIR) throw new Error("STORAGE_DRIVER=local needs STORAGE_LOCAL_DIR");
    return new FsBlobStore(env.STORAGE_LOCAL_DIR);
  }
  if (driver === "s3") {
    const { S3_ENDPOINT: endpoint, S3_BUCKET: bucket, S3_ACCESS_KEY_ID: accessKeyId, S3_SECRET_ACCESS_KEY: secretAccessKey } = env;
    if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) throw new Error("STORAGE_DRIVER=s3 needs S3_ENDPOINT, S3_BUCKET, S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY");
    return new S3BlobStore({ endpoint, bucket, accessKeyId, secretAccessKey, region: env.S3_REGION || "auto" });
  }
  throw new Error("STORAGE_DRIVER must be local, s3 or none");
}
