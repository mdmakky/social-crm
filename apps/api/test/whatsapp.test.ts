import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import { Hono } from "hono";
import { createDb, type Db } from "@crm/db";
import { buildWhatsAppBody, buildWhatsAppChange, createMockGraph, createSecretBox, mockSecret, signedFixture, signMetaBody, waText } from "@crm/integrations";
import type { MetaConnectDeps } from "../src/inbox/meta-connect.ts";
import { processPending, processWebhookEvent } from "../src/inbox/process.ts";
import { metaWebhookRoutes } from "../src/inbox/webhook.ts";
import { bootstrap, type Harness, type TestUser } from "./harness.ts";

// WhatsApp slice 1 (webhook foundation). Bodies are built from Meta's documented field lists (see buildWhatsAppChange): they prove our handling, not that Meta sends exactly this.
const DB = process.env.CRM_DB_NAME ?? "crm";
let h: Harness, workerDb: Db, ingestDb: Db, hook: Hono;
let owner: TestUser, other: TestUser;
let ws: string, wsOther: string;
const accounts: string[] = [];
const digits = () => `8${Math.floor(Math.random() * 1e13).toString().padStart(13, "0")}`;
const q = async (text: string, params: unknown[] = []) => (await h.admin.query(text, params)).rows;
const RUN = Math.random().toString(36).slice(2, 8);
const wamid = () => `wamid.${RUN}.${digits()}`;

async function waAccount(w: string, o: { status?: string } = {}) {
  const phone = digits();
  const [a] = await q("INSERT INTO integration_accounts (workspace_id, platform, external_account_id, status, display_name) VALUES ($1,'whatsapp',$2,$3,'+1 555 0100') RETURNING id", [w, phone, o.status ?? "connected"]);
  accounts.push(a.id);
  return { id: a.id as string, phone };
}
const post = (payload: unknown, o: { sig?: boolean; path?: string; raw?: Buffer } = {}) => {
  const raw = o.raw ?? Buffer.from(JSON.stringify(payload));
  return hook.request(`/webhooks/meta/${o.path ?? "whatsapp"}`, { method: "POST", body: new Uint8Array(raw), headers: { "content-type": "application/json", "x-hub-signature-256": o.sig === false ? "sha256=" + "0".repeat(64) : signMetaBody(raw, mockSecret) } });
};
// processWebhookEvent claims with SKIP LOCKED, so an event another worker (the app's own, or a parallel test file) holds right now is skipped by us. Loop until none is left.
const drain = async (...refs: string[]) => {
  for (let i = 0; i < 50; i++) {
    const todo = await q("SELECT id FROM webhook_events WHERE account_ref = ANY($1::text[]) AND status IN ('received','failed') ORDER BY received_at", [refs]);
    if (!todo.length) return;
    for (const e of todo) await processWebhookEvent(workerDb, e.id);
    if (i > 0) await new Promise((r) => setTimeout(r, 50));
  }
};
const msg = (phone: string, from: string, text: string, id = wamid()) => buildWhatsAppBody(digits(), [buildWhatsAppChange({ phoneNumberId: phone, messages: [waText(from, id, text)], contacts: [{ profile: { name: "Customer Name" }, wa_id: from }] })]);
const convOf = async (acct: string) => (await q("SELECT * FROM conversations WHERE integration_account_id = $1", [acct]))[0];

beforeAll(async () => {
  workerDb = createDb(`postgres://crm_worker:worker_dev@127.0.0.1:5436/${DB}`);
  ingestDb = createDb(`postgres://crm_ingest:ingest_dev@127.0.0.1:5436/${DB}`);
  hook = new Hono().route("/webhooks/meta", metaWebhookRoutes({ appSecrets: [mockSecret], verifyToken: "v", ingestDb }));
  const deps: MetaConnectDeps = {
    graph: createMockGraph({ pages: [] }), box: createSecretBox({ k1: Buffer.alloc(32, 5).toString("base64") }, "k1"), workerDb, appId: "123456", configId: "654321", graphVersion: "v25.0", redirectUri: "http://localhost:3000/v1/integrations/meta/callback", webOrigin: "http://localhost:3000",
    stateKey: createHmac("sha256", "k").update("s").digest(), userHashKey: createHmac("sha256", "k").update("u").digest(), mock: true, secureCookies: false,
  };
  h = await bootstrap(undefined, deps);
  [owner, other] = (await Promise.all(["wowner", "wother"].map((l) => h.newUser(l)))) as [TestUser, TestUser];
  ws = await h.workspace(owner, "WA A");
  wsOther = await h.workspace(other, "WA B");
});
afterAll(async () => {
  if (accounts.length) await q("UPDATE integration_accounts SET last_token_check_at = now(), status = 'disabled' WHERE id = ANY($1::uuid[])", [accounts]);
  await workerDb.$client.end();
  await ingestDb.$client.end();
  await h.close();
});

