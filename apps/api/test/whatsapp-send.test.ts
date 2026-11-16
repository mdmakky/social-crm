import { createHmac } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { createDb, type Db } from "@crm/db";
import { buildWhatsAppBody, buildWhatsAppChange, createMockGraph, createSecretBox, mockSecret, SendError, signMetaBody } from "@crm/integrations";
import type { MetaConnectDeps } from "../src/inbox/meta-connect.ts";
import { processWebhookEvent } from "../src/inbox/process.ts";
import { metaWebhookRoutes } from "../src/inbox/webhook.ts";
import { bootstrap, type Harness, type TestUser } from "./harness.ts";

// WhatsApp slice 3: outbound text, MOCK graph. Proves our pipeline and the 24 hour rule, not Meta's behaviour (UNVERIFIED).
const DB = process.env.CRM_DB_NAME ?? "crm";
const box = createSecretBox({ k1: Buffer.alloc(32, 9).toString("base64") }, "k1");
const TOKEN = "WA-SYSTEM-TOKEN-must-never-leak";
let h: Harness, workerDb: Db, ingestDb: Db, hook: Hono, graph: ReturnType<typeof createMockGraph>;
let owner: TestUser, agent: TestUser, viewer: TestUser, other: TestUser;
let ws: string, wsOther: string;
const accounts: string[] = [];
const digits = () => `8${Math.floor(Math.random() * 1e13).toString().padStart(13, "0")}`;
const q = async (text: string, params: unknown[] = []) => (await h.admin.query(text, params)).rows;
const uuid = () => crypto.randomUUID();
const call = (u: TestUser, path: string, body?: unknown) =>
  h.app.request(path, { method: "POST", headers: { cookie: u.cookie, origin: "http://localhost:3000", "content-type": "application/json" }, body: JSON.stringify(body) });
const SEND = (w: string, c: string) => `/v1/workspaces/${w}/conversations/${c}/messages`;

async function setup(w: string, o: { inboundMinsAgo?: number | null; status?: string } = {}) {
  const phone = digits();
  const [a] = await q("INSERT INTO integration_accounts (workspace_id, platform, external_account_id, status, display_name) VALUES ($1,'whatsapp',$2,$3,'+1 555 0100') RETURNING id", [w, phone, o.status ?? "connected"]);
  accounts.push(a.id);
  const s = box.seal(TOKEN, `${w}:${a.id}`);
  await q("INSERT INTO integration_secrets (workspace_id, integration_account_id, version, ciphertext, nonce, key_id) VALUES ($1,$2,1,$3,$4,$5)", [w, a.id, s.ciphertext, s.nonce, s.keyId]);
  const [stage] = await q("SELECT id FROM lifecycle_stages WHERE workspace_id=$1 ORDER BY position LIMIT 1", [w]);
  const [ct] = await q("INSERT INTO contacts (workspace_id, name, lifecycle_stage_id, source) VALUES ($1,'Customer',$2,'whatsapp') RETURNING id", [w, stage.id]);
  const waId = digits();
  const [idn] = await q("INSERT INTO platform_identities (workspace_id, integration_account_id, external_user_id, contact_id) VALUES ($1,$2,$3,$4) RETURNING id", [w, a.id, waId, ct.id]);
  const [cv] = await q("INSERT INTO conversations (workspace_id, integration_account_id, identity_id, contact_id) VALUES ($1,$2,$3,$4) RETURNING id", [w, a.id, idn.id, ct.id]);
  const mins = o.inboundMinsAgo === undefined ? 5 : o.inboundMinsAgo;
  if (mins !== null) {
    const at = new Date(Date.now() - mins * 60_000).toISOString();
    await q("INSERT INTO messages (workspace_id, conversation_id, integration_account_id, direction, external_id, sender_kind, body, delivery_state, occurred_at) VALUES ($1,$2,$3,'in',$4,'contact','hi','received',$5)", [w, cv.id, a.id, `wamid.in.${uuid()}`, at]);
    await q("UPDATE conversations SET last_inbound_at=$2::timestamptz, last_message_at=$2::timestamptz WHERE id=$1", [cv.id, at]);
  }
  return { account: a.id as string, phone, waId, conv: cv.id as string };
}
const outRows = (conv: string) => q("SELECT * FROM messages WHERE conversation_id=$1 AND direction='out' ORDER BY seq", [conv]);
const sends = () => graph.calls.filter((c) => c.startsWith("sendwa:"));
const reset = (over: Parameters<typeof createMockGraph>[0] = {}) => { graph.calls.length = 0; Object.assign(graph.state, { sends: [], onSend: undefined, ...over }); };

