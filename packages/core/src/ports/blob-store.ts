import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";

export type BlobMeta = { contentType: string };
export interface BlobStore {
  put(key: string, bytes: Uint8Array, meta: BlobMeta): Promise<void>;
  get(key: string): Promise<{ bytes: Uint8Array; contentType: string } | null>;
  delete(key: string): Promise<void>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** All blobs are namespaced by workspace so one tenant's keys can never address another's. */
export function workspaceKey(workspaceId: string, name: string): string {
  if (!UUID.test(workspaceId)) throw new Error("invalid workspace id");
  return `${workspaceId}/${name}`;
}

/** Local development implementation; production providers are chosen with hosting (decision D22). */
export class FsBlobStore implements BlobStore {
  constructor(private readonly root: string) {}

  private path(key: string): string {
    const bad = key === "" || key.startsWith("/") || key.includes("\\") || key.split("/").some((p) => p === ".." || p === "." || p === "");
    if (bad) throw new Error("invalid key");
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
  async delete(key: string) {
    const p = this.path(key);
    await rm(p, { force: true });
    await rm(p + ".meta.json", { force: true });
  }
}
