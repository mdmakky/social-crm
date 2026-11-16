import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readdirSync, readFileSync } from "node:fs";
import { FileMailer, MemoryMailer, type Mailer } from "../src/ports/mailer.ts";
import { attachmentKey, FsBlobStore, workspaceKey, type BlobStore } from "../src/ports/blob-store.ts";
import { S3BlobStore } from "../src/ports/s3-blob-store.ts";
import { createBlobStore } from "../src/ports/blob-store-factory.ts";

function mailerContract(name: string, make: () => Mailer) {
  describe(`Mailer contract: ${name}`, () => {
    it("returns a message id", async () => {
      const r = await make().send({ to: "a@example.com", subject: "Hi", text: "Hello" });
      expect(r.id).toMatch(/\S+/);
    });
    it("rejects an invalid recipient", async () => {
      await expect(make().send({ to: "not-an-email", subject: "x", text: "y" })).rejects.toThrow(/recipient/);
    });
  });
}
mailerContract("MemoryMailer", () => new MemoryMailer());
const mailDirs: string[] = [];
mailerContract("FileMailer", () => {
  const d = mkdtempSync(join(tmpdir(), "mail-"));
  mailDirs.push(d);
  return new FileMailer(d);
});
describe("FileMailer (local development adapter)", () => {
  it("writes one JSON file per message that tests and developers can read", async () => {
    const d = mkdtempSync(join(tmpdir(), "mail-"));
    mailDirs.push(d);
    const m = new FileMailer(d);
    const { id } = await m.send({ to: "a@example.com", subject: "Reset", text: "link: https://x/y" });
    const files = readdirSync(d);
    expect(files).toHaveLength(1);
    expect(files[0]).toContain(id);
    expect(JSON.parse(readFileSync(join(d, files[0]!), "utf8"))).toMatchObject({ id, to: "a@example.com", subject: "Reset", text: "link: https://x/y" });
  });
  it("lists messages for a recipient, newest last", async () => {
    const d = mkdtempSync(join(tmpdir(), "mail-"));
    mailDirs.push(d);
    const m = new FileMailer(d);
    await m.send({ to: "a@example.com", subject: "1", text: "t" });
    await m.send({ to: "b@example.com", subject: "x", text: "t" });
    await m.send({ to: "a@example.com", subject: "2", text: "t" });
    expect((await m.messagesFor("a@example.com")).map((x) => x.subject)).toEqual(["1", "2"]);
  });
});
describe("MemoryMailer", () => {
  it("keeps sent messages for inspection", async () => {
    const m = new MemoryMailer();
    await m.send({ to: "a@example.com", subject: "Welcome", text: "t" });
    expect(m.outbox.map((x) => x.subject)).toEqual(["Welcome"]);
  });
});

