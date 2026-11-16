import { createHmac } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { attachmentKey, FsBlobStore } from "@crm/core";
import { createDb, type Db } from "@crm/db";
import { createMockGraph, createSecretBox, SendError } from "@crm/integrations";
import type { MetaConnectDeps } from "../src/inbox/meta-connect.ts";
import { bootstrap, type Harness, type TestUser } from "./harness.ts";

// Sending a file from the composer. WhatsApp only, MOCK graph: this proves our pipeline, NOT that Meta accepts the upload or the message (UNVERIFIED).
const DB = process.env.CRM_DB_NAME ?? "crm";
const box = createSecretBox({ k1: Buffer.alloc(32, 9).toString("base64") }, "k1");
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]), Buffer.from("PIX")]);
const GIF = Buffer.from("GIF89a-----");
let h: Harness, hNone: Harness, workerDb: Db, graph: ReturnType<typeof createMockGraph>, dir: string, store: FsBlobStore;
let owner: TestUser, viewer: TestUser;
let ws = "";
const accounts: string[] = [];
const digits = () => `8${Math.floor(Math.random() * 1e13).toString().padStart(13, "0")}`;
const q = async (text: string, params: unknown[] = []) => (await h.admin.query(text, params)).rows;
const uuid = () => crypto.randomUUID();
const post = (u: TestUser, path: string, body: unknown, hh = h) => hh.app.request(path, { method: "POST", headers: { cookie: u.cookie, origin: "http://localhost:3000", "content-type": "application/json" }, body: JSON.stringify(body) });
const SEND = (w: string, c: string) => `/v1/workspaces/${w}/conversations/${c}/messages`;
const mediaCalls = () => graph.calls.filter((c) => c.startsWith("sendwamedia:"));
const reset = (over: Parameters<typeof createMockGraph>[0] = {}) => { graph.calls.length = 0; Object.assign(graph.state, { sends: [], onSend: undefined, ...over }); };