describe("webhook ingress", () => {
  it("answers Meta's verification handshake on the WhatsApp path only with the right token", async () => {
    const ok = await hook.request("/webhooks/meta/whatsapp?hub.mode=subscribe&hub.verify_token=v&hub.challenge=12345");
    expect([ok.status, await ok.text()]).toEqual([200, "12345"]);
    expect((await hook.request("/webhooks/meta/whatsapp?hub.mode=subscribe&hub.verify_token=nope&hub.challenge=12345")).status).toBe(403);
    expect((await hook.request("/webhooks/meta/telegram?hub.mode=subscribe&hub.verify_token=v&hub.challenge=1")).status).toBe(403);
  });

  it("rejects a wrong or missing signature, stores no body, and writes only a payload-free audit row", async () => {
    const a = await waAccount(ws);
    const body = msg(a.phone, digits(), "secret customer text");
    expect((await post(body, { sig: false })).status).toBe(403);
    const f = signedFixture(body, "some-other-secret");
    expect((await hook.request("/webhooks/meta/whatsapp", { method: "POST", body: new Uint8Array(f.raw), headers: { "x-hub-signature-256": f.signature } })).status).toBe(403);
    expect((await hook.request("/webhooks/meta/whatsapp", { method: "POST", body: new Uint8Array(f.raw) })).status).toBe(403);
    expect(await q("SELECT 1 FROM webhook_events WHERE account_ref = $1", [a.phone])).toEqual([]);
    const [rej] = await q("SELECT raw_body, body_sha256, status FROM webhook_events WHERE platform = 'whatsapp' AND status = 'rejected' ORDER BY received_at DESC LIMIT 1");
    expect(rej).toMatchObject({ raw_body: null, body_sha256: null, status: "rejected" });
  });

  it("acknowledges signed bodies that carry nothing for us (other fields, no phone number id, not JSON) and stores nothing", async () => {
    const before = Number((await q("SELECT count(*) AS n FROM webhook_events WHERE platform = 'whatsapp'"))[0].n);
    expect((await post(buildWhatsAppBody(digits(), [buildWhatsAppChange({ phoneNumberId: digits(), field: "account_update", messages: [waText("1555", wamid(), "x")] })]))).status).toBe(200);
    expect((await post({ object: "whatsapp_business_account", entry: [{ id: digits(), changes: [{ field: "messages", value: { messages: [] } }] }] })).status).toBe(200);
    expect((await post(null, { raw: Buffer.from("not json") })).status).toBe(200);
    expect(Number((await q("SELECT count(*) AS n FROM webhook_events WHERE platform = 'whatsapp'"))[0].n)).toBe(before);
  });

  it("stores one row per change, keyed by the phone number id and never by the WABA id", async () => {
    const waba = digits();
    const [p1, p2] = [digits(), digits()];
    const body = buildWhatsAppBody(waba, [
      buildWhatsAppChange({ phoneNumberId: p1, messages: [waText("1555", wamid(), "one")] }),
      buildWhatsAppChange({ phoneNumberId: p2, messages: [waText("1666", wamid(), "two")] }),
    ]);
    expect((await post(body)).status).toBe(200);
    const rows = await q("SELECT account_ref, platform, signature_valid, status, convert_from(raw_body,'utf8') AS body FROM webhook_events WHERE account_ref = ANY($1::text[]) ORDER BY account_ref", [[p1, p2, waba]]);
    expect(rows.map((r) => r.account_ref).sort()).toEqual([p1, p2].sort());
    expect(rows.every((r) => r.platform === "whatsapp" && r.signature_valid && r.status === "received")).toBe(true);
    // each row holds only its own change
    for (const r of rows) expect(JSON.parse(r.body).entry.flatMap((e: { changes: unknown[] }) => e.changes)).toHaveLength(1);
  });
});