beforeAll(async () => {
  workerDb = createDb(`postgres://crm_worker:worker_dev@127.0.0.1:5436/${DB}`);
  ingestDb = createDb(`postgres://crm_ingest:ingest_dev@127.0.0.1:5436/${DB}`);
  hook = new Hono().route("/webhooks/meta", metaWebhookRoutes({ appSecrets: [mockSecret], verifyToken: "v", ingestDb }));
  graph = createMockGraph({ pages: [] });
  const deps: MetaConnectDeps = {
    graph, box, workerDb, appId: "123456", configId: "654321", graphVersion: "v25.0", redirectUri: "http://localhost:3000/v1/integrations/meta/callback", webOrigin: "http://localhost:3000",
    stateKey: createHmac("sha256", "k").update("s").digest(), userHashKey: createHmac("sha256", "k").update("u").digest(), mock: true, secureCookies: false,
  };
  h = await bootstrap(undefined, deps);
  [owner, agent, viewer, other] = (await Promise.all(["wsowner", "wsagent", "wsviewer", "wsother"].map((l) => h.newUser(l)))) as TestUser[] as [TestUser, TestUser, TestUser, TestUser];
  ws = await h.workspace(owner, "WASend A", { agent, viewer });
  wsOther = await h.workspace(other, "WASend B");
});
afterAll(async () => {
  if (accounts.length) await q("UPDATE integration_accounts SET last_token_check_at = now(), status = 'disabled' WHERE id = ANY($1::uuid[])", [accounts]);
  await workerDb.$client.end();
  await ingestDb.$client.end();
  await h.close();
});

