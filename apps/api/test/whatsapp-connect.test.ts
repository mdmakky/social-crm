import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import { Hono } from "hono";
import { createDb, type Db } from "@crm/db";
import { buildWhatsAppBody, buildWhatsAppChange, createMockGraph, createSecretBox, mockSecret, signedFixture, waText } from "@crm/integrations";
import type { MetaConnectDeps } from "../src/inbox/meta-connect.ts";
import { processWebhookEvent } from "../src/inbox/process.ts";
import { metaWebhookRoutes } from "../src/inbox/webhook.ts";
import { bootstrap, type Harness, type TestUser } from "./harness.ts";

// WhatsApp slice 2: manual connection with a system user token. The Graph port is the in-memory mock: these tests prove OUR handling (validation, sealing, tenancy, subscription, replay), not Meta's behaviour.
const DB = process.env.CRM_DB_NAME ?? "crm";
const box = createSecretBox({ k1: Buffer.alloc(32, 7).toString("base64") }, "k1");
let h: Harness, workerDb: Db, ingestDb: Db, hook: Hono, graph: ReturnType<typeof createMockGraph>, deps: MetaConnectDeps;
let owner: TestUser, agent: TestUser, viewer: TestUser, other: TestUser;
let ws: string, wsOther: string;
const ids: string[] = [];
let openTx = 0;
const violations: string[] = [];
const digits = () => `6${Math.floor(Math.random() * 1e13).toString().padStart(13, "0")}`;
const q = async (text: string, params: unknown[] = []) => (await h.admin.query(text, params)).rows;
const call = (u: TestUser, method: string, path: string, body?: unknown) =>
  h.app.request(path, { method, headers: { cookie: u.cookie, origin: "http://localhost:3000", ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
const WA = (w: string) => `/v1/workspaces/${w}/integrations/whatsapp`;
const MW = (w: string) => `/v1/workspaces/${w}/integrations/meta`;
const TOKEN = "EAAG" + "x".repeat(60);
const number = (verifiedName: string | null = "Acme Support") => ({ id: digits(), displayPhoneNumber: "+1 555 010 1234", verifiedName });
/** Registers a WABA with the mock graph. */
function waba(numbers = [number()], token = TOKEN) {
  const id = digits();
  graph.state.whatsapp!.wabas.set(id, { token, numbers });
  return { id, numbers };
}
const accountRow = async (phone: string) => (await q("SELECT * FROM integration_accounts WHERE platform='whatsapp' AND external_account_id=$1", [phone]))[0];
const connect = (u: TestUser, w: string, o: { wabaId: string; phoneNumberId: string; accessToken?: string }) => call(u, "POST", `${WA(w)}/connect`, { accessToken: TOKEN, ...o });

beforeAll(async () => {
  workerDb = createDb(`postgres://crm_worker:worker_dev@127.0.0.1:5436/${DB}`);
  ingestDb = createDb(`postgres://crm_ingest:ingest_dev@127.0.0.1:5436/${DB}`);
  hook = new Hono().route("/webhooks/meta", metaWebhookRoutes({ appSecrets: [mockSecret], verifyToken: "v", ingestDb }));
  graph = createMockGraph({ pages: [], whatsapp: { wabas: new Map() } });
  deps = {
    graph, box, workerDb, appId: "123456", configId: "654321", graphVersion: "v25.0", redirectUri: "http://localhost:3000/v1/integrations/meta/callback", webOrigin: "http://localhost:3000",
    stateKey: createHmac("sha256", "k").update("s").digest(), userHashKey: createHmac("sha256", "k").update("u").digest(), mock: true, secureCookies: false,
  };
  // Instrumentation: count open worker transactions and flag every Graph call made while one is open (a held transaction keeps a pooled connection and possibly row locks for the whole network wait).
  deps.workerDb = new Proxy(workerDb, { get: (t, k) => (k === "transaction" ? (fn: (tx: unknown) => Promise<unknown>, ...rest: unknown[]) => (t as unknown as { transaction: (...a: unknown[]) => Promise<unknown> }).transaction(async (tx: unknown) => { openTx++; try { return await fn(tx); } finally { openTx--; } }, ...rest) : Reflect.get(t, k, t)) });
  for (const k of Object.keys(graph) as (keyof typeof graph)[]) {
    const f = graph[k];
    if (typeof f === "function") (graph as unknown as Record<string, unknown>)[k as string] = (...a: unknown[]) => { if (openTx > 0) violations.push(String(k)); return (f as (...x: unknown[]) => unknown)(...a); };
  }
  h = await bootstrap({ waLimits: { lookupsPerUser: 1000, connectsPerUser: 1000 } }, deps); // the rate limit has its own tests below
  [owner, agent, viewer, other] = (await Promise.all(["wcowner", "wcagent", "wcviewer", "wcother"].map((l) => h.newUser(l)))) as TestUser[] as [TestUser, TestUser, TestUser, TestUser];
  ws = await h.workspace(owner, "WAC A", { agent, viewer });
  wsOther = await h.workspace(other, "WAC B");
});
afterAll(async () => {
  if (ids.length) await q("UPDATE integration_accounts SET last_token_check_at = now(), status = 'disabled' WHERE external_account_id = ANY($1::text[]) AND platform = 'whatsapp'", [ids]);
  await workerDb.$client.end();
  await ingestDb.$client.end();
  await h.close();
});

describe("permissions", () => {
  it("only owners and admins can look up or connect; the token is validated before anything else", async () => {
    const w = waba();
    for (const u of [agent, viewer]) {
      expect((await call(u, "POST", `${WA(ws)}/numbers`, { wabaId: w.id, accessToken: TOKEN })).status).toBe(403);
      expect((await connect(u, ws, { wabaId: w.id, phoneNumberId: w.numbers[0]!.id })).status).toBe(403);
    }
    expect((await call(owner, "POST", `${WA(ws)}/numbers`, { wabaId: "abc", accessToken: "short" })).status).toBe(400);
    expect(graph.calls.some((c) => c === `wanumbers:${w.id}`)).toBe(false);
  });
});

describe("lookup", () => {
  it("lists the numbers of the account, marks the connected ones, and never echoes the token", async () => {
    const w = waba([number(), number(null)]);
    ids.push(...w.numbers.map((n) => n.id));
    const res = await call(owner, "POST", `${WA(ws)}/numbers`, { wabaId: w.id, accessToken: TOKEN });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain(TOKEN);
    expect(JSON.parse(text).numbers.map((n: { phoneNumberId: string; connected: boolean }) => [n.phoneNumberId, n.connected])).toEqual(w.numbers.map((n) => [n.id, false]));
    expect((await connect(owner, ws, { wabaId: w.id, phoneNumberId: w.numbers[0]!.id })).status).toBe(200);
    const again = (await (await call(owner, "POST", `${WA(ws)}/numbers`, { wabaId: w.id, accessToken: TOKEN })).json()).numbers;
    expect(again.map((n: { connected: boolean }) => n.connected)).toEqual([true, false]);
  });

  it("answers a rejected token and an unreachable account with plain codes, not Graph details", async () => {
    const w = waba();
    const bad = await call(owner, "POST", `${WA(ws)}/numbers`, { wabaId: w.id, accessToken: "EAAG" + "y".repeat(60) });
    expect([bad.status, (await bad.json()).error.code]).toEqual([422, "token_invalid"]);
    const unknown = await call(owner, "POST", `${WA(ws)}/numbers`, { wabaId: digits(), accessToken: TOKEN });
    expect([unknown.status, (await unknown.json()).error.code]).toEqual([422, "waba_not_accessible"]);
  });
});

describe("connect", () => {
  it("stores the account, the WABA side row and the sealed token, subscribes the WABA, and records history and audit without the token", async () => {
    const w = waba();
    const n = w.numbers[0]!;
    ids.push(n.id);
    graph.calls.length = 0;
    const res = await connect(owner, ws, { wabaId: w.id, phoneNumberId: n.id });
    expect(res.status).toBe(200);
    const raw = await res.text();
    expect(raw).not.toContain(TOKEN);
    const out = JSON.parse(raw);
    expect(out).toMatchObject({ subscription: "subscribed", reconnected: false, replayedEvents: 0, account: { platform: "whatsapp", externalAccountId: n.id, displayName: "Acme Support", status: "connected" } });
    expect(graph.calls).toEqual(expect.arrayContaining(["debugToken", `wanumbers:${w.id}`, `subscribewaba:${w.id}`]));

    const a = await accountRow(n.id);
    expect(a.workspace_id).toBe(ws);
    const [side] = await q("SELECT waba_id, display_phone_number, mode FROM whatsapp_accounts WHERE integration_account_id=$1", [a.id]);
    expect(side).toEqual({ waba_id: w.id, display_phone_number: "+1 555 010 1234", mode: "cloud_api" });
    const [sec] = await q("SELECT ciphertext, nonce, key_id FROM integration_secrets WHERE integration_account_id=$1", [a.id]);
    expect(Buffer.from(sec.ciphertext).includes(Buffer.from(TOKEN))).toBe(false);
    expect(box.open({ ciphertext: sec.ciphertext, nonce: sec.nonce, keyId: sec.key_id }, `${ws}:${a.id}`)).toBe(TOKEN);
    const ev = await q("SELECT kind, data::text AS d FROM integration_events WHERE integration_account_id=$1 ORDER BY created_at", [a.id]);
    expect(ev.map((e) => e.kind)).toEqual(["connected", "status_changed"]);
    expect(ev.map((e) => e.d).join()).not.toContain(TOKEN);
    const audit = await q("SELECT action, summary::text AS s FROM audit_log WHERE entity_id=$1", [a.id]);
    expect(audit.map((r) => r.action)).toEqual(["integration.whatsapp.connected"]);
    expect(audit.map((r) => r.s).join()).not.toContain(TOKEN);
  });

  it("uses the display phone number as the name when the number has no verified name, and a reconnect keeps one account and one secret version", async () => {
    const w = waba([number(null)]);
    const n = w.numbers[0]!;
    ids.push(n.id);
    expect((await (await connect(owner, ws, { wabaId: w.id, phoneNumberId: n.id })).json()).account.displayName).toBe("+1 555 010 1234");
    const second = await (await connect(owner, ws, { wabaId: w.id, phoneNumberId: n.id })).json();
    expect(second.reconnected).toBe(true);
    const a = await accountRow(n.id);
    expect((await q("SELECT count(*)::int AS c FROM integration_secrets WHERE integration_account_id=$1", [a.id]))[0].c).toBe(1);
    expect((await q("SELECT count(*)::int AS c FROM whatsapp_accounts WHERE integration_account_id=$1", [a.id]))[0].c).toBe(1);
  });

  it("refuses without storing anything: invalid token, missing permission, a number that is not in this account", async () => {
    const w = waba();
    const n = w.numbers[0]!;
    ids.push(n.id);
    graph.state.tokenInfo = new Map([[TOKEN, { isValid: false, expiresAt: null, scopes: [], errorCode: 190 }]]);
    let res = await connect(owner, ws, { wabaId: w.id, phoneNumberId: n.id });
    expect([res.status, (await res.json()).error.code]).toEqual([422, "token_invalid"]);
    graph.state.tokenInfo = new Map([[TOKEN, { isValid: true, expiresAt: null, scopes: ["whatsapp_business_messaging"], errorCode: null }]]);
    res = await connect(owner, ws, { wabaId: w.id, phoneNumberId: n.id });
    expect([res.status, (await res.json()).error.code]).toEqual([422, "permission_missing"]);
    graph.state.tokenInfo = undefined;
    res = await connect(owner, ws, { wabaId: w.id, phoneNumberId: digits() });
    expect([res.status, (await res.json()).error.code]).toEqual([422, "number_not_found"]);
    expect(await accountRow(n.id)).toBeUndefined();
  });

  it("keeps the connection when the webhook subscription fails and says so; Re-check subscription then repairs it", async () => {
    const w = waba();
    const n = w.numbers[0]!;
    ids.push(n.id);
    graph.state.whatsapp!.failSubscribeWaba = true;
    const out = await (await connect(owner, ws, { wabaId: w.id, phoneNumberId: n.id })).json();
    graph.state.whatsapp!.failSubscribeWaba = false;
    expect([out.subscription, out.account.status]).toEqual(["failed", "connected"]);
    graph.calls.length = 0;
    expect((await (await call(owner, "POST", `${MW(ws)}/accounts/${out.account.id}/resubscribe`)).json()).subscription).toBe("subscribed");
    expect(graph.calls).toContain(`subscribewaba:${w.id}`);
    expect((await (await call(owner, "POST", `${MW(ws)}/accounts/${out.account.id}/check-token`)).json()).status).toBe("connected");
  });

  it("does not let a second workspace take over a number that is connected elsewhere", async () => {
    const w = waba();
    const n = w.numbers[0]!;
    ids.push(n.id);
    expect((await connect(owner, ws, { wabaId: w.id, phoneNumberId: n.id })).status).toBe(200);
    const res = await connect(other, wsOther, { wabaId: w.id, phoneNumberId: n.id });
    expect([res.status, (await res.json()).error.code]).toEqual([409, "account_unavailable"]);
    expect((await accountRow(n.id)).workspace_id).toBe(ws);
    expect((await q("SELECT count(*)::int AS c FROM integration_secrets s JOIN integration_accounts i ON i.id = s.integration_account_id WHERE i.external_account_id=$1", [n.id]))[0].c).toBe(1);
    // the other workspace sees none of it
    expect((await (await call(other, "GET", MW(wsOther))).json()).accounts.filter((a: { externalAccountId: string }) => a.externalAccountId === n.id)).toEqual([]);
  });
});

describe("disconnect", () => {
  it("deletes the token and disables the account but never unsubscribes the WABA, which another workspace may share", async () => {
    const w = waba([number(), number()]);
    ids.push(...w.numbers.map((n) => n.id));
    const a = (await (await connect(owner, ws, { wabaId: w.id, phoneNumberId: w.numbers[0]!.id })).json()).account;
    const b = (await (await connect(other, wsOther, { wabaId: w.id, phoneNumberId: w.numbers[1]!.id })).json()).account; // same WABA, other workspace
    graph.calls.length = 0;
    expect((await call(owner, "POST", `${MW(ws)}/accounts/${a.id}/disconnect`)).status).toBe(200);
    expect(graph.calls.some((c) => c.startsWith("unsubscribe"))).toBe(false);
    expect((await q("SELECT count(*)::int AS c FROM integration_secrets WHERE integration_account_id=$1", [a.id]))[0].c).toBe(0);
    expect((await accountRow(w.numbers[0]!.id)).status).toBe("disabled");
    expect((await accountRow(w.numbers[1]!.id)).status).toBe("connected");
    expect((await q("SELECT count(*)::int AS c FROM integration_secrets WHERE integration_account_id=$1", [b.id]))[0].c).toBe(1);
  });
});

describe("guards", () => {
  it("rejects a token issued to a different app", async () => {
    const w = waba();
    ids.push(w.numbers[0]!.id);
    graph.state.tokenInfo = new Map([[TOKEN, { appId: "999", isValid: true, expiresAt: null, scopes: [], errorCode: null }]]);
    const res = await connect(owner, ws, { wabaId: w.id, phoneNumberId: w.numbers[0]!.id });
    graph.state.tokenInfo = undefined;
    expect([res.status, (await res.json()).error.code]).toEqual([422, "token_invalid"]);
    expect(await accountRow(w.numbers[0]!.id)).toBeUndefined();
  });

  it("refuses to reconnect a number under a different WABA id and keeps the stored one", async () => {
    const w = waba();
    const n = w.numbers[0]!;
    ids.push(n.id);
    expect((await connect(owner, ws, { wabaId: w.id, phoneNumberId: n.id })).status).toBe(200);
    const w2 = waba([n]); // the mock now also lists the same number under another WABA
    const res = await connect(owner, ws, { wabaId: w2.id, phoneNumberId: n.id });
    expect([res.status, (await res.json()).error.code]).toEqual([409, "waba_mismatch"]);
    expect((await q("SELECT waba_id FROM whatsapp_accounts w JOIN integration_accounts i ON i.id=w.integration_account_id WHERE i.external_account_id=$1", [n.id]))[0].waba_id).toBe(w.id);
  });
});

describe("events that arrived before the number was connected", () => {
  it("are stored as orphans, queued again on connect, and then create the conversation", async () => {
    const w = waba();
    const n = w.numbers[0]!;
    ids.push(n.id);
    const from = digits();
    const f = signedFixture(buildWhatsAppBody(digits(), [buildWhatsAppChange({ phoneNumberId: n.id, messages: [waText(from, `wamid.rp.${digits()}`, "hello before connect")], contacts: [{ profile: { name: "Zed" }, wa_id: from }] })]), mockSecret);
    const post = await hook.request("/webhooks/meta/whatsapp", { method: "POST", body: new Uint8Array(f.raw), headers: { "content-type": "application/json", "x-hub-signature-256": f.signature } });
    expect(post.status).toBe(200);
    const pending = async () => q("SELECT id, status FROM webhook_events WHERE platform='whatsapp' AND account_ref=$1", [n.id]);
    for (const e of await pending()) await processWebhookEvent(workerDb, e.id as string);
    expect((await pending()).map((e) => e.status)).toEqual(["orphan"]);

    const out = await (await connect(owner, ws, { wabaId: w.id, phoneNumberId: n.id })).json();
    expect(out.replayedEvents).toBe(1);
    for (let i = 0; i < 50 && (await pending()).some((e) => e.status !== "processed"); i++) {
      for (const e of await pending()) if (e.status !== "processed") await processWebhookEvent(workerDb, e.id as string);
      await new Promise((r) => setTimeout(r, 50));
    }
    expect((await pending()).map((e) => e.status)).toEqual(["processed"]);
    const msgs = await q("SELECT m.body FROM messages m JOIN conversations c ON c.id=m.conversation_id WHERE c.integration_account_id=$1", [out.account.id]);
    expect(msgs.map((m) => m.body)).toEqual(["hello before connect"]);
  });
});

describe("rate limit", () => {
  it("stops bulk token or WABA probing per user, answers 429 with Retry-After, and does not call Meta once limited", async () => {
    const small = await bootstrap({ waLimits: { lookupsPerUser: 2, connectsPerUser: 1, windowMs: 60_000 } }, deps);
    try {
      const u = (await small.newUser("wcrate")) as TestUser;
      const w2 = await small.workspace(u, "WAC Rate");
      const w = waba();
      const post = (path: string, body: unknown) => small.app.request(`/v1/workspaces/${w2}/integrations/whatsapp/${path}`, { method: "POST", headers: { cookie: u.cookie, origin: "http://localhost:3000", "content-type": "application/json" }, body: JSON.stringify(body) });
      const look = { wabaId: w.id, accessToken: TOKEN };
      expect([(await post("numbers", look)).status, (await post("numbers", look)).status]).toEqual([200, 200]);
      const before = graph.calls.length;
      const third = await post("numbers", look);
      expect([third.status, (await third.json()).error.code, third.headers.get("retry-after")]).toEqual([429, "rate_limited", "60"]);
      expect(graph.calls.length).toBe(before);
      const c1 = await post("connect", { ...look, phoneNumberId: "0" });
      expect(c1.status).toBe(400); // spent the single connect attempt (invalid id)
      expect((await post("connect", { ...look, phoneNumberId: w.numbers[0]!.id })).status).toBe(429);
      // other users are not affected by this user's budget
      expect((await call(owner, "POST", `${WA(ws)}/numbers`, look)).status).toBe(200);
    } finally {
      await small.close();
    }
  });
});

describe("token without an app id", () => {
  it("is refused outside the mock (fail closed) and nothing is stored", async () => {
    const w = waba();
    const n = w.numbers[0]!;
    deps.mock = false;
    try {
      const res = await connect(owner, ws, { wabaId: w.id, phoneNumberId: n.id });
      expect([res.status, (await res.json()).error.code]).toEqual([422, "token_invalid"]);
    } finally {
      deps.mock = true;
    }
    expect(await accountRow(n.id)).toBeUndefined();
  });
});

describe("transactions and races around Graph calls", () => {
  it("no Graph call runs while a database transaction is open (connect, check-token, re-subscribe, disconnect)", async () => {
    violations.length = 0;
    const w = waba();
    const n = w.numbers[0]!;
    ids.push(n.id);
    const out = await (await connect(owner, ws, { wabaId: w.id, phoneNumberId: n.id })).json();
    const id = out.account.id as string;
    expect((await call(owner, "POST", `${MW(ws)}/accounts/${id}/check-token`)).status).toBe(200);
    expect((await call(owner, "POST", `${MW(ws)}/accounts/${id}/resubscribe`)).status).toBe(200);
    expect((await call(owner, "POST", `${MW(ws)}/accounts/${id}/disconnect`)).status).toBe(200);
    expect(graph.calls.length).toBeGreaterThan(0);
    expect(violations).toEqual([]);
  });

  it("a token check that answers after a reconnect is dropped: the fresh connection is not marked reauth_required", async () => {
    const w = waba();
    const n = w.numbers[0]!;
    ids.push(n.id);
    const out = await (await connect(owner, ws, { wabaId: w.id, phoneNumberId: n.id })).json();
    const id = out.account.id as string;
    const NEW = "EAAG" + "y".repeat(60);
    const realDebug = graph.debugToken;
    let reentered = false;
    graph.state.tokenInfo = new Map([[TOKEN, { isValid: false, expiresAt: null, scopes: [], errorCode: 190, appId: null }]]);
    graph.debugToken = async (token: string) => {
      if (token === TOKEN && !reentered) {
        reentered = true; // the owner reconnects with a new token while Meta is still answering the old check
        graph.state.whatsapp!.wabas.get(w.id)!.token = NEW;
        expect((await connect(owner, ws, { wabaId: w.id, phoneNumberId: n.id, accessToken: NEW })).status).toBe(200);
      }
      return realDebug(token);
    };
    try {
      expect((await call(owner, "POST", `${MW(ws)}/accounts/${id}/check-token`)).status).toBe(200);
    } finally {
      graph.debugToken = realDebug;
      graph.state.tokenInfo = undefined;
    }
    expect((await q("SELECT status FROM integration_accounts WHERE id=$1", [id]))[0].status).toBe("connected");
    expect(await q("SELECT 1 FROM integration_events WHERE integration_account_id=$1 AND kind='status_changed' AND data->>'reason'='token_invalid'", [id])).toHaveLength(0);
  });
});

describe("number held by another workspace", () => {
  it("is flagged unavailable in the lookup of the other workspace (advisory), never leaks who holds it, and connect still answers 409", async () => {
    const w = waba();
    const n = w.numbers[0]!;
    ids.push(n.id);
    expect((await connect(owner, ws, { wabaId: w.id, phoneNumberId: n.id })).status).toBe(200);
    const mine = await (await call(owner, "POST", `${WA(ws)}/numbers`, { wabaId: w.id, accessToken: TOKEN })).json();
    expect(mine.numbers[0]).toMatchObject({ connected: true, unavailable: false });
    const res = await call(other, "POST", `${WA(wsOther)}/numbers`, { wabaId: w.id, accessToken: TOKEN });
    const text = await res.text();
    expect(JSON.parse(text).numbers[0]).toMatchObject({ phoneNumberId: n.id, connected: false, unavailable: true });
    expect(text).not.toContain(ws); // no workspace identity
    const refused = await connect(other, wsOther, { wabaId: w.id, phoneNumberId: n.id });
    const body = await refused.json();
    expect([refused.status, body.error.code]).toEqual([409, "account_unavailable"]);
    expect(body.error.message).toContain("another workspace");
    // a disconnected number stays reserved, so it stays unavailable to others
    const id = (await accountRow(n.id)).id as string;
    expect((await call(owner, "POST", `${MW(ws)}/accounts/${id}/disconnect`)).status).toBe(200);
    expect((await (await call(other, "POST", `${WA(wsOther)}/numbers`, { wabaId: w.id, accessToken: TOKEN })).json()).numbers[0].unavailable).toBe(true);
  });
});
