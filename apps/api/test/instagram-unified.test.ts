import { createHmac } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { createDb, type Db } from "@crm/db";
import { buildMessagePayload, createMockGraph, createSecretBox, GraphError, mockSecret, SendError, signedFixture, type UserProfile } from "@crm/integrations";
import type { MetaConnectDeps } from "../src/inbox/meta-connect.ts";
import { processWebhookEvent } from "../src/inbox/process.ts";
import { createProfileEnricher } from "../src/inbox/profile.ts";
import { metaWebhookRoutes } from "../src/inbox/webhook.ts";
import { bootstrap, type Harness, type TestUser } from "./harness.ts";

const DB = process.env.CRM_DB_NAME ?? "crm";
const box = createSecretBox({ k1: Buffer.alloc(32, 3).toString("base64") }, "k1");
const REDIRECT = "http://localhost:3000/v1/integrations/instagram/callback";
const TOKEN = "mock-user-token"; // what the mock Graph returns from the code exchange
let h: Harness, workerDb: Db, ingestDb: Db, hook: Hono;
let graph: ReturnType<typeof createMockGraph>;
let deps: MetaConnectDeps;
let clock = Date.now();
let owner: TestUser, admin: TestUser, agent: TestUser, viewer: TestUser, other: TestUser;
let ws: string, wsOther: string;
const digits = () => `5${Math.floor(Math.random() * 1e13).toString().padStart(13, "0")}`;
const RUN = Math.random().toString(36).slice(2, 8);
const q = async (text: string, params: unknown[] = []) => (await h.admin.query(text, params)).rows;
const uuid = () => crypto.randomUUID();
const cookiesOf = (res: Response) => Object.fromEntries(res.headers.getSetCookie().map((c) => c.split(";")[0]!.split("=") as [string, string]));
const call = (u: TestUser, method: string, path: string, body?: unknown, cookies: Record<string, string> = {}) =>
  h.app.request(path, { method, headers: { cookie: [u.cookie, ...Object.entries(cookies).map(([k, v]) => `${k}=${v}`)].join("; "), origin: "http://localhost:3000", ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
const IGW = (w: string) => `/v1/workspaces/${w}/integrations/instagram`;
const MW = (w: string) => `/v1/workspaces/${w}/integrations/meta`;
const SEND = (w: string, c: string) => `/v1/workspaces/${w}/conversations/${c}/messages`;
const resultOf = (res: Response) => new URL(res.headers.get("location")!, "http://x").searchParams.get("meta");
const share = (...a: { id: string; username?: string | null }[]) => graph.state.assigned!.set(TOKEN, a.map((x) => ({ id: x.id, username: x.username ?? null })));
const unifiedSends = () => graph.calls.filter((c) => c.startsWith("sendigu:"));
const accountRow = async (id: string) => (await q("SELECT * FROM integration_accounts WHERE platform='instagram' AND external_account_id=$1", [id]))[0];

/** start -> (mock dialog) -> callback. */
async function flow(u: TestUser, w: string, o: { tamper?: (s: string) => string; keepNonce?: boolean; nonce?: string } = {}) {
  const start = await call(u, "POST", `${IGW(w)}/connect/start`);
  expect(start.status).toBe(200);
  const nonce = cookiesOf(start).crm_ig_nonce!;
  const cb = new URL((await start.json()).authUrl);
  if (o.tamper) cb.searchParams.set("state", o.tamper(cb.searchParams.get("state")!));
  return call(u, "GET", `${cb.pathname}${cb.search}`, undefined, o.keepNonce === false ? {} : { crm_ig_nonce: o.nonce ?? nonce });
}

beforeAll(async () => {
  workerDb = createDb(`postgres://crm_worker:worker_dev@127.0.0.1:5436/${DB}`);
  ingestDb = createDb(`postgres://crm_ingest:ingest_dev@127.0.0.1:5436/${DB}`);
  hook = new Hono().route("/webhooks/meta", metaWebhookRoutes({ appSecrets: [mockSecret], verifyToken: "v", ingestDb }));
  graph = createMockGraph({ pages: [], assigned: new Map() });
  deps = {
    graph, igUnified: { configId: "777000111", redirectUri: REDIRECT }, box, workerDb, appId: "123456", configId: "654321", graphVersion: "v25.0", redirectUri: "http://localhost:3000/v1/integrations/meta/callback", webOrigin: "http://localhost:3000",
    stateKey: createHmac("sha256", "k").update("s").digest(), userHashKey: createHmac("sha256", "k").update("u").digest(), mock: true, secureCookies: false, now: () => clock,
  };
  h = await bootstrap(undefined, deps);
  [owner, admin, agent, viewer, other] = (await Promise.all(["uowner", "uadmin", "uagent", "uviewer", "uother"].map((l) => h.newUser(l)))) as TestUser[] as [TestUser, TestUser, TestUser, TestUser, TestUser];
  ws = await h.workspace(owner, "IGU A", { admin, agent, viewer });
  wsOther = await h.workspace(other, "IGU B");
});
afterAll(async () => {
  await q("UPDATE integration_accounts SET last_token_check_at = now(), status = 'disabled' WHERE workspace_id = ANY($1::uuid[])", [[ws, wsOther]]);
  await workerDb.$client.end();
  await ingestDb.$client.end();
  await h.close();
});

describe("start: login URL and permissions", () => {
  it("builds the Facebook Login for Business URL with the Instagram configuration, our redirect and a signed state; no secret, no scope list", async () => {
    const real = await bootstrap(undefined, { ...deps, mock: false });
    try {
      const u = await real.newUser("ustart");
      const w = await real.workspace(u, "IGU Start");
      const res = await real.app.request(`${IGW(w)}/connect/start`, { method: "POST", headers: { cookie: u.cookie, origin: "http://localhost:3000" } });
      expect(res.status).toBe(200);
      const url = new URL((await res.json()).authUrl);
      expect(`${url.origin}${url.pathname}`).toBe("https://www.facebook.com/v25.0/dialog/oauth");
      expect(Object.fromEntries(url.searchParams)).toMatchObject({ client_id: "123456", config_id: "777000111", redirect_uri: REDIRECT, response_type: "code", override_default_response_type: "true", prompt: "login" });
      expect(url.searchParams.has("display")).toBe(false);
      expect(url.searchParams.get("state")).toMatch(/^[\w-]+\.[\w-]+$/);
      expect(url.searchParams.has("scope")).toBe(false); // permissions come from the configuration
      expect(url.toString()).not.toMatch(/secret|token/i);
      expect(res.headers.getSetCookie().join(";")).toMatch(/crm_ig_nonce=.*HttpOnly/i);
    } finally { await real.close(); }
  });
  it("only owners and admins can start; 503 and a false flag when direct connection is not configured", async () => {
    for (const u of [agent, viewer]) expect((await call(u, "POST", `${IGW(ws)}/connect/start`)).status).toBe(403);
    expect((await call(admin, "POST", `${IGW(ws)}/connect/start`)).status).toBe(200);
    expect((await (await call(admin, "GET", MW(ws))).json()).instagramUnifiedConfigured).toBe(true);
    const bare = await bootstrap(undefined, { ...deps, igUnified: undefined });
    try {
      const u = await bare.newUser("ubare");
      const w = await bare.workspace(u, "IGU Bare");
      expect((await bare.app.request(`${IGW(w)}/connect/start`, { method: "POST", headers: { cookie: u.cookie, origin: "http://localhost:3000" } })).status).toBe(503);
      expect((await (await bare.app.request(MW(w), { headers: { cookie: u.cookie } })).json()).instagramUnifiedConfigured).toBe(false);
    } finally { await bare.close(); }
  });
});

describe("callback: state validation", () => {
  it("rejects a tampered state, no/wrong nonce, another user, an expired state and a Facebook-flow state; nothing is exchanged or stored", async () => {
    const id = digits();
    share({ id, username: "state.test" });
    graph.calls.length = 0;
    const bad = [
      await flow(owner, ws, { tamper: (s) => s.replace(/.$/, (c) => (c === "A" ? "B" : "A")) }),
      await flow(owner, ws, { keepNonce: false }),
      await flow(owner, ws, { nonce: "not-the-nonce" }),
    ];
    for (const r of bad) expect(resultOf(r)).toBe("invalid_state");
    const start = await call(owner, "POST", `${IGW(ws)}/connect/start`);
    const nonce = cookiesOf(start).crm_ig_nonce!;
    const cb = new URL((await start.json()).authUrl);
    expect(resultOf(await call(admin, "GET", `${cb.pathname}${cb.search}`, undefined, { crm_ig_nonce: nonce }))).toBe("invalid_state"); // another user
    const s2 = await call(owner, "POST", `${IGW(ws)}/connect/start`);
    const n2 = cookiesOf(s2).crm_ig_nonce!;
    const cb2 = new URL((await s2.json()).authUrl);
    clock += 11 * 60_000;
    expect(resultOf(await call(owner, "GET", `${cb2.pathname}${cb2.search}`, undefined, { crm_ig_nonce: n2 }))).toBe("invalid_state");
    clock = Date.now();
    const fb = await call(owner, "POST", `${MW(ws)}/connect/start`);
    const cb3 = new URL(REDIRECT);
    cb3.searchParams.set("state", new URL((await fb.json()).authUrl).searchParams.get("state")!);
    cb3.searchParams.set("code", "good-code");
    expect(resultOf(await call(owner, "GET", `${cb3.pathname}${cb3.search}`, undefined, { crm_ig_nonce: cookiesOf(fb).crm_meta_nonce! }))).toBe("invalid_state");
    expect(await accountRow(id)).toBeUndefined();
    expect(graph.calls).not.toContain("exchangeCode");
  });
  it("an Instagram-flow state is refused by the Facebook callback even with a matching Facebook nonce cookie", async () => {
    const start = await call(owner, "POST", `${IGW(ws)}/connect/start`);
    const nonce = cookiesOf(start).crm_ig_nonce!;
    const cb = new URL("http://localhost:3000/v1/integrations/meta/callback");
    cb.searchParams.set("state", new URL((await start.json()).authUrl).searchParams.get("state")!);
    cb.searchParams.set("code", "good-code");
    graph.calls.length = 0;
    expect(resultOf(await call(owner, "GET", `${cb.pathname}${cb.search}`, undefined, { crm_meta_nonce: nonce }))).toBe("invalid_state");
    expect(graph.calls).not.toContain("exchangeCode");
  });
});

describe("callback: connecting", () => {
  it("exchanges the code on the server, lists the shared account, stores the system-user token sealed with method and expiry, subscribes it, audits, and exposes no token", async () => {
    const id = digits();
    share({ id, username: "creator.one" });
    const expires = new Date(Date.now() + 30 * 86_400_000);
    graph.state.tokenInfo = new Map([[TOKEN, { isValid: true, expiresAt: expires, scopes: [], errorCode: null }]]);
    graph.calls.length = 0;
    const res = await flow(owner, ws);
    expect(res.status).toBe(302);
    expect(resultOf(res)).toBe("ig_connected");
    expect(res.headers.get("location")).not.toContain(TOKEN);
    expect(res.headers.get("location")).toContain("channel=instagram");
    expect(graph.calls.slice(0, 3)).toEqual(["exchangeCode", "debugToken", "assignedAccounts"]);
    expect(graph.calls).not.toContain("exchangeLongLived"); // a system-user token is not a user token
    expect(graph.calls).toContain(`subscribe:${id}`);
    const a = await accountRow(id);
    expect(a).toMatchObject({ workspace_id: ws, platform: "instagram", auth_method: "unified", display_name: "@creator.one", status: "connected", connected_by: owner.id, connected_meta_user_hash: null });
    expect(new Date(a.token_expires_at).getTime()).toBe(expires.getTime());
    const [sec] = await q("SELECT ciphertext, nonce, key_id FROM integration_secrets WHERE integration_account_id=$1", [a.id]);
    expect(box.open({ ciphertext: sec.ciphertext, nonce: sec.nonce, keyId: sec.key_id }, `${ws}:${a.id}`)).toBe(TOKEN);
    expect(Buffer.from(sec.ciphertext).includes(Buffer.from(TOKEN))).toBe(false);
    expect((await q("SELECT data FROM integration_events WHERE integration_account_id=$1 AND kind='status_changed'", [a.id]))[0].data).toMatchObject({ subscription: "subscribed", method: "instagram_unified" });
    expect((await q("SELECT action FROM audit_log WHERE entity_id=$1", [a.id])).map((r) => r.action)).toContain("integration.instagram_unified.connected");
    expect((await call(viewer, "GET", MW(ws))).status).toBe(403);
    const list = await (await call(admin, "GET", MW(ws))).text();
    expect(list).toContain('"authMethod":"unified"');
    expect(list).not.toContain(TOKEN);
    expect(await (await call(owner, "GET", `${MW(ws)}/accounts/${a.id}/events`)).text()).not.toContain(TOKEN);
    graph.state.tokenInfo = undefined;
  });

  it("a token that never expires is stored with no expiry; an unreadable expiry only means unknown", async () => {
    const id = digits();
    share({ id });
    graph.state.tokenInfo = new Map([[TOKEN, { isValid: true, expiresAt: null, scopes: [], errorCode: null }]]);
    expect(resultOf(await flow(owner, ws))).toBe("ig_connected");
    const a = await accountRow(id);
    expect(a.token_expires_at).toBeNull();
    expect(a.display_name).toBe("Instagram account"); // no username given
    graph.state.tokenInfo = undefined;
  });

  it("connects several shared accounts, skips one that belongs to another workspace, and reports each outcome", async () => {
    const a = digits(), b = digits(), taken = digits();
    await q("INSERT INTO integration_accounts (workspace_id, platform, external_account_id, status) VALUES ($1,'instagram',$2,'connected')", [wsOther, taken]);
    share({ id: a, username: "one" }, { id: taken, username: "taken" }, { id: b, username: "two" });
    expect(resultOf(await flow(owner, ws))).toBe("ig_partial");
    expect((await accountRow(a)).workspace_id).toBe(ws);
    expect((await accountRow(b)).workspace_id).toBe(ws);
    expect((await accountRow(taken)).workspace_id).toBe(wsOther);
    share({ id: taken });
    expect(resultOf(await flow(owner, ws))).toBe("account_unavailable");
  });

  it("handles no shared account, a failed exchange, a refused subscription, and denial without a half-connected account", async () => {
    share();
    expect(resultOf(await flow(owner, ws))).toBe("ig_no_accounts");
    const id = digits();
    share({ id, username: "nosub" });
    graph.state.failSubscribe = true;
    expect(resultOf(await flow(owner, ws))).toBe("ig_connected_unsubscribed");
    expect((await accountRow(id)).status).toBe("connected");
    graph.state.failSubscribe = false;
    const orig = graph.exchangeCode;
    graph.exchangeCode = async () => { throw new GraphError(100, 400, "other"); };
    try { expect(resultOf(await flow(owner, ws))).toBe("error"); } finally { graph.exchangeCode = orig; }
    const start = await call(owner, "POST", `${IGW(ws)}/connect/start`);
    const nonce = cookiesOf(start).crm_ig_nonce!;
    const cb = new URL((await start.json()).authUrl);
    cb.searchParams.delete("code");
    cb.searchParams.set("error", "access_denied");
    expect(resultOf(await call(owner, "GET", `${cb.pathname}${cb.search}`, undefined, { crm_ig_nonce: nonce }))).toBe("denied");
  });

  it("a storage failure for one of several shared accounts is reported as partial, the others stay connected, and a retry connects the rest without duplicates", async () => {
    const a = digits(), b = digits();
    share({ id: a, username: "first" }, { id: b, username: "second" });
    const orig = box.seal;
    let n = 0;
    box.seal = (...args: Parameters<typeof orig>) => { if (++n === 2) throw new Error("seal failed"); return orig(...args); };
    try { expect(resultOf(await flow(owner, ws))).toBe("ig_partial"); } finally { box.seal = orig; }
    expect((await accountRow(a)).status).toBe("connected");
    expect(await accountRow(b)).toBeUndefined();
    expect(resultOf(await flow(owner, ws))).toBe("ig_connected"); // retry
    expect((await q("SELECT count(*)::int AS n FROM integration_accounts WHERE external_account_id = ANY($1::text[])", [[a, b]]))[0].n).toBe(2);
    expect((await q("SELECT count(*)::int AS n FROM integration_secrets s JOIN integration_accounts x ON x.id=s.integration_account_id WHERE x.external_account_id = ANY($1::text[])", [[a, b]]))[0].n).toBe(2); // one token version each
  });

  it("more than 10 shared accounts: the first 10 connect and the result says some were skipped", async () => {
    const ids = Array.from({ length: 12 }, () => digits());
    share(...ids.map((id) => ({ id })));
    expect(resultOf(await flow(owner, ws))).toBe("ig_partial");
    expect((await q("SELECT count(*)::int AS n FROM integration_accounts WHERE external_account_id = ANY($1::text[])", [ids]))[0].n).toBe(10);
  });

  it("a storage failure lands on the settings page with an error, never a bare 500, and leaves no account", async () => {
    const id = digits();
    share({ id });
    const orig = box.seal;
    box.seal = () => { throw new Error("seal failed"); };
    try {
      const res = await flow(owner, ws);
      expect(res.status).toBe(302);
      expect(resultOf(res)).toBe("error");
    } finally { box.seal = orig; }
    expect(await accountRow(id)).toBeUndefined();
  });

  it("two workspaces connecting the same account at the same moment: exactly one wins", async () => {
    const id = digits();
    share({ id, username: "race" });
    const [a, b] = await Promise.all([flow(owner, ws), flow(other, wsOther)]);
    expect([resultOf(a), resultOf(b)].sort()).toEqual(["account_unavailable", "ig_connected"]);
    expect((await q("SELECT count(*)::int AS n FROM integration_accounts WHERE platform='instagram' AND external_account_id=$1", [id]))[0].n).toBe(1);
    expect((await q("SELECT count(*)::int AS n FROM integration_secrets s JOIN integration_accounts a ON a.id=s.integration_account_id WHERE a.external_account_id=$1", [id]))[0].n).toBe(1);
  });

  it("reconnect keeps one row and one token version; a Page-based account of the same id switches to the direct method", async () => {
    const id = digits();
    share({ id, username: "again" });
    await flow(owner, ws);
    await flow(owner, ws);
    expect((await q("SELECT count(*)::int AS n FROM integration_accounts WHERE external_account_id=$1", [id]))[0].n).toBe(1);
    expect((await q("SELECT count(*)::int AS n FROM integration_secrets s JOIN integration_accounts a ON a.id=s.integration_account_id WHERE a.external_account_id=$1", [id]))[0].n).toBe(1);
    const pageIg = digits();
    await q("INSERT INTO integration_accounts (workspace_id, platform, external_account_id, status, display_name) VALUES ($1,'instagram',$2,'reauth_required','Old (Instagram)')", [ws, pageIg]);
    expect((await accountRow(pageIg)).auth_method).toBe("facebook");
    share({ id: pageIg, username: "now.direct" });
    await flow(owner, ws);
    expect(await accountRow(pageIg)).toMatchObject({ auth_method: "unified", status: "connected", display_name: "@now.direct" });
  });

  it("a rejected token flips the account to Reconnect needed; reconnecting keeps the same account, its conversations and messages, and replying works again", async () => {
    const id = digits();
    share({ id, username: "history" });
    await flow(owner, ws);
    const a = await accountRow(id);
    const igsid = digits();
    expect((await (async () => { const f = signedFixture(buildMessagePayload({ object: "instagram", accountId: id, userId: igsid, mid: `igu.${RUN}.hist`, text: "before expiry", timestampMs: Date.now() }), mockSecret); return hook.request("/webhooks/meta/instagram", { method: "POST", body: new Uint8Array(f.raw), headers: { "content-type": "application/json", "x-hub-signature-256": f.signature } }); })()).status).toBe(200);
    for (const e of await q("SELECT id FROM webhook_events WHERE account_ref=$1 AND status IN ('received','failed')", [id])) await processWebhookEvent(workerDb, e.id);
    const [c] = await q("SELECT id FROM conversations WHERE integration_account_id=$1", [a.id]);
    graph.state.tokenInfo = new Map([[TOKEN, { isValid: false, expiresAt: null, scopes: [], errorCode: 190 }]]);
    expect((await (await call(owner, "POST", `${MW(ws)}/accounts/${a.id}/check-token`)).json()).status).toBe("reauth_required");
    graph.state.tokenInfo = undefined;
    expect((await call(owner, "POST", SEND(ws, c.id), { clientMsgId: uuid(), body: "while broken" })).status).toBe(409); // refused, nothing sent
    expect(resultOf(await flow(owner, ws))).toBe("ig_connected");
    expect(await accountRow(id)).toMatchObject({ id: a.id, status: "connected", auth_method: "unified" });
    expect((await q("SELECT count(*)::int AS n FROM conversations WHERE integration_account_id=$1", [a.id]))[0].n).toBe(1);
    expect((await q("SELECT body FROM messages WHERE conversation_id=$1 AND direction='in'", [c.id])).map((m) => m.body)).toEqual(["before expiry"]);
    graph.state.sends = ["mid.igu.after"];
    expect((await (await call(owner, "POST", SEND(ws, c.id), { clientMsgId: uuid(), body: "back again" })).json()).message.deliveryState).toBe("sent");
  });

  it("disconnect removes the token and disables the account; only owners/admins, and only inside the workspace", async () => {
    const id = digits();
    share({ id, username: "bye" });
    await flow(owner, ws);
    const a = await accountRow(id);
    for (const u of [agent, viewer]) expect((await call(u, "POST", `${MW(ws)}/accounts/${a.id}/disconnect`)).status).toBe(403);
    expect((await call(other, "POST", `${MW(wsOther)}/accounts/${a.id}/disconnect`)).status).toBe(404);
    expect((await call(admin, "POST", `${MW(ws)}/accounts/${a.id}/disconnect`)).status).toBe(200);
    expect((await q("SELECT status, (SELECT count(*)::int FROM integration_secrets WHERE integration_account_id=$1) AS secrets FROM integration_accounts WHERE id=$1", [a.id]))[0]).toEqual({ status: "disabled", secrets: 0 });
    expect(JSON.stringify(await (await call(other, "GET", MW(wsOther))).json())).not.toContain(id);
  });
});

describe("token check and subscription", () => {
  it("Check token uses debug_token (system-user tokens are Facebook tokens) and a rejected token needs a reconnect; Re-check subscription uses the Instagram account id", async () => {
    const id = digits();
    share({ id });
    await flow(owner, ws);
    const a = await accountRow(id);
    graph.calls.length = 0;
    expect((await (await call(owner, "POST", `${MW(ws)}/accounts/${a.id}/check-token`)).json()).status).toBe("connected");
    expect(graph.calls).toContain("debugToken");
    graph.calls.length = 0;
    expect((await (await call(owner, "POST", `${MW(ws)}/accounts/${a.id}/resubscribe`)).json()).subscription).toBe("subscribed");
    expect(graph.calls).toContain(`subscribe:${id}`);
    graph.state.tokenInfo = new Map([[TOKEN, { isValid: false, expiresAt: null, scopes: [], errorCode: 190 }]]);
    expect((await (await call(owner, "POST", `${MW(ws)}/accounts/${a.id}/check-token`)).json()).status).toBe("reauth_required");
    graph.state.tokenInfo = undefined;
  });
});

describe("messaging through a directly connected account", () => {
  const post = async (payload: unknown, secret = mockSecret, path = "instagram") => {
    const f = signedFixture(payload, secret);
    return hook.request(`/webhooks/meta/${path}`, { method: "POST", body: new Uint8Array(f.raw), headers: { "content-type": "application/json", "x-hub-signature-256": f.signature } });
  };
  const drain = async (ref: string) => { // SKIP LOCKED: loop until no event is left (another worker may hold one right now)
    for (let i = 0; i < 50; i++) {
      const todo = await q("SELECT id FROM webhook_events WHERE account_ref=$1 AND status IN ('received','failed') ORDER BY received_at", [ref]);
      if (!todo.length) return;
      for (const e of todo) await processWebhookEvent(workerDb, e.id);
      if (i > 0) await new Promise((r) => setTimeout(r, 50));
    }
  };
  async function conv(text = "hello") {
    const id = digits();
    share({ id, username: "msg.acct" });
    await flow(owner, ws);
    const a = await accountRow(id);
    const igsid = digits();
    expect((await post(buildMessagePayload({ object: "instagram", accountId: id, userId: igsid, mid: `igu.${RUN}.${digits()}`, text, timestampMs: Date.now() }))).status).toBe(200);
    await drain(id);
    const [c] = await q("SELECT id FROM conversations WHERE integration_account_id=$1", [a.id]);
    return { id, accId: a.id as string, igsid, conv: c.id as string };
  }
  const outRows = (c: string) => q("SELECT * FROM messages WHERE conversation_id=$1 AND direction='out' ORDER BY seq", [c]);

  it("an inbound DM creates an Instagram conversation; a duplicate delivery changes nothing; a bad signature stores nothing", async () => {
    const s = await conv("Hello from IG");
    expect((await q("SELECT ia.platform, ia.auth_method, ct.source FROM conversations c JOIN integration_accounts ia ON ia.id=c.integration_account_id JOIN contacts ct ON ct.id=c.contact_id WHERE c.id=$1", [s.conv]))[0]).toEqual({ platform: "instagram", auth_method: "unified", source: "instagram" });
    const payload = buildMessagePayload({ object: "instagram", accountId: s.id, userId: s.igsid, mid: `igu.${RUN}.dupe`, text: "once", timestampMs: Date.now() });
    expect((await post(payload, "wrong-secret")).status).toBe(403);
    await post(payload); await post(payload);
    await drain(s.id);
    expect((await q("SELECT count(*)::int AS n FROM messages WHERE conversation_id=$1 AND body='once'", [s.conv]))[0].n).toBe(1);
  });

  it("sends through POST /{ig-id}/messages with the system-user token, once per client id, and adopts the echo", async () => {
    const s = await conv();
    graph.calls.length = 0;
    graph.state.sends = ["mid.igu.1"];
    const id = uuid();
    const rs = await Promise.all([1, 2, 3].map(() => call(agent, "POST", SEND(ws, s.conv), { clientMsgId: id, body: "Hi from the CRM" })));
    expect(rs.every((r) => r.status === 200 || r.status === 201)).toBe(true);
    expect(unifiedSends()).toEqual([`sendigu:${s.id}:${s.igsid}:Hi from the CRM`]);
    expect(graph.calls.filter((c) => c.startsWith("sendig:") || c.startsWith("send:"))).toEqual([]);
    const [row] = await outRows(s.conv);
    expect(row).toMatchObject({ delivery_state: "sent", external_id: "mid.igu.1" });
    const [att] = await q("SELECT request_summary, outcome FROM outbound_attempts WHERE message_id=$1", [row.id]);
    expect(att).toMatchObject({ outcome: "accepted", request_summary: { method: "unified", channel: "instagram" } });
    expect(JSON.stringify(att)).not.toContain(TOKEN);
    await post(buildMessagePayload({ object: "instagram", accountId: s.id, userId: s.igsid, mid: "mid.igu.1", text: "Hi from the CRM", timestampMs: Date.now(), echo: true }));
    await drain(s.id);
    expect(await outRows(s.conv)).toHaveLength(1);
  });

  it("the echo of a message we already recorded as sent has a DIFFERENT id (as seen on a real account) and must not become a second bubble", async () => {
    const s = await conv();
    graph.calls.length = 0;
    graph.state.sends = ["send.response.id.A", "send.response.id.B"];
    const echo = async (mid: string, text: string) => { expect((await post(buildMessagePayload({ object: "instagram", accountId: s.id, userId: s.igsid, mid, text, timestampMs: Date.now(), echo: true }))).status).toBe(200); await drain(s.id); };
    await call(owner, "POST", SEND(ws, s.conv), { clientMsgId: uuid(), body: "hi there" });
    await echo("echo.webhook.id.A", "hi there"); // different id, same text
    await echo("echo.webhook.id.A", "hi there"); // re-delivered by Meta
    expect(await outRows(s.conv)).toHaveLength(1);
    // a second identical reply produces its own echo: still exactly two rows, none "external"
    await call(owner, "POST", SEND(ws, s.conv), { clientMsgId: uuid(), body: "hi there" });
    await echo("echo.webhook.id.B", "hi there");
    await echo("echo.webhook.id.B", "hi there");
    expect((await outRows(s.conv)).map((r) => r.sender_kind)).toEqual(["user", "user"]);
    // a message typed in the Instagram app (different text) is still shown, and survives its own re-delivery
    await echo("echo.native.1", "typed in the app");
    await echo("echo.native.1", "typed in the app");
    expect((await outRows(s.conv)).map((r) => [r.sender_kind, r.body])).toEqual([["user", "hi there"], ["user", "hi there"], ["external", "typed in the app"]]);
    // documented limit: an app-typed message with the SAME text as a CRM reply inside the 10 minute window is indistinguishable from our echo and is not shown separately
    await echo("echo.native.2", "hi there");
    expect((await outRows(s.conv)).filter((r) => r.sender_kind === "external").map((r) => r.body)).toEqual(["typed in the app"]);
  });

  it("a timeout is UNKNOWN and never re-sent (an echo can adopt it); a refusal is a definite failure; window and 1000-byte limit apply; roles and tenants are enforced", async () => {
    const s = await conv();
    graph.calls.length = 0;
    graph.state.sends = [new SendError("ambiguous", null, null, null), new SendError("rejected", 400, 10, 2534022)];
    const a = (await (await call(owner, "POST", SEND(ws, s.conv), { clientMsgId: uuid(), body: "one" })).json()).message;
    expect(a.deliveryState).toBe("unknown");
    expect(unifiedSends()).toHaveLength(1);
    await post(buildMessagePayload({ object: "instagram", accountId: s.id, userId: s.igsid, mid: `mid.igu.late.${RUN}`, text: "one", timestampMs: Date.now(), echo: true }));
    await drain(s.id);
    expect((await outRows(s.conv))[0]).toMatchObject({ delivery_state: "sent" });
    const b = (await (await call(owner, "POST", SEND(ws, s.conv), { clientMsgId: uuid(), body: "two" })).json()).message;
    expect(b).toMatchObject({ deliveryState: "failed", failureCode: "window_closed" });
    expect(unifiedSends()).toHaveLength(2);
    expect((await call(owner, "POST", SEND(ws, s.conv), { clientMsgId: uuid(), body: "ক".repeat(334) })).status).toBe(422);
    await q("BEGIN");
    await q("SET LOCAL session_replication_role = replica");
    await q("UPDATE conversations SET last_inbound_at = now() - interval '26 hours' WHERE id=$1", [s.conv]);
    await q("COMMIT");
    const closed = await call(owner, "POST", SEND(ws, s.conv), { clientMsgId: uuid(), body: "late" });
    expect([closed.status, (await closed.json()).error.code]).toEqual([409, "window_closed"]);
    expect((await call(viewer, "POST", SEND(ws, s.conv), { clientMsgId: uuid(), body: "x" })).status).toBe(403);
    expect((await call(other, "POST", SEND(wsOther, s.conv), { clientMsgId: uuid(), body: "x" })).status).toBe(404);
    expect(unifiedSends()).toHaveLength(2);
  });

  it("without a usable token or after the account needs reconnecting, nothing is sent", async () => {
    const s = await conv();
    graph.calls.length = 0;
    await q("DELETE FROM integration_secrets WHERE integration_account_id=$1", [s.accId]);
    expect((await (await call(owner, "POST", SEND(ws, s.conv), { clientMsgId: uuid(), body: "hi" })).json()).message).toMatchObject({ deliveryState: "failed", failureCode: "token_unavailable" });
    await q("UPDATE integration_accounts SET status='reauth_required' WHERE id=$1", [s.accId]);
    expect((await call(owner, "POST", SEND(ws, s.conv), { clientMsgId: uuid(), body: "hi" })).status).toBe(409);
    expect(unifiedSends()).toHaveLength(0);
  });

  it("enriches the sender's profile with the stored token on the Instagram profile fields", async () => {
    const s = await conv();
    const g = createMockGraph({ profiles: new Map<string, UserProfile>([[s.igsid, { name: "Rafi Ahmed", picUrl: "https://scontent.cdninstagram.com/v/r.jpg" }]]) });
    await createProfileEnricher({ workerDb, graph: g, box, budget: 500 })();
    expect(g.calls).toContain(`profile:${s.igsid}`);
    expect((await q("SELECT ct.name, pi.profile_status FROM platform_identities pi JOIN contacts ct ON ct.id=pi.contact_id WHERE pi.integration_account_id=$1", [s.accId]))[0]).toEqual({ name: "Rafi Ahmed", profile_status: "ok" });
  });

  it("Page-based Instagram sends still use me/messages (regression)", async () => {
    const ref = digits();
    const [acc] = await q("INSERT INTO integration_accounts (workspace_id, platform, external_account_id, status) VALUES ($1,'instagram',$2,'connected') RETURNING id", [ws, ref]);
    const sealed = box.seal("page-token", `${ws}:${acc.id}`);
    await q("INSERT INTO integration_secrets (workspace_id, integration_account_id, version, ciphertext, nonce, key_id) VALUES ($1,$2,1,$3,$4,$5)", [ws, acc.id, sealed.ciphertext, sealed.nonce, sealed.keyId]);
    const igsid = digits();
    await post(buildMessagePayload({ object: "instagram", accountId: ref, userId: igsid, mid: `pg.${RUN}.1`, text: "hi", timestampMs: Date.now() }));
    await drain(ref);
    const [c] = await q("SELECT id FROM conversations WHERE integration_account_id=$1", [acc.id]);
    graph.calls.length = 0;
    expect((await call(owner, "POST", SEND(ws, c.id), { clientMsgId: uuid(), body: "page based" })).status).toBe(201);
    expect(graph.calls.filter((x) => x.startsWith("sendig:"))).toHaveLength(1);
    expect(unifiedSends()).toHaveLength(0);
  });
});

describe("database rules", () => {
  it("only Instagram accounts can use the direct method; the application role cannot change the method", async () => {
    const [m] = await q("INSERT INTO integration_accounts (workspace_id, platform, external_account_id) VALUES ($1,'messenger',$2) RETURNING id", [ws, digits()]);
    await expect(q("UPDATE integration_accounts SET auth_method='unified' WHERE id=$1", [m.id])).rejects.toThrow(/integration_accounts_auth_method_platform/);
    await expect(q("UPDATE integration_accounts SET auth_method='bogus' WHERE id=$1", [m.id])).rejects.toThrow(/integration_accounts_auth_method/);
    const app = new pg.Client({ connectionString: process.env.DATABASE_URL_APP ?? `postgres://crm_app:app_dev@127.0.0.1:5436/${DB}` });
    await app.connect();
    try {
      await app.query("BEGIN");
      await app.query("SELECT set_config('app.workspace_id', $1, true), set_config('app.user_id', $2, true), set_config('app.role', 'owner', true)", [ws, owner.id]);
      await expect(app.query("UPDATE integration_accounts SET auth_method='unified' WHERE id=$1", [m.id])).rejects.toThrow(/permission denied/);
    } finally { await app.query("ROLLBACK").catch(() => undefined); await app.end(); }
    expect((await q("SELECT auth_method FROM integration_accounts WHERE id=$1", [m.id]))[0].auth_method).toBe("facebook");
  });
});
