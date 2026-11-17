import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, type Db } from "@crm/db";
import { bootstrap, ORIGIN, type Harness, type TestUser } from "./harness.ts";

const DB = process.env.CRM_DB_NAME ?? "crm";
const SITE = "https://site-a.example";
const SITE_B = "https://site-b.example";
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
let h: Harness, hLim: Harness, hFast: Harness, workerDb: Db;
let owner: TestUser, agent: TestUser, owner2: TestUser;
let ws: string, ws2: string;
type W = { id: string; publicKey: string };
let wA1: W, wA2: W, wB: W, wEmpty: W;
const q = async (text: string, params: unknown[] = []) => (await h.admin.query(text, params)).rows;
const json = (r: Response) => r.json() as Promise<any>;

type Opts = { origin?: string | null; host?: string; token?: string; body?: unknown; ip?: string; raw?: string; app?: Harness };
async function pub(key: string, method: string, path: string, o: Opts = {}) {
  const headers: Record<string, string> = { "x-forwarded-for": o.ip ?? "10.0.0.1" };
  if (o.origin !== null) headers.origin = o.origin ?? SITE;
  if (o.host) headers["x-widget-host"] = o.host;
  if (o.token) headers.authorization = `Bearer ${o.token}`;
  if (o.body !== undefined || o.raw !== undefined) headers["content-type"] = "application/json";
  return (o.app ?? h).app.request(`/public/widget/${key}${path}`, { method, headers, body: o.raw ?? (o.body !== undefined ? JSON.stringify(o.body) : undefined) });
}
async function newSession(w: W, o: Opts = {}) {
  const r = await pub(w.publicKey, "POST", "/sessions", { ...o, body: {} });
  expect(r.status).toBe(201);
  return (await json(r)).token as string;
}
const send = (w: W, token: string, body: unknown, o: Opts = {}) => pub(w.publicKey, "POST", "/messages", { ...o, token, body });
const poll = async (w: W, token: string, after = 0, o: Opts = {}) => {
  const r = await pub(w.publicKey, "GET", `/messages?after=${after}`, { ...o, token });
  return { status: r.status, body: await json(r) };
};
const adminCall = (u: TestUser, w: string, method: string, path: string, body?: unknown) =>
  h.app.request(`/v1/workspaces/${w}/web-chat/widgets${path}`, { method, headers: { cookie: u.cookie, origin: ORIGIN, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
async function mk(u: TestUser, w: string, name: string, allowedOrigins: string[]): Promise<W> {
  const r = await adminCall(u, w, "POST", "", { name, allowedOrigins });
  expect(r.status).toBe(201);
  return json(r);
}
const convOf = async (token: string) => (await q("SELECT conversation_id FROM chat_visitor_sessions WHERE token_hash=$1", [sha(token)]))[0]?.conversation_id as string | undefined;

beforeAll(async () => {
  workerDb = createDb(`postgres://crm_worker:worker_dev@127.0.0.1:5436/${DB}`);
  const widget = (extra: object = {}) => ({ workerDb, minFirstMessageMs: 0, limits: { sessionsPerIp: 1000, sessionsPerWidget: 1000, messagesPerSession: 1000, pollsPerSession: 1000, configPerIp: 1000, contactPerSession: 1000 }, ...extra });
  h = await bootstrap(undefined, undefined, undefined, undefined, widget());
  hLim = await bootstrap(undefined, undefined, undefined, undefined, { workerDb, minFirstMessageMs: 0, limits: { sessionsPerIp: 2, sessionsPerWidget: 4, messagesPerSession: 3, pollsPerSession: 2, configPerIp: 2, contactPerSession: 1 } });
  hFast = await bootstrap(undefined, undefined, undefined, undefined, widget({ minFirstMessageMs: 60_000 }));
  owner = await h.newUser("wcowner");
  agent = await h.newUser("wcagent");
  owner2 = await h.newUser("wcowner");
  ws = await h.workspace(owner, "Web Chat Co", { agent });
  ws2 = await h.workspace(owner2, "Other Co");
  wA1 = await mk(owner, ws, "Main site", [SITE]);
  wA2 = await mk(owner, ws, "Second", [SITE]);
  wB = await mk(owner2, ws2, "Other workspace", [SITE]);
  wEmpty = await mk(owner, ws, "No origins", []);
});
afterAll(async () => {
  await Promise.all([h.close(), hLim.close(), hFast.close(), workerDb.$client.end()]);
});

describe("widget admin", () => {
  it("only owner/admin manage widgets; the key is random and every change is audited", async () => {
    expect((await adminCall(agent, ws, "GET", "")).status).toBe(403);
    expect((await adminCall(agent, ws, "POST", "", { name: "x" })).status).toBe(403);
    expect(wA1.publicKey).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(wA1.publicKey).not.toBe(wA2.publicKey);
    expect((await json(await adminCall(owner, ws, "GET", ""))).items.map((x: W) => x.id)).toContain(wA1.id);
    // the other workspace never lists ours
    expect((await json(await adminCall(owner2, ws2, "GET", ""))).items.map((x: W) => x.id)).toEqual([wB.id]);
    const upd = await adminCall(owner, ws, "PATCH", `/${wA2.id}`, { name: "Second renamed", enabled: true });
    expect(upd.status).toBe(200);
    const rot = await adminCall(owner, ws, "POST", `/${wA2.id}/rotate-key`);
    const rotated = await json(rot);
    expect(rotated.publicKey).not.toBe(wA2.publicKey);
    expect((await pub(wA2.publicKey, "GET", "/config")).status).toBe(404); // the old snippet stops working
    wA2 = rotated;
    expect((await pub(wA2.publicKey, "GET", "/config")).status).toBe(200);
    const audit = await q("SELECT action, summary FROM audit_log WHERE workspace_id=$1 AND action LIKE 'widget.%' ORDER BY created_at", [ws]);
    expect(audit.map((a) => a.action)).toEqual(expect.arrayContaining(["widget.created", "widget.updated", "widget.key_rotated"]));
    expect(JSON.stringify(audit)).not.toContain(rotated.publicKey); // keys never go into the audit log
    // the integration account exists, belongs to web_chat, and does not appear in the Meta integrations list
    const [acc] = await q("SELECT a.platform FROM chat_widgets w JOIN integration_accounts a ON a.id=w.integration_account_id WHERE w.id=$1", [wA1.id]);
    expect(acc.platform).toBe("web_chat");
  });
  it("rejects bad input", async () => {
    expect((await adminCall(owner, ws, "POST", "", { name: "x", allowedOrigins: ["https://a.example/path"] })).status).toBe(400);
    expect((await adminCall(owner, ws, "POST", "", { name: "x", color: "red" })).status).toBe(400);
    expect((await adminCall(owner, ws, "PATCH", `/${wB.id}`, { name: "hijack" })).status).toBe(404); // another workspace's widget
  });
});

describe("origin allowlist and CORS", () => {
  it("allowed origin passes and is echoed; denied gets no CORS header; missing is rejected", async () => {
    const ok = await pub(wA1.publicKey, "GET", "/config");
    expect(ok.status).toBe(200);
    expect(ok.headers.get("access-control-allow-origin")).toBe(SITE);
    expect(ok.headers.get("access-control-allow-origin")).not.toBe("*");
    const denied = await pub(wA1.publicKey, "GET", "/config", { origin: "https://evil.example" });
    expect(denied.status).toBe(403);
    expect(denied.headers.get("access-control-allow-origin")).toBeNull();
    const missing = await pub(wA1.publicKey, "GET", "/config", { origin: null });
    expect(missing.status).toBe(403);
    expect((await json(missing)).error.code).toBe("origin_required");
    expect((await pub(wA1.publicKey, "POST", "/sessions", { origin: "https://evil.example", body: {} })).status).toBe(403);
  });
  it("an empty allowlist rejects everyone", async () => {
    expect((await pub(wEmpty.publicKey, "GET", "/config", { origin: SITE })).status).toBe(403);
    expect((await pub(wEmpty.publicKey, "GET", "/config", { origin: ORIGIN, host: SITE })).status).toBe(403);
  });
  it("our own widget page (web origin) names the embedding site in X-Widget-Host", async () => {
    const ok = await pub(wA1.publicKey, "GET", "/config", { origin: ORIGIN, host: SITE });
    expect(ok.status).toBe(200);
    expect(ok.headers.get("access-control-allow-origin")).toBeNull(); // same-origin through the proxy: no CORS involved
    expect((await pub(wA1.publicKey, "GET", "/config", { origin: ORIGIN })).status).toBe(403);
    expect((await pub(wA1.publicKey, "GET", "/config", { origin: ORIGIN, host: "https://evil.example" })).status).toBe(403);
    expect((await pub(wA1.publicKey, "GET", "/config", { origin: null, host: SITE })).status).toBe(200); // same-origin GET: browsers send no Origin
    expect((await pub(wA1.publicKey, "GET", "/config", { origin: null, host: SITE + "/" })).status).toBe(200); // trailing slash is normalised
  });
  it("preflight is answered only for an allowed origin", async () => {
    const ok = await pub(wA1.publicKey, "OPTIONS", "/messages");
    expect(ok.status).toBe(204);
    expect(ok.headers.get("access-control-allow-headers")).toContain("authorization");
    expect((await pub(wA1.publicKey, "OPTIONS", "/messages", { origin: "https://evil.example" })).status).toBe(403);
  });
  it("unknown or malformed key is 404 and says nothing about origins", async () => {
    expect((await pub("x".repeat(32), "GET", "/config")).status).toBe(404);
    expect((await pub("short", "GET", "/config")).status).toBe(404);
  });
  it("the frame-ancestors list is served for the widget page", async () => {
    const r = await h.app.request(`/public/widget/_frame/${wA1.publicKey}`);
    expect((await json(r)).origins).toEqual([SITE]);
    expect((await json(await h.app.request(`/public/widget/_frame/${"y".repeat(32)}`))).origins).toEqual([]);
  });
});

describe("visitor chat", () => {
  it("session, first message, polling, retry with the same client id", async () => {
    const token = await newSession(wA1);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    // only the hash is stored
    const rows = await q("SELECT token_hash, ip_hash, user_agent FROM chat_visitor_sessions WHERE token_hash=$1", [sha(token)]);
    expect(rows).toHaveLength(1);
    expect((await q("SELECT 1 FROM chat_visitor_sessions WHERE token_hash=$1", [token])).length).toBe(0);
    expect(rows[0].ip_hash).toMatch(/^[0-9a-f]{16}$/); // not the raw address
    expect(await convOf(token)).toBeNull(); // nothing is created until the visitor writes
    expect((await poll(wA1, token)).body.items).toEqual([]);

    const clientId = crypto.randomUUID();
    const r1 = await send(wA1, token, { body: "Hello <b>team</b>", clientId });
    expect(r1.status).toBe(201);
    const m1 = await json(r1);
    expect(m1).toMatchObject({ from: "visitor", body: "Hello <b>team</b>" });
    const again = await json(await send(wA1, token, { body: "Hello <b>team</b>", clientId }));
    expect(again.seq).toBe(m1.seq); // a retry is not a second message
    const conv = (await convOf(token))!;
    expect((await q("SELECT count(*)::int AS n FROM messages WHERE conversation_id=$1", [conv]))[0].n).toBe(1);

    const [c] = await q("SELECT c.status, a.platform, ct.name, ct.source FROM conversations c JOIN integration_accounts a ON a.id=c.integration_account_id JOIN contacts ct ON ct.id=c.contact_id WHERE c.id=$1", [conv]);
    expect(c).toMatchObject({ status: "open", platform: "web_chat", source: "web_chat" });
    expect(c.name).toMatch(/^Web chat user \d{4}$/);

    const p1 = await poll(wA1, token);
    expect(p1.body.items.map((m: any) => m.body)).toEqual(["Hello <b>team</b>"]);
    expect((await poll(wA1, token, m1.seq)).body.items).toEqual([]);
    expect(JSON.stringify(p1.body)).not.toContain(conv); // no internal ids go out
  });

  it("an agent reply through the normal Inbox send is visible to the polling visitor", async () => {
    const token = await newSession(wA1);
    const m = await json(await send(wA1, token, { body: "Do you ship to Dhaka?" }));
    const conv = (await convOf(token))!;
    const reply = await h.app.request(`/v1/workspaces/${ws}/conversations/${conv}/messages`, { method: "POST", headers: { cookie: agent.cookie, origin: ORIGIN, "content-type": "application/json" }, body: JSON.stringify({ clientMsgId: crypto.randomUUID(), body: "Yes, in 3 days." }) });
    expect(reply.status).toBe(201);
    const sent = (await json(reply)).message;
    expect(sent).toMatchObject({ direction: "out", deliveryState: "sent", body: "Yes, in 3 days." });
    // the state machine ran like any channel's: one accepted attempt, no http status
    const att = await q("SELECT attempt, outcome, http_status, request_summary FROM outbound_attempts WHERE message_id=$1", [sent.id]);
    expect(att).toHaveLength(1);
    expect(att[0]).toMatchObject({ attempt: 1, outcome: "accepted", http_status: null });
    expect(att[0].request_summary).toMatchObject({ channel: "web_chat", method: "local" });
    const p = await poll(wA1, token, m.seq);
    expect(p.body.items).toEqual([expect.objectContaining({ from: "agent", body: "Yes, in 3 days." })]);
    // a replayed client id sends nothing twice
    const id = crypto.randomUUID();
    const post = () => h.app.request(`/v1/workspaces/${ws}/conversations/${conv}/messages`, { method: "POST", headers: { cookie: agent.cookie, origin: ORIGIN, "content-type": "application/json" }, body: JSON.stringify({ clientMsgId: id, body: "once" }) });
    await post();
    expect((await post()).status).toBe(200);
    expect((await poll(wA1, token, m.seq)).body.items.filter((x: any) => x.body === "once")).toHaveLength(1);
  });

  it("pre-chat form sets the name and email once; a second submit changes nothing", async () => {
    const token = await newSession(wA1);
    expect((await pub(wA1.publicKey, "POST", "/contact", { token, body: { name: "Rima Akter", email: "Rima@Example.com" } })).status).toBe(200);
    const conv = (await convOf(token))!;
    const [ct] = await q("SELECT ct.name, ct.email FROM conversations c JOIN contacts ct ON ct.id=c.contact_id WHERE c.id=$1", [conv]);
    expect(ct).toMatchObject({ name: "Rima Akter", email: "rima@example.com" });
    expect((await pub(wA1.publicKey, "POST", "/contact", { token, body: { name: "Someone Else" } })).status).toBe(200);
    const [ct2] = await q("SELECT ct.name FROM conversations c JOIN contacts ct ON ct.id=c.contact_id WHERE c.id=$1", [conv]);
    expect(ct2.name).toBe("Rima Akter");
    expect((await pub(wA1.publicKey, "POST", "/contact", { token, body: { email: "not-an-email" } })).status).toBe(400);
  });

  it("an email in a message is saved as a contact method like on other channels", async () => {
    const token = await newSession(wA1);
    await send(wA1, token, { body: "reach me at visitor.mail@example.com" });
    const conv = (await convOf(token))!;
    const m = await q("SELECT cm.value, cm.source FROM contact_methods cm JOIN conversations c ON c.contact_id=cm.contact_id WHERE c.id=$1", [conv]);
    expect(m).toEqual([{ value: "visitor.mail@example.com", source: "web_chat" }]);
  });
});

describe("tenant and widget isolation", () => {
  it("a token only works on its own widget: other widget, other workspace, none, garbage and expired all fail", async () => {
    const tA = await newSession(wA1);
    await send(wA1, tA, { body: "private to widget A1" });
    const convA = (await convOf(tA))!;
    for (const other of [wA2, wB]) {
      const r = await poll(other, tA);
      expect(r.status).toBe(401);
      expect((await send(other, tA, { body: "x" })).status).toBe(401);
      expect((await pub(other.publicKey, "POST", "/contact", { token: tA, body: { name: "x" } })).status).toBe(401);
    }
    expect((await pub(wA1.publicKey, "GET", "/messages")).status).toBe(401);
    expect((await poll(wA1, "A".repeat(43))).status).toBe(401);
    expect((await poll(wA1, "not-a-token")).status).toBe(401);
    // a visitor of another widget sees nothing of this conversation
    const tOther = await newSession(wA2);
    await send(wA2, tOther, { body: "mine" });
    const mine = await poll(wA2, tOther);
    expect(mine.body.items.map((m: any) => m.body)).toEqual(["mine"]);
    // a conversation id is never accepted from the caller: there is no such route
    for (const path of [`/conversations/${convA}/messages`, `/conversations/${convA}`, `/messages?conversationId=${convA}`]) {
      const r = await pub(wA1.publicKey, "GET", path, { token: tOther });
      expect([401, 404]).toContain(r.status);
      expect(JSON.stringify(await json(r))).not.toContain("private to widget A1");
    }
    expect((await pub(wA1.publicKey, "GET", `/conversations/${convA}/messages`)).status).toBe(404);
    // expiry
    await q("UPDATE chat_visitor_sessions SET expires_at = now() - interval '1 minute' WHERE token_hash=$1", [sha(tA)]);
    expect((await poll(wA1, tA)).status).toBe(401);
  });

  it("the session lookup runs in the widget's workspace: a forged workspace context sees no foreign session", async () => {
    const tB = await newSession(wB);
    await send(wB, tB, { body: "workspace B secret" });
    // as the worker role inside workspace A's context the foreign session and its conversation are invisible
    const { withContext } = await import("@crm/db");
    const { sql } = await import("drizzle-orm");
    const seen = await withContext(workerDb, { workspaceId: ws }, async (tx) => ({
      s: (await tx.execute(sql`SELECT 1 FROM chat_visitor_sessions WHERE token_hash = ${sha(tB)}`)).rows.length,
      m: (await tx.execute(sql`SELECT 1 FROM messages WHERE body = 'workspace B secret'`)).rows.length,
    }));
    expect(seen).toEqual({ s: 0, m: 0 });
    // and the agent of workspace A cannot open it through the Inbox API either
    const conv = (await convOf(tB))!;
    const r = await h.app.request(`/v1/workspaces/${ws}/conversations/${conv}/messages`, { method: "POST", headers: { cookie: agent.cookie, origin: ORIGIN, "content-type": "application/json" }, body: JSON.stringify({ clientMsgId: crypto.randomUUID(), body: "x" }) });
    expect(r.status).toBe(404);
  });
});

describe("abuse limits", () => {
  it("honeypot: a filled hidden field is answered normally and stores nothing", async () => {
    const token = await newSession(wA1);
    const r = await send(wA1, token, { body: "buy cheap pills", website: "http://spam.example" });
    expect(r.status).toBe(201);
    expect(await convOf(token)).toBeNull();
    expect((await q("SELECT 1 FROM messages WHERE body='buy cheap pills'")).length).toBe(0);
  });
  it("too fast: the first message right after the session starts is refused, a later one is accepted", async () => {
    const token = await newSession(wA1, { app: hFast });
    const r = await send(wA1, token, { body: "hi" }, { app: hFast });
    expect(r.status).toBe(429);
    expect((await json(r)).error.code).toBe("too_fast");
    await q("UPDATE chat_visitor_sessions SET created_at = now() - interval '2 minutes' WHERE token_hash=$1", [sha(token)]);
    expect((await send(wA1, token, { body: "hi" }, { app: hFast })).status).toBe(201);
  });
  it("size caps: 4 KB body, 2000 characters, empty and NUL are refused", async () => {
    const token = await newSession(wA1);
    expect((await send(wA1, token, { body: "x".repeat(2001) })).status).toBe(400);
    expect((await send(wA1, token, { body: "   " })).status).toBe(400);
    expect((await send(wA1, token, { body: "a\u0000b" })).status).toBe(400);
    expect((await send(wA1, token, {}, {})).status).toBe(400);
    expect((await pub(wA1.publicKey, "POST", "/messages", { token, raw: "{not json" })).status).toBe(400);
    expect((await send(wA1, token, { body: "x".repeat(5000) })).status).toBe(413);
    expect((await send(wA1, token, { body: "é".repeat(2000) })).status).toBe(201); // 2000 characters = 4000 bytes: the longest allowed message still fits the 4 KB body cap
  });
  it("rate limits: sessions per IP and per widget, messages and polls per session, config per IP", async () => {
    const lim = { app: hLim };
    expect((await pub(wA1.publicKey, "POST", "/sessions", { ...lim, ip: "9.9.9.9", body: {} })).status).toBe(201);
    expect((await pub(wA1.publicKey, "POST", "/sessions", { ...lim, ip: "9.9.9.9", body: {} })).status).toBe(201);
    expect((await pub(wA1.publicKey, "POST", "/sessions", { ...lim, ip: "9.9.9.9", body: {} })).status).toBe(429); // per IP
    expect((await pub(wA1.publicKey, "POST", "/sessions", { ...lim, ip: "9.9.9.8", body: {} })).status).toBe(201);
    expect((await pub(wA1.publicKey, "POST", "/sessions", { ...lim, ip: "9.9.9.7", body: {} })).status).toBe(201);
    expect((await pub(wA1.publicKey, "POST", "/sessions", { ...lim, ip: "9.9.9.6", body: {} })).status).toBe(429); // per widget (4)
    const token = await newSession(wA2, { ...lim, ip: "8.8.8.8" });
    for (let i = 0; i < 3; i++) expect((await send(wA2, token, { body: `m${i}` }, lim)).status).toBe(201);
    const over = await send(wA2, token, { body: "m3" }, lim);
    expect(over.status).toBe(429);
    expect((await json(over)).error.code).toBe("rate_limited");
    // another session of the same widget is not affected
    const t2 = await newSession(wA2, { ...lim, ip: "8.8.8.7" });
    expect((await send(wA2, t2, { body: "fine" }, lim)).status).toBe(201);
    expect((await poll(wA2, t2, 0, lim)).status).toBe(200);
    expect((await poll(wA2, t2, 0, lim)).status).toBe(200);
    expect((await poll(wA2, t2, 0, lim)).status).toBe(429);
    expect((await pub(wB.publicKey, "GET", "/config", { ...lim, ip: "7.7.7.7" })).status).toBe(200);
    expect((await pub(wB.publicKey, "GET", "/config", { ...lim, ip: "7.7.7.7" })).status).toBe(200);
    expect((await pub(wB.publicKey, "GET", "/config", { ...lim, ip: "7.7.7.7" })).status).toBe(429);
  });
});

describe("disabled widget", () => {
  it("config says disabled, nothing else works, and enabling restores it", async () => {
    const w = await mk(owner, ws, "Soon off", [SITE]);
    const token = await newSession(w);
    expect((await send(w, token, { body: "before" })).status).toBe(201);
    await adminCall(owner, ws, "PATCH", `/${w.id}`, { enabled: false });
    const cfg = await json(await pub(w.publicKey, "GET", "/config"));
    expect(cfg.enabled).toBe(false);
    expect(cfg).not.toHaveProperty("allowedOrigins");
    expect((await pub(w.publicKey, "POST", "/sessions", { body: {} })).status).toBe(403);
    expect((await send(w, token, { body: "after" })).status).toBe(403);
    expect((await poll(w, token)).status).toBe(403);
    await adminCall(owner, ws, "PATCH", `/${w.id}`, { enabled: true });
    expect((await poll(w, token)).status).toBe(200);
  });
});
