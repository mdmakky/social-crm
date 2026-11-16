import { createReadStream } from "node:fs";
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { Readable } from "node:stream";

export type BlobMeta = { contentType: string };
export type BlobHead = { size: number; contentType: string };
/**
 * Binary storage port. Business code never knows the provider: `STORAGE_DRIVER` picks LocalFsBlobStore (dev, tests) or S3BlobStore (R2, S3, MinIO) in `createBlobStore`.
 * Keys are built by `attachmentKey` / `workspaceKey` only, never from user input. Binary data is never stored in PostgreSQL.
 */
export interface BlobStore {
  put(key: string, bytes: Uint8Array, meta: BlobMeta): Promise<void>;
  get(key: string): Promise<{ bytes: Uint8Array; contentType: string } | null>;
  /** Streams the object so a large file is never held twice in memory. null when missing. */
  getStream(key: string): Promise<{ stream: ReadableStream<Uint8Array>; size: number; contentType: string } | null>;
  /** Size and content type without the body. null when missing. */
  head(key: string): Promise<BlobHead | null>;
  /** Idempotent: a missing key is not an error. */
  delete(key: string): Promise<void>;
  /** Keys under a prefix. Only the local store implements it (tests and the reconcile check); providers leave it undefined. */
  list?(prefix: string): Promise<string[]>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** All blobs are namespaced by workspace so one tenant's keys can never address another's. */
export function workspaceKey(workspaceId: string, name: string): string {
  if (!UUID.test(workspaceId)) throw new Error("invalid workspace id");
  return `${workspaceId}/${name}`;
}

/** The only key layout for attachment bytes: `workspaces/{workspaceId}/attachments/{attachmentId}`. Both parts must be UUIDs. */
export function attachmentKey(workspaceId: string, attachmentId: string): string {
  if (!UUID.test(workspaceId) || !UUID.test(attachmentId)) throw new Error("invalid id");
  return `workspaces/${workspaceId.toLowerCase()}/attachments/${attachmentId.toLowerCase()}`;
}

/** Rejects empty, absolute, dotted, backslash, NUL or empty-segment keys. Shared by every implementation. */
export function assertSafeKey(key: string): void {
  const bad = key === "" || key.length > 600 || key.startsWith("/") || key.includes("\\") || key.includes("\0") || key.split("/").some((p) => p === ".." || p === "." || p === "");
  if (bad) throw new Error("invalid key");
}

/** Local development / test implementation (directory from `STORAGE_LOCAL_DIR`). Resolved paths must stay inside the root. */
export class FsBlobStore implements BlobStore {
  constructor(private readonly root: string) {}

  private path(key: string): string {
    assertSafeKey(key);
    const full = resolve(this.root, key);
    if (!full.startsWith(resolve(this.root) + sep)) throw new Error("invalid key");
    return full;
  }
  async put(key: string, bytes: Uint8Array, meta: BlobMeta) {
    const p = this.path(key);
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p, bytes);
    await writeFile(p + ".meta.json", JSON.stringify(meta));
  }
  async get(key: string) {
    const p = this.path(key);
    try {
      const [bytes, meta] = await Promise.all([readFile(p), readFile(p + ".meta.json", "utf8")]);
      return { bytes: new Uint8Array(bytes), contentType: (JSON.parse(meta) as BlobMeta).contentType };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw e;
    }
  }
  async head(key: string) {
    const p = this.path(key);
    try {
      const [s, meta] = await Promise.all([stat(p), readFile(p + ".meta.json", "utf8")]);
      return { size: s.size, contentType: (JSON.parse(meta) as BlobMeta).contentType };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw e;
    }
  }
  async getStream(key: string) {
    const h = await this.head(key);
    if (!h) return null;
    return { stream: Readable.toWeb(createReadStream(this.path(key))) as ReadableStream<Uint8Array>, ...h };
  }
  async delete(key: string) {
    const p = this.path(key);
    await rm(p, { force: true });
    await rm(p + ".meta.json", { force: true });
  }
  async list(prefix: string) {
    assertSafeKey(prefix);
    const out: string[] = [];
    const walk = async (dir: string, rel: string): Promise<void> => {
      let entries;
      try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        if (e.isDirectory()) await walk(resolve(dir, e.name), `${rel}/${e.name}`);
        else if (!e.name.endsWith(".meta.json")) out.push(`${rel}/${e.name}`);
      }
    };
    await walk(this.path(prefix), prefix);
    return out;
  }
}
export { FsBlobStore as LocalFsBlobStore };