async function setup(platform: "whatsapp" | "messenger") {
  const [a] = await q("INSERT INTO integration_accounts (workspace_id, platform, external_account_id, status, display_name) VALUES ($1,$2,$3,'connected','x') RETURNING id", [ws, platform, digits()]);
  accounts.push(a.id);
  const s = box.seal("TOKEN", `${ws}:${a.id}`);
  await q("INSERT INTO integration_secrets (workspace_id, integration_account_id, version, ciphertext, nonce, key_id) VALUES ($1,$2,1,$3,$4,$5)", [ws, a.id, s.ciphertext, s.nonce, s.keyId]);
  const [stage] = await q("SELECT id FROM lifecycle_stages WHERE workspace_id=$1 ORDER BY position LIMIT 1", [ws]);
  const [ct] = await q("INSERT INTO contacts (workspace_id, name, lifecycle_stage_id) VALUES ($1,'C',$2) RETURNING id", [ws, stage.id]);
  const [idn] = await q("INSERT INTO platform_identities (workspace_id, integration_account_id, external_user_id, contact_id) VALUES ($1,$2,$3,$4) RETURNING id", [ws, a.id, digits(), ct.id]);
  const [cv] = await q("INSERT INTO conversations (workspace_id, integration_account_id, identity_id, contact_id) VALUES ($1,$2,$3,$4) RETURNING id", [ws, a.id, idn.id, ct.id]);
  const at = new Date(Date.now() - 5 * 60_000).toISOString();
  await q("INSERT INTO messages (workspace_id, conversation_id, integration_account_id, direction, external_id, sender_kind, body, delivery_state, occurred_at) VALUES ($1,$2,$3,'in',$4,'contact','hi','received',$5)", [ws, cv.id, a.id, `in.${uuid()}`, at]);
  await q("UPDATE conversations SET last_inbound_at=$2::timestamptz, last_message_at=$2::timestamptz WHERE id=$1", [cv.id, at]);
  return cv.id as string;
}
const upload = async (conv: string, mime: string, bytes: Buffer, filename = "pic.png") => {
  const r = await post(owner, `/v1/workspaces/${ws}/conversations/${conv}/attachments`, { filename, mime, contentBase64: bytes.toString("base64") });
  expect(r.status).toBe(201);
  return (await r.json()).id as string;
};

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "att-send-"));
  store = new FsBlobStore(dir);
  workerDb = createDb(`postgres://crm_worker:worker_dev@127.0.0.1:5436/${DB}`);
  graph = createMockGraph({ pages: [] });
  const deps: MetaConnectDeps = {
    graph, box, workerDb, appId: "123456", configId: "654321", graphVersion: "v25.0", redirectUri: "http://localhost:3000/v1/integrations/meta/callback", webOrigin: "http://localhost:3000",
    stateKey: createHmac("sha256", "k").update("s").digest(), userHashKey: createHmac("sha256", "k").update("u").digest(), mock: true, secureCookies: false,
  };
  h = await bootstrap(undefined, deps, undefined, { store, uploadsPerUser: 1000 });
  hNone = await bootstrap(undefined, deps);
  [owner, viewer] = (await Promise.all(["asowner", "asviewer"].map((l) => h.newUser(l)))) as [TestUser, TestUser];
  ws = await h.workspace(owner, "Att send", { viewer });
});
afterAll(async () => {
  if (accounts.length) await q("UPDATE integration_accounts SET last_token_check_at = now(), status = 'disabled' WHERE id = ANY($1::uuid[])", [accounts]);
  await workerDb.$client.end();
  await h.close(); await hNone.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("sending a file", () => {
  it("WhatsApp: the file goes out through the media send, the text is the caption, the attachment is linked to the message, no token in rows", async () => {
    const conv = await setup("whatsapp");
    const id = await upload(conv, "image/png", PNG);
    reset({ sends: ["wamid.media.1"] });
    const res = await post(owner, SEND(ws, conv), { clientMsgId: uuid(), body: "your receipt", attachmentIds: [id] });
    expect(res.status).toBe(201);
    const j = await res.json();
    expect(j.message).toMatchObject({ direction: "out", deliveryState: "sent", body: "your receipt" });
    expect(mediaCalls()).toHaveLength(1);
    expect(mediaCalls()[0]).toMatch(/:image:image\/png:\d+:your receipt$/);
    const [m] = await q("SELECT * FROM messages WHERE conversation_id=$1 AND direction='out'", [conv]);
    expect(m).toMatchObject({ external_id: "wamid.media.1", delivery_state: "sent" });
    expect(m.attachments).toEqual([{ type: "image", url: null, attachmentId: id }]);
    expect((await q("SELECT message_id FROM attachments WHERE id=$1", [id]))[0].message_id).toBe(m.id);
    const [att] = await q("SELECT request_summary FROM outbound_attempts WHERE message_id=$1", [m.id]);
    expect(att.request_summary).toMatchObject({ kind: "media", mediaKind: "image" });
    expect(JSON.stringify(att)).not.toContain("your receipt");
    // the same file cannot be sent twice
    const again = await post(owner, SEND(ws, conv), { clientMsgId: uuid(), body: "", attachmentIds: [id] });
    expect([again.status, (await again.json()).error.code]).toEqual([422, "attachment_unavailable"]);
    expect(mediaCalls()).toHaveLength(1);
  });

  it("a file alone (no text) is a valid message; text-only sending is unchanged", async () => {
    const conv = await setup("whatsapp");
    const id = await upload(conv, "image/png", PNG);
    reset();
    expect((await post(owner, SEND(ws, conv), { clientMsgId: uuid(), body: "", attachmentIds: [id] })).status).toBe(201);
    expect(mediaCalls()[0]).toMatch(/:image:image\/png:\d+:$/);
    const empty = await post(owner, SEND(ws, conv), { clientMsgId: uuid(), body: "" });
    expect([empty.status, (await empty.json()).error.message]).toEqual([400, "Write a message first"]);
    reset();
    expect((await post(owner, SEND(ws, conv), { clientMsgId: uuid(), body: "plain" })).status).toBe(201);
    expect(graph.calls.filter((c) => c.startsWith("sendwa:"))).toHaveLength(1);
    expect(mediaCalls()).toHaveLength(0);
  });

  it("other channels refuse with unsupported_channel_media and store nothing; unsupported WhatsApp types too; foreign or unknown ids are unavailable", async () => {
    const msgr = await setup("messenger");
    const id = await upload(msgr, "image/png", PNG);
    reset();
    const r = await post(owner, SEND(ws, msgr), { clientMsgId: uuid(), body: "x", attachmentIds: [id] });
    expect([r.status, (await r.json()).error.code]).toEqual([422, "unsupported_channel_media"]);
    expect(await q("SELECT 1 FROM messages WHERE conversation_id=$1 AND direction='out'", [msgr])).toEqual([]);
    expect((await q("SELECT message_id FROM attachments WHERE id=$1", [id]))[0].message_id).toBeNull();
    const wa = await setup("whatsapp");
    const gif = await upload(wa, "image/gif", GIF, "a.gif");
    const g = await post(owner, SEND(ws, wa), { clientMsgId: uuid(), body: "x", attachmentIds: [gif] });
    expect([g.status, (await g.json()).error.code]).toEqual([422, "unsupported_channel_media"]);
    const other = await post(owner, SEND(ws, wa), { clientMsgId: uuid(), body: "x", attachmentIds: [id] }); // an attachment of ANOTHER conversation
    expect([other.status, (await other.json()).error.code]).toEqual([422, "attachment_unavailable"]);
    expect((await post(owner, SEND(ws, wa), { clientMsgId: uuid(), body: "x", attachmentIds: [uuid()] })).status).toBe(422);
    expect(mediaCalls()).toHaveLength(0);
  });

  it("a refusal by Meta is a definite failure; a vanished blob fails with file_missing and nothing is sent; no store: storage_not_configured; viewers cannot send", async () => {
    const conv = await setup("whatsapp");
    const id = await upload(conv, "image/png", PNG);
    reset({ sends: [new SendError("rejected", 400, 100, null)] });
    const r = await post(owner, SEND(ws, conv), { clientMsgId: uuid(), body: "", attachmentIds: [id] });
    expect((await r.json()).message).toMatchObject({ deliveryState: "failed", failureCode: "invalid_request" });
    const conv2 = await setup("whatsapp");
    const id2 = await upload(conv2, "image/png", PNG);
    await store.delete(attachmentKey(ws, id2));
    reset();
    const r2 = await post(owner, SEND(ws, conv2), { clientMsgId: uuid(), body: "", attachmentIds: [id2] });
    expect((await r2.json()).message).toMatchObject({ deliveryState: "failed", failureCode: "file_missing" });
    expect(mediaCalls()).toHaveLength(0);
    const n = await post(owner, SEND(ws, conv2), { clientMsgId: uuid(), body: "x", attachmentIds: [uuid()] }, hNone);
    expect([n.status, (await n.json()).error.code]).toEqual([503, "storage_not_configured"]);
    expect((await post(viewer, SEND(ws, conv), { clientMsgId: uuid(), body: "", attachmentIds: [id] })).status).toBe(403);
  });
});
