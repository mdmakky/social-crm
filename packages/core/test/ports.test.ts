import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readdirSync, readFileSync } from "node:fs";
import { FileMailer, MemoryMailer, type Mailer } from "../src/ports/mailer.ts";
import { FsBlobStore, workspaceKey, type BlobStore } from "../src/ports/blob-store.ts";

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