describe("worker: inbound messages", () => {
  it("creates the contact, identity, conversation and message for a connected number, and sets the reply window", async () => {
    const a = await waAccount(ws);
    const from = digits();
    const id = wamid();
    expect((await post(msg(a.phone, from, "Hello from WhatsApp, my email is buyer@example.com", id))).status).toBe(200);
    await drain(a.phone);
    const c = await convOf(a.id);
    expect(c).toBeTruthy();
    expect(c.workspace_id).toBe(ws);
    expect(c.last_inbound_at).not.toBeNull();
    const [m] = await q("SELECT direction, sender_kind, delivery_state, body, external_id FROM messages WHERE conversation_id = $1", [c.id]);
    expect(m).toMatchObject({ direction: "in", sender_kind: "contact", delivery_state: "received", body: "Hello from WhatsApp, my email is buyer@example.com", external_id: id });
    const [ct] = await q("SELECT name, source FROM contacts WHERE id = $1", [c.contact_id]);
    expect(ct.source).toBe("whatsapp");
    expect(ct.name).toBe(`WhatsApp user ${from.slice(-4)}`); // no platform-provided text is used as a name in this slice
    const [ev] = await q("SELECT status, workspace_id, last_error FROM webhook_events WHERE account_ref = $1", [a.phone]);
    expect(ev).toMatchObject({ status: "processed", workspace_id: ws, last_error: null });
    // detected contact data keeps its WhatsApp provenance
    const methods = await q("SELECT kind, value, source, verified FROM contact_methods WHERE contact_id = $1", [c.contact_id]);
    expect(methods).toEqual([{ kind: "email", value: "buyer@example.com", source: "whatsapp", verified: false }]);
  });

  it("is idempotent: a re-delivered message (Meta retries for days) is stored once and does not move the conversation", async () => {
    const a = await waAccount(ws);
    const from = digits();
    const body = msg(a.phone, from, "once");
    await post(body);
    await drain(a.phone);
    const before = await convOf(a.id);
    await post(body); // identical body again
    await post(msg(a.phone, from, "once", (body.entry[0]!.changes[0]!.value.messages![0] as { id: string }).id)); // same message id, different envelope
    await drain(a.phone);
    expect(await q("SELECT 1 FROM messages WHERE conversation_id = $1", [before.id])).toHaveLength(1);
    const after = await convOf(a.id);
    expect(after.message_seq).toBe(before.message_seq);
    expect(after.last_message_at).toEqual(before.last_message_at);
    expect(after.version).toBe(before.version);
  });

  it("adds a second message to the same conversation and keeps a media reference without a link", async () => {
    const a = await waAccount(ws);
    const from = digits();
    await post(msg(a.phone, from, "first"));
    const media = buildWhatsAppBody(digits(), [buildWhatsAppChange({ phoneNumberId: a.phone, messages: [{ from, id: wamid(), timestamp: String(Math.floor(Date.now() / 1000)), type: "image", image: { id: "1003383421387256", mime_type: "image/jpeg", caption: "photo", url: "https://lookaside.example/private" } }] })]);
    await post(media);
    await drain(a.phone);
    const c = await convOf(a.id);
    const rows = await q("SELECT body, attachments FROM messages WHERE conversation_id = $1 ORDER BY seq", [c.id]);
    expect(rows.map((r) => r.body)).toEqual(["first", "photo"]);
    expect(rows[1].attachments).toEqual([{ type: "image", url: null, mediaId: "1003383421387256", mime: "image/jpeg" }]);
    expect(JSON.stringify(rows)).not.toContain("lookaside");
    expect(await q("SELECT 1 FROM conversations WHERE integration_account_id = $1", [a.id])).toHaveLength(1);
  });

  it("routes by phone number id, not by entry.id: another workspace's number can never receive the message", async () => {
    const a = await waAccount(ws);
    const b = await waAccount(wsOther);
    const from = digits();
    // entry.id (the WABA id) names workspace B's number; the change's phone_number_id names A's.
    expect((await post(buildWhatsAppBody(b.phone, [buildWhatsAppChange({ phoneNumberId: a.phone, messages: [waText(from, wamid(), "for A")] })]))).status).toBe(200);
    await drain(a.phone, b.phone);
    expect(await convOf(a.id)).toBeTruthy();
    expect(await convOf(b.id)).toBeUndefined();
    expect(await q("SELECT 1 FROM messages WHERE workspace_id = $1 AND body = 'for A'", [wsOther])).toEqual([]);
    expect(await q("SELECT 1 FROM webhook_events WHERE account_ref = $1", [b.phone])).toEqual([]);
  });

  it("splits one POST for two numbers of two workspaces and keeps each message in its own workspace", async () => {
    const a = await waAccount(ws);
    const b = await waAccount(wsOther);
    const same = digits(); // the same customer number writes to both businesses
    await post(buildWhatsAppBody(digits(), [
      buildWhatsAppChange({ phoneNumberId: a.phone, messages: [waText(same, wamid(), "to A")] }),
      buildWhatsAppChange({ phoneNumberId: b.phone, messages: [waText(same, wamid(), "to B")] }),
    ]));
    await drain(a.phone, b.phone);
    expect((await q("SELECT body FROM messages WHERE workspace_id = $1 AND integration_account_id = $2", [ws, a.id])).map((r) => r.body)).toEqual(["to A"]);
    expect((await q("SELECT body FROM messages WHERE workspace_id = $1 AND integration_account_id = $2", [wsOther, b.id])).map((r) => r.body)).toEqual(["to B"]);
    const ca = await convOf(a.id), cb = await convOf(b.id);
    expect(ca.contact_id).not.toBe(cb.contact_id);
    expect(await q("SELECT 1 FROM messages WHERE workspace_id = $1 AND body = 'to B'", [ws])).toEqual([]);
  });

  it("keeps events for an unknown or disabled number as orphans, and a replay works once the number is connected", async () => {
    const phone = digits();
    const from = digits();
    await post(msg(phone, from, "early"));
    await drain(phone);
    expect((await q("SELECT status, last_error, workspace_id FROM webhook_events WHERE account_ref = $1", [phone]))[0]).toMatchObject({ status: "orphan", last_error: "unknown_account", workspace_id: null });
    const [a] = await q("INSERT INTO integration_accounts (workspace_id, platform, external_account_id, status) VALUES ($1,'whatsapp',$2,'connected') RETURNING id", [ws, phone]);
    accounts.push(a.id);
    await workerDb.$client.query("UPDATE webhook_events SET status = 'received' WHERE account_ref = $1 AND status = 'orphan'", [phone]);
    await processPending(workerDb, 50);
    expect((await q("SELECT status FROM webhook_events WHERE account_ref = $1", [phone]))[0].status).toBe("processed");
    expect(await q("SELECT body FROM messages WHERE integration_account_id = $1", [a.id])).toEqual([{ body: "early" }]);

    const d = await waAccount(ws, { status: "disabled" });
    await post(msg(d.phone, from, "to a disabled number"));
    await drain(d.phone);
    expect((await q("SELECT status, last_error FROM webhook_events WHERE account_ref = $1", [d.phone]))[0]).toMatchObject({ status: "orphan", last_error: "account_disabled" });
    expect(await q("SELECT 1 FROM messages WHERE integration_account_id = $1", [d.id])).toEqual([]);
  });

  it("does not create a conversation for a sender that has only a business-scoped user id, and keeps the raw event", async () => {
    const a = await waAccount(ws);
    await post(buildWhatsAppBody(digits(), [buildWhatsAppChange({ phoneNumberId: a.phone, messages: [{ from_user_id: "US.13491208655302741918", id: wamid(), timestamp: String(Math.floor(Date.now() / 1000)), type: "text", text: { body: "hi" } }] })]));
    await drain(a.phone);
    expect(await convOf(a.id)).toBeUndefined();
    expect((await q("SELECT status FROM webhook_events WHERE account_ref = $1", [a.phone]))[0].status).toBe("processed"); // kept (30 days) for the later BSUID work, not lost and not failing
  });
});