function blobContract(name: string, make: () => Promise<BlobStore>) {
  describe(`BlobStore contract: ${name}`, () => {
    it("round-trips bytes and content type", async () => {
      const s = await make();
      await s.put("ws/a/file.txt", new TextEncoder().encode("hello"), { contentType: "text/plain" });
      const got = await s.get("ws/a/file.txt");
      expect(new TextDecoder().decode(got!.bytes)).toBe("hello");
      expect(got!.contentType).toBe("text/plain");
    });
    it("returns null for a missing key and deletes idempotently", async () => {
      const s = await make();
      expect(await s.get("ws/a/nope")).toBeNull();
      await s.delete("ws/a/nope");
    });
    it("deletes an existing object", async () => {
      const s = await make();
      await s.put("ws/a/x", new Uint8Array([1]), { contentType: "application/octet-stream" });
      await s.delete("ws/a/x");
      expect(await s.get("ws/a/x")).toBeNull();
    });
    it("head and getStream report size and type; both are null when missing", async () => {
      const s = await make();
      await s.put("ws/a/h", new Uint8Array([1, 2, 3]), { contentType: "image/png" });
      expect(await s.head("ws/a/h")).toEqual({ size: 3, contentType: "image/png" });
      const st = await s.getStream("ws/a/h");
      expect([...new Uint8Array(await new Response(st!.stream).arrayBuffer())]).toEqual([1, 2, 3]);
      expect(await s.head("ws/a/none")).toBeNull();
      expect(await s.getStream("ws/a/none")).toBeNull();
    });
    it("rejects path traversal and absolute keys", async () => {
      const s = await make();
      for (const k of ["../escape", "ws/../../escape", "/abs", "a\\b", ""]) {
        await expect(s.put(k, new Uint8Array([1]), { contentType: "x/y" })).rejects.toThrow(/invalid key/);
      }
    });
  });
}
const dirs: string[] = [];
blobContract("FsBlobStore", async () => {
  const d = mkdtempSync(join(tmpdir(), "blob-"));
  dirs.push(d);
  return new FsBlobStore(d);
});
/** In-memory fake of an S3 endpoint (path style). Checks that every request is signed and that the secret never travels. */
const SECRET = "s3cr3t-key-value";
function fakeS3() {
  const objects = new Map<string, { body: Uint8Array; type: string }>();
  const seen: { method: string; url: string; auth: string }[] = [];
  const fetch = async (url: string, init: { method: string; headers: Record<string, string>; body?: Uint8Array }) => {
    const auth = init.headers.authorization ?? "";
    seen.push({ method: init.method, url, auth });
    expect(auth).toMatch(/^AWS4-HMAC-SHA256 Credential=AKID\/\d{8}\/auto\/s3\/aws4_request, SignedHeaders=(content-type;)?host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/);
    expect(JSON.stringify(init.headers)).not.toContain(SECRET);
    const key = new URL(url).pathname;
    if (init.method === "PUT") { objects.set(key, { body: init.body!, type: init.headers["content-type"] ?? "" }); return new Response(null, { status: 200 }); }
    const o = objects.get(key);
    if (init.method === "DELETE") { objects.delete(key); return new Response(null, { status: 204 }); }
    if (!o) return new Response("<Error/>", { status: 404 });
    return new Response(init.method === "HEAD" ? null : (o.body as unknown as BodyInit), { status: 200, headers: { "content-type": o.type, "content-length": String(o.body.length) } });
  };
  return { fetch, objects, seen };
}
let lastS3: ReturnType<typeof fakeS3>;
blobContract("S3BlobStore (fake endpoint)", async () => {
  lastS3 = fakeS3();
  return new S3BlobStore({ endpoint: "https://acct.r2.example", region: "auto", bucket: "crm", accessKeyId: "AKID", secretAccessKey: SECRET }, lastS3.fetch);
});
describe("S3BlobStore", () => {
  it("uses path-style URLs and signs with SigV4; errors carry only the status", async () => {
    const f = fakeS3();
    const s = new S3BlobStore({ endpoint: "https://acct.r2.example", region: "auto", bucket: "crm", accessKeyId: "AKID", secretAccessKey: SECRET }, f.fetch);
    await s.put("workspaces/w/attachments/a", new Uint8Array([9]), { contentType: "image/png" });
    expect(f.seen[0]!.url).toBe("https://acct.r2.example/crm/workspaces/w/attachments/a");
    expect(f.seen[0]!.auth).toMatch(/Signature=[0-9a-f]{64}$/);
    const bad = new S3BlobStore({ endpoint: "https://acct.r2.example", region: "auto", bucket: "crm", accessKeyId: "AKID", secretAccessKey: SECRET }, async () => new Response("secret body", { status: 500 }));
    await expect(bad.put("a/b", new Uint8Array([1]), { contentType: "x/y" })).rejects.toThrow(/^storage put failed \(500\)$/);
  });
});
describe("createBlobStore", () => {
  it("is undefined when unconfigured, validates the driver and its settings", () => {
    expect(createBlobStore({})).toBeUndefined();
    expect(createBlobStore({ STORAGE_DRIVER: "none" })).toBeUndefined();
    expect(() => createBlobStore({ STORAGE_DRIVER: "local" })).toThrow(/STORAGE_LOCAL_DIR/);
    expect(() => createBlobStore({ STORAGE_DRIVER: "s3", S3_BUCKET: "b" })).toThrow(/S3_ENDPOINT/);
    expect(() => createBlobStore({ STORAGE_DRIVER: "gcs" })).toThrow(/must be/);
    expect(createBlobStore({ STORAGE_DRIVER: "local", STORAGE_LOCAL_DIR: "/tmp/x" })).toBeInstanceOf(FsBlobStore);
  });
});
describe("attachmentKey", () => {
  const W = "11111111-1111-4111-8111-111111111111", A = "22222222-2222-4222-8222-222222222222";
  it("has the fixed layout and refuses non-uuid parts", () => {
    expect(attachmentKey(W, A)).toBe(`workspaces/${W}/attachments/${A}`);
    expect(() => attachmentKey("../x", A)).toThrow();
    expect(() => attachmentKey(W, "../../etc/passwd")).toThrow();
  });
  it("local store lists keys under a prefix and ignores sidecar files", async () => {
    const d = mkdtempSync(join(tmpdir(), "blob-")); dirs.push(d);
    const s = new FsBlobStore(d);
    await s.put(attachmentKey(W, A), new Uint8Array([1]), { contentType: "image/png" });
    expect(await s.list!(`workspaces/${W}`)).toEqual([`workspaces/${W}/attachments/${A}`]);
  });
});
describe("workspaceKey", () => {
  it("namespaces keys per workspace", () => {
    expect(workspaceKey("11111111-1111-4111-8111-111111111111", "exports/a.csv")).toBe("11111111-1111-4111-8111-111111111111/exports/a.csv");
  });
  it("rejects a non-uuid workspace", () => {
    expect(() => workspaceKey("../x", "a")).toThrow(/workspace/);
  });
});
import { afterAll } from "vitest";
afterAll(() => [...dirs, ...mailDirs].forEach((d) => rmSync(d, { recursive: true, force: true })));
