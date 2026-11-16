import { createHash, createHmac } from "node:crypto";
import { assertSafeKey, type BlobMeta, type BlobStore } from "./blob-store.ts";

export type S3Config = { endpoint: string; region: string; bucket: string; accessKeyId: string; secretAccessKey: string };
export type S3Fetch = (url: string, init: { method: string; headers: Record<string, string>; body?: Uint8Array }) => Promise<Response>;

const sha256 = (d: string | Uint8Array) => createHash("sha256").update(d).digest("hex");
const hmac = (k: string | Buffer, d: string) => createHmac("sha256", k).update(d).digest();
const enc = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

/**
 * S3-compatible store (AWS S3, Cloudflare R2, MinIO) over `fetch` with AWS Signature V4 from node:crypto: no SDK dependency (an SDK would add megabytes for four calls).
 * Path-style URLs (`{endpoint}/{bucket}/{key}`), which all three accept. Credentials are only used to sign; they are never logged, returned or put in an error.
 * UNVERIFIED against a real endpoint: tests use a fake fetch that re-computes the signature.
 */
export class S3BlobStore implements BlobStore {
  constructor(private readonly cfg: S3Config, private readonly doFetch: S3Fetch = (u, i) => fetch(u, i as RequestInit), private readonly clock: () => Date = () => new Date()) {}

  private async call(method: "GET" | "HEAD" | "PUT" | "DELETE", key: string, body?: Uint8Array, contentType?: string): Promise<Response> {
    assertSafeKey(key);
    const url = new URL(this.cfg.endpoint);
    const path = `${url.pathname.replace(/\/$/, "")}/${enc(this.cfg.bucket)}/${key.split("/").map(enc).join("/")}`;
    const amz = this.clock().toISOString().replace(/[:-]|\.\d{3}/g, ""); // 20260101T000000Z
    const day = amz.slice(0, 8);
    const payload = sha256(body ?? "");
    const signed: Record<string, string> = { host: url.host, "x-amz-content-sha256": payload, "x-amz-date": amz };
    if (contentType) signed["content-type"] = contentType;
    const names = Object.keys(signed).sort();
    const canonical = [method, path, "", ...names.map((n) => `${n}:${signed[n]}`), "", names.join(";"), payload].join("\n");
    const scope = `${day}/${this.cfg.region}/s3/aws4_request`;
    const toSign = ["AWS4-HMAC-SHA256", amz, scope, sha256(canonical)].join("\n");
    const kSigning = hmac(hmac(hmac(hmac(`AWS4${this.cfg.secretAccessKey}`, day), this.cfg.region), "s3"), "aws4_request");
    const signature = createHmac("sha256", kSigning).update(toSign).digest("hex");
    const { host: _host, ...headers } = signed; // fetch sets Host from the URL
    headers.authorization = `AWS4-HMAC-SHA256 Credential=${this.cfg.accessKeyId}/${scope}, SignedHeaders=${names.join(";")}, Signature=${signature}`;
    return this.doFetch(`${url.origin}${path}`, { method, headers, ...(body ? { body } : {}) });
  }
  private fail(op: string, r: Response): never {
    throw new Error(`storage ${op} failed (${r.status})`); // status only: the body can echo the key or the request
  }
  async put(key: string, bytes: Uint8Array, meta: BlobMeta) {
    const r = await this.call("PUT", key, bytes, meta.contentType);
    if (!r.ok) this.fail("put", r);
    await r.body?.cancel().catch(() => {});
  }
  async head(key: string) {
    const r = await this.call("HEAD", key);
    if (r.status === 404) return null;
    if (!r.ok) this.fail("head", r);
    return { size: Number(r.headers.get("content-length") ?? 0), contentType: r.headers.get("content-type") ?? "application/octet-stream" };
  }
  async getStream(key: string) {
    const r = await this.call("GET", key);
    if (r.status === 404) { await r.body?.cancel().catch(() => {}); return null; }
    if (!r.ok || !r.body) this.fail("get", r);
    return { stream: r.body!, size: Number(r.headers.get("content-length") ?? 0), contentType: r.headers.get("content-type") ?? "application/octet-stream" };
  }
  async get(key: string) {
    const s = await this.getStream(key);
    if (!s) return null;
    return { bytes: new Uint8Array(await new Response(s.stream).arrayBuffer()), contentType: s.contentType };
  }
  async delete(key: string) {
    const r = await this.call("DELETE", key);
    await r.body?.cancel().catch(() => {});
    if (!r.ok && r.status !== 404) this.fail("delete", r);
  }
}