describe("worker: delivery statuses", () => {
  it("moves the delivered and read watermarks for our own message, forward only, and ignores a message id it does not know", async () => {
    const a = await waAccount(ws);
    const b = await waAccount(wsOther);
    const from = digits();
    await post(msg(a.phone, from, "hi"));
    await drain(a.phone);
    const c = await convOf(a.id);
    const out = wamid();
    // a message of ours, as slice 3 will store it (here inserted directly: this slice has no sender)
    await q("INSERT INTO messages (workspace_id, conversation_id, integration_account_id, direction, external_id, sender_kind, body, delivery_state) VALUES ($1,$2,$3,'out',$4,'external','our reply','sent')", [ws, c.id, a.id, out]);
    const t = (s: number) => String(1_800_000_000 + s);
    const status = (st: string, ts: string, id = out, to = from, phone = a.phone) => post(buildWhatsAppBody(digits(), [buildWhatsAppChange({ phoneNumberId: phone, statuses: [{ id, status: st, timestamp: ts, recipient_id: to }] })]));
    await status("delivered", t(10));
    await status("read", t(20));
    await drain(a.phone);
    let cur = await convOf(a.id);
    expect(new Date(cur.contact_delivered_at).getTime()).toBe((1_800_000_010) * 1000);
    expect(new Date(cur.contact_read_at).getTime()).toBe((1_800_000_020) * 1000);
    await status("delivered", t(5)); // older: must not move backwards
    await status("sent", t(30)); // not used
    await status("delivered", t(40), wamid()); // unknown message id: no effect
    await drain(a.phone);
    cur = await convOf(a.id);
    expect(new Date(cur.contact_delivered_at).getTime()).toBe((1_800_000_010) * 1000);
    expect(new Date(cur.contact_read_at).getTime()).toBe((1_800_000_020) * 1000);
    // the same message id reported by another business's number never touches this conversation
    await status("read", t(90), out, from, b.phone);
    await drain(b.phone);
    expect(new Date((await convOf(a.id)).contact_read_at).getTime()).toBe((1_800_000_020) * 1000);
    expect(await q("SELECT 1 FROM conversations WHERE integration_account_id = $1", [b.id])).toEqual([]);
    expect((await q("SELECT status FROM webhook_events WHERE account_ref = $1", [b.phone]))[0].status).toBe("processed");
  });
});

