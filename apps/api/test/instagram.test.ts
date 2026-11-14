import { createHmac } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { createDb, type Db } from "@crm/db";
import { buildMessagePayload, createMockGraph, createSecretBox, mockSecret, SendError, signedFixture, type GraphPage, type UserProfile } from "@crm/integrations";
import type { MetaConnectDeps } from "../src/inbox/meta-connect.ts";
import { processWebhookEvent } from "../src/inbox/process.ts";
import { createProfileEnricher } from "../src/inbox/profile.ts";
import { failureCodeOf, IG_MAX_BYTES } from "../src/inbox/send.ts";
import { metaWebhookRoutes } from "../src/inbox/webhook.ts";
import { bootstrap, type Harness, type TestUser } from "./harness.ts";

const DB = process.env.CRM_DB_NAME ?? "crm";
const box = createSecretBox({ k1: Buffer.alloc(32, 5).toString("base64") }, "k1");
const TOKEN = "IG-PAGE-TOKEN-must-never-leak";
let h: Harness, workerDb: Db, ingestDb: Db, hook: Hono, graph: ReturnType<typeof createMockGraph>;
let owner: TestUser, agent: TestUser, viewer: TestUser, other: TestUser;
let ws: string, wsOther: string;
const accounts: string[] = [];
const digits = () => `7${Math.floor(Math.random() * 1e13).toString().padStart(13, "0")}`;
const q = async (text: string, params: unknown[] = []) => (await h.admin.query(text, params)).rows;
const uuid = () => crypto.randomUUID();
const RUN = Math.random().toString(36).slice(2, 8);
const call = (u: TestUser, method: string, path: string, body?: unknown, cookies: Record<string, string> = {}) =>
  h.app.request(path, { method, headers: { cookie: [u.cookie, ...Object.entries(cookies).map(([k, v]) => `${k}=${v}`)].join("; "), origin: "http://localhost:3000", ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
const SEND = (w: string, c: string) => `/v1/workspaces/${w}/conversations/${c}/messages`;
const sends = () => graph.calls.filter((c) => c.startsWith("sendig:") || c.startsWith("send:"));
const reset = (over: Parameters<typeof createMockGraph>[0] = {}) => { graph.calls.length = 0; Object.assign(graph.state, { sends: [], onSend: undefined, ...over }); };

/** Connected Instagram account with an encrypted token. `ref` is the Instagram id (the webhook entry id). */
async function igAccount(w: string, o: { token?: boolean; status?: string } = {}) {
  const ref = digits();
  const [a] = await q("INSERT INTO integration_accounts (workspace_id, platform, external_account_id, status, display_name) VALUES ($1,'instagram',$2,$3,'@shop') RETURNING id", [w, ref, o.status ?? "connected"]);
  accounts.push(a.id);
  if (o.token !== false) {
    const s = box.seal(TOKEN, `${w}:${a.id}`);
    await q("INSERT INTO integration_secrets (workspace_id, integration_account_id, version, ciphertext, nonce, key_id) VALUES ($1,$2,1,$3,$4,$5)", [w, a.id, s.ciphertext, s.nonce, s.keyId]);
  }
  return { id: a.id as string, ref };
}
async function drain(ref: string) {
  for (const e of await q("SELECT id FROM webhook_events WHERE account_ref=$1 AND status IN ('received','failed') ORDER BY received_at", [ref])) await processWebhookEvent(workerDb, e.id);
}
const deliver = async (payload: unknown, path: "instagram" | "messenger" = "instagram", sig = true) => {
  const f = signedFixture(payload, mockSecret);
  return hook.request(`/webhooks/meta/${path}`, { method: "POST", body: new Uint8Array(f.raw), headers: { "content-type": "application/json", "x-hub-signature-256": sig ? f.signature : "sha256=" + "0".repeat(64) } });
};
const incoming = async (ref: string, igsid: string, mid: string, text = "hello", at = Date.now()) => {
  expect((await deliver(buildMessagePayload({ object: "instagram", accountId: ref, userId: igsid, mid, text, timestampMs: at }))).status).toBe(200);
  await drain(ref);
};
/** A conversation created by a real inbound Instagram DM. */
async function igConv(w: string, text = "hi there") {
  const a = await igAccount(w);
  const igsid = digits();
  await incoming(a.ref, igsid, `ig.${RUN}.${digits()}`, text);
  const [c] = await q("SELECT id FROM conversations WHERE integration_account_id=$1", [a.id]);
  return { ...a, igsid, conv: c.id as string };
}
const outRows = (conv: string) => q("SELECT * FROM messages WHERE conversation_id=$1 AND direction='out' ORDER BY seq", [conv]);

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
  [owner, agent, viewer, other] = (await Promise.all(["iowner", "iagent", "iviewer", "iother"].map((l) => h.newUser(l)))) as TestUser[] as [TestUser, TestUser, TestUser, TestUser];
  ws = await h.workspace(owner, "IG A", { agent, viewer });
  wsOther = await h.workspace(other, "IG B");
});
afterAll(async () => {
  if (accounts.length) await q("UPDATE integration_accounts SET last_token_check_at = now(), status = 'disabled' WHERE id = ANY($1::uuid[])", [accounts]);
  await workerDb.$client.end();
  await ingestDb.$client.end();
  await h.close();
});

describe("account discovery and connection", () => {
  const page = (over: Partial<GraphPage> = {}): GraphPage => ({ id: digits(), name: "Shop Page", accessToken: `page-token-${digits()}`, tasks: ["MANAGE", "MESSAGING"], instagramAccountId: digits(), ...over });
  const MP = (w: string) => `/v1/workspaces/${w}/integrations/meta`;
  const cookiesOf = (res: Response) => Object.fromEntries(res.headers.getSetCookie().map((c) => c.split(";")[0]!.split("=") as [string, string]));
  async function login(u: TestUser, w: string, pages: GraphPage[]) {
    graph.state.pages = pages;
    const start = await call(u, "POST", `${MP(w)}/connect/start`);
    expect(start.status).toBe(200);
    const nonce = cookiesOf(start).crm_meta_nonce!;
    const cb = new URL((await start.json()).authUrl);
    const res = await call(u, "GET", `${cb.pathname}${cb.search}`, undefined, { crm_meta_nonce: nonce });
    expect(res.headers.get("location")).toContain("meta=select");
    return cookiesOf(res).crm_meta_pending!;
  }

  it("lists the linked Instagram account with username and picture, connects it by @username, stores the token encrypted, and never returns it", async () => {
    const p = page();
    graph.state.instagram = new Map([[p.instagramAccountId!, { username: "shop.bd", name: "Shop BD", pictureUrl: "https://scontent.cdninstagram.com/v/p.jpg" }]]);
    const pending = await login(owner, ws, [p]);
    const list = await (await call(owner, "GET", `${MP(ws)}/pending`, undefined, { crm_meta_pending: pending })).json();
    expect(list.pages[0]).toMatchObject({ instagramAccountId: p.instagramAccountId, instagram: { username: "shop.bd", pictureUrl: "https://scontent.cdninstagram.com/v/p.jpg" }, instagramConnected: false });
    const res = await call(owner, "POST", `${MP(ws)}/connect`, { pageId: p.id, connectInstagram: true }, { crm_meta_pending: pending });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain(p.accessToken);
    const ig = JSON.parse(text).accounts.find((a: { account: { platform: string } }) => a.account.platform === "instagram");
    expect(ig).toMatchObject({ account: { displayName: "@shop.bd", status: "connected", externalAccountId: p.instagramAccountId }, subscription: "dashboard_required" });
    accounts.push(ig.account.id);
    const [sec] = await q("SELECT ciphertext FROM integration_secrets WHERE integration_account_id=$1", [ig.account.id]);
    expect(Buffer.from(sec.ciphertext).includes(Buffer.from(p.accessToken))).toBe(false); // sealed, not plain
    expect(box.open({ ciphertext: sec.ciphertext, nonce: (await q("SELECT nonce, key_id FROM integration_secrets WHERE integration_account_id=$1", [ig.account.id]))[0].nonce, keyId: "k1" }, `${ws}:${ig.account.id}`)).toBe(p.accessToken);
    // reconnect marks it connected in the picker next time
    const again = await login(owner, ws, [p]);
    expect((await (await call(owner, "GET", `${MP(ws)}/pending`, undefined, { crm_meta_pending: again })).json()).pages[0].instagramConnected).toBe(true);
  });

  it("falls back to the Page name when Graph gives no Instagram details, and a Page without Instagram offers none", async () => {
    const p = page();
    graph.state.instagram = new Map();
    const pending = await login(owner, ws, [p, page({ instagramAccountId: null })]);
    const list = await (await call(owner, "GET", `${MP(ws)}/pending`, undefined, { crm_meta_pending: pending })).json();
    expect(list.pages[0].instagram).toBeNull();
    expect(list.pages[1].instagramAccountId).toBeNull();
    const res = await call(owner, "POST", `${MP(ws)}/connect`, { pageId: p.id, connectInstagram: true }, { crm_meta_pending: pending });
    const ig = (await res.json()).accounts.find((a: { account: { platform: string } }) => a.account.platform === "instagram");
    expect(ig.account.displayName).toBe("Shop Page (Instagram)");
    accounts.push(ig.account.id);
  });

  it("an Instagram account can belong to one workspace only, and viewers/agents cannot connect or disconnect", async () => {
    const p = page();
    const pending = await login(owner, ws, [p]);
    const ok = await call(owner, "POST", `${MP(ws)}/connect`, { pageId: p.id, connectInstagram: true }, { crm_meta_pending: pending });
    expect(ok.status).toBe(200);
    for (const a of (await ok.json()).accounts) accounts.push(a.account.id);
    // the same Page (and so the same Instagram account) offered to another workspace's owner is refused
    const pendingB = await login(other, wsOther, [p]);
    const refused = await call(other, "POST", `${MP(wsOther)}/connect`, { pageId: p.id, connectInstagram: true }, { crm_meta_pending: pendingB });
    expect(refused.status).toBe(409);
    expect((await refused.json()).error.code).toBe("account_unavailable");
    expect((await q("SELECT count(*)::int AS n FROM integration_accounts WHERE platform='instagram' AND external_account_id=$1", [p.instagramAccountId]))[0].n).toBe(1);
    const igId = (await q("SELECT id FROM integration_accounts WHERE platform='instagram' AND external_account_id=$1", [p.instagramAccountId]))[0].id;
    for (const u of [agent, viewer]) expect((await call(u, "POST", `${MP(ws)}/accounts/${igId}/disconnect`)).status).toBe(403);
    expect((await call(other, "POST", `${MP(ws)}/accounts/${igId}/disconnect`)).status).toBe(404);
    expect((await call(owner, "POST", `${MP(ws)}/accounts/${igId}/disconnect`)).status).toBe(200);
    expect((await q("SELECT status, (SELECT count(*)::int FROM integration_secrets WHERE integration_account_id=$1) AS secrets FROM integration_accounts WHERE id=$1", [igId]))[0]).toEqual({ status: "disabled", secrets: 0 });
  });
});

describe("incoming Instagram messages", () => {
  it("creates identity, contact, conversation and message for platform instagram, from the Instagram callback", async () => {
    const a = await igAccount(ws);
    const igsid = digits();
    await incoming(a.ref, igsid, `ig.${RUN}.1`, "Hello from Instagram");
    const [c] = await q("SELECT c.id, c.last_inbound_at, ia.platform, ct.name, ct.source FROM conversations c JOIN integration_accounts ia ON ia.id=c.integration_account_id JOIN contacts ct ON ct.id=c.contact_id WHERE c.integration_account_id=$1", [a.id]);
    expect(c).toMatchObject({ platform: "instagram", source: "instagram" });
    expect(c.name).toMatch(/^Instagram user \d{1,4}$/);
    expect(c.last_inbound_at).not.toBeNull();
    expect(await q("SELECT direction, body, delivery_state, sender_kind FROM messages WHERE conversation_id=$1", [c.id])).toEqual([{ direction: "in", body: "Hello from Instagram", delivery_state: "received", sender_kind: "contact" }]);
    const detail = await (await call(owner, "GET", `/v1/workspaces/${ws}/conversations/${c.id}`)).json();
    expect(detail).toMatchObject({ platform: "instagram", replyWindow: "open" });
  });

  it("a duplicate webhook delivery changes nothing", async () => {
    const a = await igAccount(ws);
    const igsid = digits();
    await incoming(a.ref, igsid, `ig.${RUN}.dup`, "once");
    await incoming(a.ref, igsid, `ig.${RUN}.dup`, "once");
    expect((await q("SELECT count(*)::int AS n FROM messages m JOIN conversations c ON c.id=m.conversation_id WHERE c.integration_account_id=$1", [a.id]))[0].n).toBe(1);
  });

  it("detects phone and email in an Instagram message like in Messenger", async () => {
    const a = await igAccount(ws);
    await incoming(a.ref, digits(), `ig.${RUN}.contact`, "call 01712345678 or mail buyer@example.com");
    const methods = await q("SELECT kind, source FROM contact_methods cm JOIN conversations c ON c.contact_id=cm.contact_id WHERE c.integration_account_id=$1 ORDER BY kind", [a.id]);
    expect(methods).toEqual([{ kind: "email", source: "instagram" }, { kind: "phone", source: "instagram" }]);
  });

  it("rejects a bad signature; the channel comes from the signed object, whichever URL Meta calls", async () => {
    const a = await igAccount(ws);
    const payload = buildMessagePayload({ object: "instagram", accountId: a.ref, userId: digits(), mid: `ig.${RUN}.sig`, text: "x", timestampMs: Date.now() });
    expect((await deliver(payload, "instagram", false)).status).toBe(403);
    expect((await q("SELECT count(*)::int AS n FROM webhook_events WHERE account_ref=$1", [a.ref]))[0].n).toBe(0);
    expect((await deliver(payload, "messenger")).status).toBe(200); // instagram object on the messenger URL
    expect((await q("SELECT platform FROM webhook_events WHERE account_ref=$1", [a.ref])).map((r) => r.platform)).toEqual(["instagram"]);
    await drain(a.ref);
    expect((await q("SELECT count(*)::int AS n FROM messages m JOIN conversations c ON c.id=m.conversation_id WHERE c.integration_account_id=$1", [a.id]))[0].n).toBe(1);
  });

  it("stores unsupported media as a placeholder, uses read.mid as a read watermark, and ignores reactions and unknown events safely", async () => {
    const a = await igAccount(ws);
    const igsid = digits();
    const t = Date.now();
    const body = (messaging: unknown[]) => ({ object: "instagram", entry: [{ id: a.ref, time: t, messaging }] });
    const pair = { sender: { id: igsid }, recipient: { id: a.ref } };
    expect((await deliver(body([{ ...pair, timestamp: t, message: { mid: `ig.${RUN}.share`, is_unsupported: true } }]))).status).toBe(200);
    await drain(a.ref);
    const [m] = await q("SELECT m.body, m.attachments FROM messages m JOIN conversations c ON c.id=m.conversation_id WHERE c.integration_account_id=$1", [a.id]);
    expect(m.body).toBeNull();
    expect(m.attachments).toEqual([{ type: "unsupported", url: null }]);
    const events = [
      { ...pair, timestamp: t + 10, read: { mid: `ig.${RUN}.share` } }, // messaging_seen
      { ...pair, timestamp: t + 20, reaction: { mid: "x", action: "react", reaction: "love" } },
      { ...pair, timestamp: t + 30, postback: { mid: "y", payload: "z" } },
      { garbage: true },
    ];
    expect((await deliver(body(events))).status).toBe(200);
    await drain(a.ref);
    expect((await q("SELECT count(*)::int AS n FROM messages m JOIN conversations c ON c.id=m.conversation_id WHERE c.integration_account_id=$1", [a.id]))[0].n).toBe(1);
    expect((await q("SELECT status FROM webhook_events WHERE account_ref=$1 ORDER BY received_at", [a.ref])).map((r) => r.status)).toEqual(["processed", "processed"]);
  });

  it("Messenger events keep working on the Messenger path (regression)", async () => {
    const ref = digits();
    const [acc] = await q("INSERT INTO integration_accounts (workspace_id, platform, external_account_id, status) VALUES ($1,'messenger',$2,'connected') RETURNING id", [ws, ref]);
    accounts.push(acc.id);
    const f = buildMessagePayload({ accountId: ref, userId: digits(), mid: `fb.${RUN}.1`, text: "hi messenger", timestampMs: Date.now() });
    expect((await deliver(f, "messenger")).status).toBe(200);
    await drain(ref);
    expect((await q("SELECT ia.platform FROM conversations c JOIN integration_accounts ia ON ia.id=c.integration_account_id WHERE c.integration_account_id=$1", [acc.id]))).toEqual([{ platform: "messenger" }]);
  });

  it("tenant isolation: an event for Instagram account A never lands in workspace B", async () => {
    const a = await igAccount(ws);
    const b = await igAccount(wsOther);
    await incoming(a.ref, digits(), `ig.${RUN}.iso`, "for A only");
    expect((await q("SELECT count(*)::int AS n FROM conversations WHERE integration_account_id=$1", [b.id]))[0].n).toBe(0);
    const list = await (await call(other, "GET", `/v1/workspaces/${wsOther}/conversations`)).json();
    expect(JSON.stringify(list)).not.toContain("for A only");
  });
});

describe("Instagram profile enrichment", () => {
  it("fetches name/username for the Instagram person through the Instagram field set and replaces the placeholder", async () => {
    const a = await igAccount(ws);
    const igsid = digits();
    await incoming(a.ref, igsid, `ig.${RUN}.prof`, "hello");
    const g = createMockGraph({ profiles: new Map<string, UserProfile>([[igsid, { name: "Nusrat Jahan", picUrl: "https://scontent.cdninstagram.com/v/n.jpg" }]]) });
    await createProfileEnricher({ workerDb, graph: g, box, budget: 500 })();
    const [r] = await q("SELECT ct.name, pi.profile_status, pi.profile_pic_url FROM platform_identities pi JOIN contacts ct ON ct.id=pi.contact_id WHERE pi.integration_account_id=$1", [a.id]);
    expect(r).toEqual({ name: "Nusrat Jahan", profile_status: "ok", profile_pic_url: "https://scontent.cdninstagram.com/v/n.jpg" });
  });
});

describe("Instagram replies", () => {
  it("sends through the Instagram channel to the IGSID with the stored token, records the attempt first, and adopts the echo without a second bubble", async () => {
    const s = await igConv(ws);
    reset({ sends: ["mid.ig.1"] });
    let during: Record<string, unknown>[] = [];
    graph.state.onSend = async () => { during = await q("SELECT m.delivery_state, a.outcome FROM messages m JOIN outbound_attempts a ON a.message_id=m.id WHERE m.conversation_id=$1", [s.conv]); };
    const res = await call(agent, "POST", SEND(ws, s.conv), { clientMsgId: uuid(), body: "Thanks for writing!" });
    expect(res.status).toBe(201);
    const j = await res.json();
    expect(j.message).toMatchObject({ deliveryState: "sent", body: "Thanks for writing!" });
    expect(sends()).toEqual([`sendig:${s.ref}:${s.igsid}:Thanks for writing!`]);
    expect(during).toEqual([{ delivery_state: "sending", outcome: null }]);
    const [row] = await outRows(s.conv);
    expect(row).toMatchObject({ external_id: "mid.ig.1", delivery_state: "sent" });
    const [att] = await q("SELECT request_summary, outcome FROM outbound_attempts WHERE message_id=$1", [row.id]);
    expect(att).toMatchObject({ outcome: "accepted", request_summary: { kind: "text", channel: "instagram", messagingType: null } });
    expect(JSON.stringify([j, att])).not.toContain(TOKEN);
    // the echo Meta sends for our own message (is_echo, sender = the Instagram account)
    expect((await deliver(buildMessagePayload({ object: "instagram", accountId: s.ref, userId: s.igsid, mid: "mid.ig.1", text: "Thanks for writing!", timestampMs: Date.now(), echo: true }))).status).toBe(200);
    await drain(s.ref);
    expect(await outRows(s.conv)).toHaveLength(1);
  });

  it("an UNKNOWN Instagram send is adopted by a later echo (no duplicate) and never re-sent", async () => {
    const s = await igConv(ws);
    reset({ sends: [new SendError("ambiguous", null, null, null)] });
    const res = await call(owner, "POST", SEND(ws, s.conv), { clientMsgId: uuid(), body: "did this arrive" });
    expect((await res.json()).message.deliveryState).toBe("unknown");
    expect(sends()).toHaveLength(1);
    await deliver(buildMessagePayload({ object: "instagram", accountId: s.ref, userId: s.igsid, mid: `mid.ig.late.${RUN}`, text: "did this arrive", timestampMs: Date.now(), echo: true }));
    await drain(s.ref);
    const rows = await outRows(s.conv);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ delivery_state: "sent", sender_kind: "user" });
    expect(sends()).toHaveLength(1);
  });

  it("duplicate client ids send once, concurrently too", async () => {
    const s = await igConv(ws);
    reset();
    const id = uuid();
    const rs = await Promise.all([1, 2, 3].map(() => call(owner, "POST", SEND(ws, s.conv), { clientMsgId: id, body: "once" })));
    expect(rs.every((r) => r.status === 200 || r.status === 201)).toBe(true);
    expect(sends()).toHaveLength(1);
    expect(await outRows(s.conv)).toHaveLength(1);
  });

  it("enforces the 24 hour window server-side, a connected account, and the role", async () => {
    const s = await igConv(ws);
    reset();
    await q("BEGIN"); // the guard trigger forbids moving the window backwards; skipped for this test transaction only
    await q("SET LOCAL session_replication_role = replica");
    await q("UPDATE conversations SET last_inbound_at = now() - interval '25 hours' WHERE id=$1", [s.conv]);
    await q("COMMIT");
    const closed = await call(owner, "POST", SEND(ws, s.conv), { clientMsgId: uuid(), body: "late" });
    expect([closed.status, (await closed.json()).error.code]).toEqual([409, "window_closed"]);
    await q("UPDATE conversations SET last_inbound_at = now() WHERE id=$1", [s.conv]);
    expect((await call(viewer, "POST", SEND(ws, s.conv), { clientMsgId: uuid(), body: "x" })).status).toBe(403);
    expect((await call(other, "POST", SEND(wsOther, s.conv), { clientMsgId: uuid(), body: "x" })).status).toBe(404);
    await q("UPDATE integration_accounts SET status='reauth_required' WHERE id=$1", [s.id]);
    const re = await call(owner, "POST", SEND(ws, s.conv), { clientMsgId: uuid(), body: "x" });
    expect([re.status, (await re.json()).error.code]).toEqual([409, "account_not_connected"]);
    expect(sends()).toHaveLength(0);
    expect(await outRows(s.conv)).toHaveLength(0);
  });

  it("limits Instagram text to 1,000 UTF-8 bytes (Bengali counts 3 bytes per letter) and leaves Messenger's rule alone", async () => {
    const s = await igConv(ws);
    reset();
    const bn = "ক".repeat(Math.floor(IG_MAX_BYTES / 3) + 1); // 334 letters = 1002 bytes
    const tooLong = await call(owner, "POST", SEND(ws, s.conv), { clientMsgId: uuid(), body: bn });
    expect([tooLong.status, (await tooLong.json()).error.code]).toEqual([422, "too_long"]);
    expect(await outRows(s.conv)).toHaveLength(0);
    expect((await call(owner, "POST", SEND(ws, s.conv), { clientMsgId: uuid(), body: "ক".repeat(333) })).status).toBe(201);
    expect((await call(owner, "POST", SEND(ws, s.conv), { clientMsgId: uuid(), body: "a".repeat(1000) })).status).toBe(201);
    expect((await call(owner, "POST", SEND(ws, s.conv), { clientMsgId: uuid(), body: "a".repeat(1001) })).status).toBe(422);
  });

  it("a Meta refusal is a definite failure with an Instagram-aware code; a timeout is UNKNOWN", async () => {
    const s = await igConv(ws);
    reset({ sends: [new SendError("rejected", 400, 10, 2534022), new SendError("ambiguous", 504, null, null)] });
    const a = (await (await call(owner, "POST", SEND(ws, s.conv), { clientMsgId: uuid(), body: "one" })).json()).message;
    expect(a).toMatchObject({ deliveryState: "failed", failureCode: "window_closed" });
    const b = (await (await call(owner, "POST", SEND(ws, s.conv), { clientMsgId: uuid(), body: "two" })).json()).message;
    expect(b.deliveryState).toBe("unknown");
    expect(sends()).toHaveLength(2);
  });

  it("maps the documented Instagram error subcodes", () => {
    const e = (code: number, sub: number | null) => new SendError("rejected", 400, code, sub);
    expect(failureCodeOf(e(10, 2534022))).toBe("window_closed");
    expect(failureCodeOf(e(10, 2018278))).toBe("window_closed");
    expect(failureCodeOf(e(100, 2534014))).toBe("recipient_unavailable");
    expect(failureCodeOf(e(551, 1545041))).toBe("recipient_unavailable");
    expect(failureCodeOf(e(200, 2534041))).toBe("channel_access");
    expect(failureCodeOf(e(100, 2534013))).toBe("channel_access");
    expect(failureCodeOf(e(100, 2534037))).toBe("thread_owned_elsewhere");
    expect(failureCodeOf(e(613, 2534040))).toBe("rate_limited");
    expect(failureCodeOf(e(190, null))).toBe("token_invalid");
  });

  it("Messenger sending is unchanged (regression)", async () => {
    const ref = digits();
    const [acc] = await q("INSERT INTO integration_accounts (workspace_id, platform, external_account_id, status) VALUES ($1,'messenger',$2,'connected') RETURNING id", [ws, ref]);
    accounts.push(acc.id);
    const s = box.seal(TOKEN, `${ws}:${acc.id}`);
    await q("INSERT INTO integration_secrets (workspace_id, integration_account_id, version, ciphertext, nonce, key_id) VALUES ($1,$2,1,$3,$4,$5)", [ws, acc.id, s.ciphertext, s.nonce, s.keyId]);
    const psid = digits();
    expect((await deliver(buildMessagePayload({ accountId: ref, userId: psid, mid: `fb.${RUN}.r`, text: "hi", timestampMs: Date.now() }), "messenger")).status).toBe(200);
    await drain(ref);
    const [c] = await q("SELECT id FROM conversations WHERE integration_account_id=$1", [acc.id]);
    reset({ sends: ["mid.fb.1"] });
    expect((await call(owner, "POST", SEND(ws, c.id), { clientMsgId: uuid(), body: "hello" })).status).toBe(201);
    expect(sends()).toEqual([`send:${ref}:${psid}:hello`]);
  });
});