describe("WhatsApp text reply", () => {
  it("sends to the contact's wa_id from the number's phone number id, stores sent + wamid, no token or text in attempt/audit", async () => {
    const s = await setup(ws);
    reset({ sends: ["wamid.out.1"] });
    const res = await call(agent, SEND(ws, s.conv), { clientMsgId: uuid(), body: "  Hello there  " });
    expect(res.status).toBe(201);
    const j = await res.json();
    expect(j.message).toMatchObject({ direction: "out", deliveryState: "sent", body: "Hello there" });
    expect(sends()).toEqual([`sendwa:${s.phone}:${s.waId}:Hello there`]);
    const [row] = await outRows(s.conv);
    expect(row).toMatchObject({ external_id: "wamid.out.1", delivery_state: "sent" });
    const [att] = await q("SELECT * FROM outbound_attempts WHERE message_id=$1", [row.id]);
    expect(att).toMatchObject({ outcome: "accepted" });
    const [audit] = await q("SELECT summary FROM audit_log WHERE entity_id=$1 AND action='message.send_requested'", [row.id]);
    expect(JSON.stringify([att, audit])).not.toContain("Hello");
    expect(JSON.stringify([j, att, audit])).not.toContain(TOKEN);
  });

  it("repeating a client id (even concurrently) returns the stored message and sends once", async () => {
    const s = await setup(ws);
    reset();
    const id = uuid();
    const rs = await Promise.all([1, 2, 3].map(() => call(owner, SEND(ws, s.conv), { clientMsgId: id, body: "once" })));
    expect(rs.map((r) => r.status).sort()).toEqual([200, 200, 201]);
    expect(sends()).toHaveLength(1);
    expect(await outRows(s.conv)).toHaveLength(1);
    expect((await call(owner, SEND(ws, s.conv), { clientMsgId: id, body: "once" })).status).toBe(200);
    expect(sends()).toHaveLength(1);
  });

  it("24 hour window: closed (or no inbound at all) is 422 window_closed and nothing is stored or sent; just inside still sends", async () => {
    const old = await setup(ws, { inboundMinsAgo: 24 * 60 + 1 });
    const none = await setup(ws, { inboundMinsAgo: null });
    const edge = await setup(ws, { inboundMinsAgo: 24 * 60 - 5 });
    reset();
    for (const s of [old, none]) {
      const res = await call(owner, SEND(ws, s.conv), { clientMsgId: uuid(), body: "late" });
      expect(res.status).toBe(422);
      expect((await res.json()).error.code).toBe("window_closed");
      expect(await outRows(s.conv)).toHaveLength(0);
    }
    expect(sends()).toHaveLength(0);
    expect((await call(owner, SEND(ws, edge.conv), { clientMsgId: uuid(), body: "just in time" })).status).toBe(201);
    expect(sends()).toHaveLength(1);
  });

  it("a number that needs attention (not connected) is refused with 409", async () => {
    const s = await setup(ws, { status: "reauth_required" });
    reset();
    const res = await call(owner, SEND(ws, s.conv), { clientMsgId: uuid(), body: "x" });
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe("account_not_connected");
    expect(sends()).toHaveLength(0);
  });

  it("a timeout is UNKNOWN: kept, never re-sent, not marked failed; a refusal is a definite failure", async () => {
    const s = await setup(ws);
    reset({ sends: [new SendError("ambiguous", null, null, null)] });
    const res = await call(owner, SEND(ws, s.conv), { clientMsgId: uuid(), body: "maybe" });
    expect((await res.json()).message).toMatchObject({ deliveryState: "unknown", failureCode: "no_response" });
    expect(sends()).toHaveLength(1);
    const s2 = await setup(ws);
    reset({ sends: [new SendError("rejected", 400, 190, null)] });
    expect((await (await call(owner, SEND(ws, s2.conv), { clientMsgId: uuid(), body: "nope" })).json()).message).toMatchObject({ deliveryState: "failed", failureCode: "token_invalid" });
  });

  it("viewers cannot send; other workspaces cannot reach the conversation", async () => {
    const s = await setup(ws);
    const sB = await setup(wsOther);
    reset();
    expect((await call(viewer, SEND(ws, s.conv), { clientMsgId: uuid(), body: "hi" })).status).toBe(403);
    expect((await call(other, SEND(ws, s.conv), { clientMsgId: uuid(), body: "hi" })).status).toBe(404);
    expect((await call(owner, SEND(ws, sB.conv), { clientMsgId: uuid(), body: "hi" })).status).toBe(404);
    expect(sends()).toHaveLength(0);
    expect(await outRows(sB.conv)).toHaveLength(0);
  });

  it("a delivered status for the sent wamid moves the conversation's delivered watermark", async () => {
    const s = await setup(ws);
    reset({ sends: ["wamid.out.status"] });
    await call(owner, SEND(ws, s.conv), { clientMsgId: uuid(), body: "track me" });
    const body = buildWhatsAppBody(digits(), [buildWhatsAppChange({ phoneNumberId: s.phone, statuses: [{ id: "wamid.out.status", status: "delivered", timestamp: "1800000010", recipient_id: s.waId }] })]);
    const raw = Buffer.from(JSON.stringify(body));
    const res = await hook.request("/webhooks/meta/whatsapp", { method: "POST", body: new Uint8Array(raw), headers: { "content-type": "application/json", "x-hub-signature-256": signMetaBody(raw, mockSecret) } });
    expect(res.status).toBe(200);
    for (let i = 0; i < 20; i++) {
      for (const e of await q("SELECT id FROM webhook_events WHERE account_ref=$1 AND status IN ('received','failed')", [s.phone])) await processWebhookEvent(workerDb, e.id);
      const [c] = await q("SELECT contact_delivered_at FROM conversations WHERE id=$1", [s.conv]);
      if (c.contact_delivered_at) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    const [c] = await q("SELECT contact_delivered_at FROM conversations WHERE id=$1", [s.conv]);
    expect(new Date(c.contact_delivered_at).getTime()).toBe(1_800_000_010 * 1000);
  });
});