describe("the other channels and the API surface", () => {
  it("shows a WhatsApp conversation in the inbox API, refuses replies with a clear error, and Messenger and Instagram bodies still take their own path", async () => {
    const a = await waAccount(ws);
    const from = digits();
    await post(msg(a.phone, from, "can you reply?"));
    await drain(a.phone);
    const c = await convOf(a.id);
    const list = await h.app.request(`/v1/workspaces/${ws}/conversations`, { headers: { cookie: owner.cookie } });
    expect(list.status).toBe(200);
    const items = (await list.json()).items as { id: string; platform: string }[];
    expect(items.find((i) => i.id === c.id)?.platform).toBe("whatsapp");
    const send = await h.app.request(`/v1/workspaces/${ws}/conversations/${c.id}/messages`, { method: "POST", headers: { cookie: owner.cookie, origin: "http://localhost:3000", "content-type": "application/json" }, body: JSON.stringify({ body: "hello", clientMsgId: crypto.randomUUID() }) });
    expect(send.status).toBe(422);
    expect((await send.json()).error?.code ?? "unsupported_channel").toBe("unsupported_channel");
    expect(await q("SELECT 1 FROM messages WHERE conversation_id = $1 AND direction = 'out'", [c.id])).toEqual([]);

    // a Messenger-shaped body on the WhatsApp path is still handled as Messenger (the channel comes from the signed `object`, as before)
    const page = digits();
    const fx = signedFixture({ object: "page", entry: [{ id: page, time: 1, messaging: [{ sender: { id: "5551" }, recipient: { id: page }, timestamp: 1, message: { mid: "m1", text: "x" } }] }] }, mockSecret);
    expect((await hook.request("/webhooks/meta/whatsapp", { method: "POST", body: new Uint8Array(fx.raw), headers: { "x-hub-signature-256": fx.signature } })).status).toBe(200);
    expect((await q("SELECT platform FROM webhook_events WHERE account_ref = $1", [page]))[0].platform).toBe("messenger");
  });
});
