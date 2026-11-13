import { createHmac } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { endpoints } from "@crm/contracts";
import { createDb, type Db } from "@crm/db";
import { createMockGraph, createSecretBox, GraphError, type GraphPage } from "@crm/integrations";
import { hashMetaUser } from "../src/inbox/meta-connect.ts";
import type { MetaConnectDeps } from "../src/inbox/meta-connect.ts";
import { bootstrap, type Harness, type TestUser } from "./harness.ts";

const DB = process.env.CRM_DB_NAME ?? "crm";
const KEY = Buffer.alloc(32, 7).toString("base64");
const box = createSecretBox({ dev1: KEY }, "dev1");
const digits = () => `8${Math.floor(Math.random() * 1e13).toString().padStart(13, "0")}`;

let h: Harness;
let workerDb: Db;
let graph: ReturnType<typeof createMockGraph>;
let clock = Date.now();
let deps: MetaConnectDeps;
let hUnconfigured: Harness;
let owner: TestUser, admin: TestUser, agent: TestUser, viewer: TestUser, other: TestUser;
let ws: string, wsOther: string;
const page = (over: Partial<GraphPage> = {}): GraphPage => ({ id: digits(), name: "Test Page", accessToken: `page-token-${digits()}`, tasks: ["MANAGE", "MESSAGING"], instagramAccountId: null, ...over });

const WP = (w: string) => `/v1/workspaces/${w}/integrations/meta`;
const q = async (text: string, params: unknown[] = []) => (await h.admin.query(text, params)).rows;
const cookiesOf = (res: Response) => Object.fromEntries(res.headers.getSetCookie().map((c) => c.split(";")[0]!.split("=") as [string, string]));
const jar = (u: TestUser, extra: Record<string, string> = {}) => [u.cookie, ...Object.entries(extra).map(([k, v]) => `${k}=${v}`)].join("; ");
const call = (u: TestUser, method: string, path: string, opts: { body?: unknown; cookies?: Record<string, string> } = {}) =>
  h.app.request(path, { method, headers: { cookie: jar(u, opts.cookies), origin: "http://localhost:3000", ...(opts.body ? { "content-type": "application/json" } : {}) }, body: opts.body ? JSON.stringify(opts.body) : undefined });

/** Runs start + the mock dialog + callback for user u in workspace w; returns the pending cookie. */
async function login(u: TestUser, w: string, pages: GraphPage[]) {
  graph.state.pages = pages;
  const start = await call(u, "POST", `${WP(w)}/connect/start`);
  expect(start.status).toBe(200);
  const nonce = cookiesOf(start).crm_meta_nonce!;
  const { authUrl } = await start.json();
  const cb = new URL(authUrl);
  const res = await call(u, "GET", `${cb.pathname}${cb.search}`, { cookies: { crm_meta_nonce: nonce } });
  return { res, nonce, authUrl: cb, pending: cookiesOf(res).crm_meta_pending };
}
async function connect(u: TestUser, w: string, p: GraphPage, withIg = false) {
  const { res, pending } = await login(u, w, [p]);
  expect(res.headers.get("location")).toContain(`/w/${w}/settings/integrations?meta=select`);
  return call(u, "POST", `${WP(w)}/connect`, { body: { pageId: p.id, connectInstagram: withIg }, cookies: { crm_meta_pending: pending! } });
}

beforeAll(async () => {
  workerDb = createDb(`postgres://crm_worker:worker_dev@127.0.0.1:5436/${DB}`);
  graph = createMockGraph({ pages: [] });
  deps = {
    graph, box, workerDb, appId: "123456", configId: "654321", graphVersion: "v25.0", redirectUri: "http://localhost:3000/v1/integrations/meta/callback", webOrigin: "http://localhost:3000",
    stateKey: createHmac("sha256", "test-app-secret").update("crm-oauth-state-v1").digest(), userHashKey: createHmac("sha256", "test-user-hash-key").update("crm-meta-user-v1").digest(), mock: true, secureCookies: false, now: () => clock,
  };
  h = await bootstrap(undefined, deps);
  hUnconfigured = await bootstrap();
  [owner, admin, agent, viewer, other] = (await Promise.all(["mowner", "madmin", "magent", "mviewer", "mother"].map((l) => h.newUser(l)))) as TestUser[] as [TestUser, TestUser, TestUser, TestUser, TestUser];
  ws = await h.workspace(owner, "Meta A", { admin, agent, viewer });
  wsOther = await h.workspace(other, "Meta B");
});
afterAll(async () => {
  await workerDb.$client.end();
  await hUnconfigured.close();
  await h.close();
});

describe("configuration and permissions", () => {
  it("reports unconfigured and answers 503 on connect when Meta is not configured", async () => {
    const u = await hUnconfigured.newUser("munconf");
    const w = await hUnconfigured.workspace(u, "Unconfigured");
    const state = await hUnconfigured.app.request(`${WP(w)}`, { headers: { cookie: u.cookie } });
    expect(await state.json()).toMatchObject({ configured: false, accounts: [] });
    const start = await hUnconfigured.app.request(`${WP(w)}/connect/start`, { method: "POST", headers: { cookie: u.cookie, origin: "http://localhost:3000" } });
    expect(start.status).toBe(503);
    expect((await start.json()).error.code).toBe("integration_not_configured");
  });

  it("only owner and admin manage; agent may view; viewer and outsiders get nothing", async () => {
    expect((await call(owner, "POST", `${WP(ws)}/connect/start`)).status).toBe(200);
    expect((await call(admin, "POST", `${WP(ws)}/connect/start`)).status).toBe(200);
    expect((await call(agent, "POST", `${WP(ws)}/connect/start`)).status).toBe(403);
    expect((await call(viewer, "POST", `${WP(ws)}/connect/start`)).status).toBe(403);
    expect((await call(agent, "GET", WP(ws))).status).toBe(200);
    expect((await call(viewer, "GET", WP(ws))).status).toBe(403);
    expect((await call(other, "GET", WP(ws))).status).toBe(404); // non-members do not learn the workspace exists
    expect((await call(agent, "GET", `${WP(ws)}/pending`)).status).toBe(403);
  });
});

describe("OAuth flow (mock Graph)", () => {
  it("connects a Page and its Instagram account, encrypts the token, records events and audit, and subscribes Messenger only", async () => {
    const p = page({ instagramAccountId: digits() });
    const res = await connect(owner, ws, p, true);
    expect(res.status).toBe(200);
    const { accounts } = await res.json();
    expect(accounts.map((a: { account: { platform: string }; subscription: string }) => [a.account.platform, a.subscription])).toEqual([["messenger", "subscribed"], ["instagram", "dashboard_required"]]);
    expect(graph.calls).toContain(`subscribe:${p.id}`);
    expect(graph.calls.some((c) => c === `subscribe:${p.instagramAccountId}`)).toBe(false);

    const secrets = await q("SELECT s.ciphertext, s.nonce, s.key_id, s.version, a.platform FROM integration_secrets s JOIN integration_accounts a ON a.id = s.integration_account_id WHERE a.external_account_id = ANY($1) ORDER BY a.platform", [[p.id, p.instagramAccountId]]);
    expect(secrets).toHaveLength(2);
    for (const s of secrets) {
      expect(Buffer.from(s.ciphertext).toString("utf8")).not.toContain(p.accessToken); // not stored in clear
      expect(s.key_id).toBe("dev1");
      expect(s.version).toBe(1);
    }
    const acc = (await q("SELECT id, workspace_id FROM integration_accounts WHERE platform='messenger' AND external_account_id=$1", [p.id]))[0];
    expect(acc.workspace_id).toBe(ws);
    const sealed = (await q("SELECT ciphertext, nonce, key_id FROM integration_secrets WHERE integration_account_id=$1", [acc.id]))[0];
    expect(box.open({ ciphertext: sealed.ciphertext, nonce: sealed.nonce, keyId: sealed.key_id }, `${ws}:${acc.id}`)).toBe(p.accessToken);
    expect(() => box.open({ ciphertext: sealed.ciphertext, nonce: sealed.nonce, keyId: sealed.key_id }, `${wsOther}:${acc.id}`)).toThrow(); // bound to workspace and account

    const kinds = (await q("SELECT kind FROM integration_events WHERE integration_account_id=$1 ORDER BY id", [acc.id])).map((r) => r.kind);
    expect(kinds).toEqual(["connected", "status_changed"]);
    const audit = await q("SELECT action FROM audit_log WHERE workspace_id=$1 AND entity_id=$2", [ws, acc.id]);
    expect(audit.map((r) => r.action)).toEqual(["integration.meta.connected"]);

    const list = await (await call(owner, "GET", WP(ws))).json();
    expect(list.configured).toBe(true);
    expect(list.mock).toBe(true);
    expect(JSON.stringify(list)).not.toContain(p.accessToken);
    expect(list.accounts.map((a: { externalAccountId: string }) => a.externalAccountId)).toContain(p.id);
  });

  it("the typed client contract matches the served routes", async () => {
    const r = await h.clientFor(owner).call(endpoints.getMetaIntegration, { params: { workspaceId: ws } });
    expect(r.ok).toBe(true);
  });

  it("lists discovered Pages without tokens and marks the connected one", async () => {
    const [a, b] = [page(), page()];
    const { pending } = await login(owner, ws, [a, b]);
    const res = await call(owner, "GET", `${WP(ws)}/pending`, { cookies: { crm_meta_pending: pending! } });
    const body = await res.json();
    expect(body.pages.map((p: { pageId: string }) => p.pageId)).toEqual([a.id, b.id]);
    expect(JSON.stringify(body)).not.toContain("page-token");
    expect((await call(owner, "GET", `${WP(ws)}/pending`)).status).toBe(404); // no cookie, no selection
  });

  it("denied or cancelled login and a failing code exchange redirect with a result and store nothing", async () => {
    const start = await call(owner, "POST", `${WP(ws)}/connect/start`);
    const nonce = cookiesOf(start).crm_meta_nonce!;
    const state = new URL((await start.json()).authUrl).searchParams.get("state")!;
    const denied = await call(owner, "GET", `/v1/integrations/meta/callback?error=access_denied&error_reason=user_denied&state=${encodeURIComponent(state)}`, { cookies: { crm_meta_nonce: nonce } });
    expect(denied.headers.get("location")).toContain("?meta=denied");
    const start2 = await call(owner, "POST", `${WP(ws)}/connect/start`);
    const n2 = cookiesOf(start2).crm_meta_nonce!;
    const s2 = new URL((await start2.json()).authUrl).searchParams.get("state")!;
    const bad = await call(owner, "GET", `/v1/integrations/meta/callback?code=bad-code&state=${encodeURIComponent(s2)}`, { cookies: { crm_meta_nonce: n2 } });
    expect(bad.headers.get("location")).toContain("?meta=error");
    expect(cookiesOf(bad).crm_meta_pending).toBeUndefined();
  });
});

describe("OAuth state and CSRF", () => {
  const cb = (u: TestUser, state: string, nonce: string | undefined) => call(u, "GET", `/v1/integrations/meta/callback?code=good-code&state=${encodeURIComponent(state)}`, { cookies: nonce ? { crm_meta_nonce: nonce } : {} });
  const fresh = async (u: TestUser, w: string) => {
    const s = await call(u, "POST", `${WP(w)}/connect/start`);
    return { nonce: cookiesOf(s).crm_meta_nonce!, state: new URL((await s.json()).authUrl).searchParams.get("state")! };
  };
  const invalid = (r: Response) => expect(r.headers.get("location")).toContain("?meta=invalid_state");

  it("rejects a callback without the browser's nonce cookie, with a wrong one, or with a tampered or foreign state", async () => {
    const { nonce, state } = await fresh(owner, ws);
    invalid(await cb(owner, state, undefined));
    invalid(await cb(owner, state, "x".repeat(nonce.length)));
    const [payload, sig] = state.split(".");
    invalid(await cb(owner, `${payload}.${sig!.slice(0, -2)}AA`, nonce));
    const forged = Buffer.from(JSON.stringify({ w: wsOther, u: owner.id, n: nonce, e: clock + 60_000 })).toString("base64url");
    invalid(await cb(owner, `${forged}.${sig}`, nonce));
    invalid(await cb(owner, "garbage", nonce));
    invalid(await cb(owner, "", nonce));
  });

  it("binds the state to the user who started it (login CSRF) and makes it single use", async () => {
    const a = await fresh(owner, ws);
    invalid(await cb(admin, a.state, a.nonce)); // another logged-in user presenting the victim's state and nonce
    const b = await fresh(owner, ws);
    expect((await cb(owner, b.state, b.nonce)).headers.get("location")).toContain("meta=select");
    // replay: the first successful callback cleared the cookie in the browser, so a replay carries no nonce
    invalid(await cb(owner, b.state, undefined));
  });

  it("expires after 10 minutes", async () => {
    const { nonce, state } = await fresh(owner, ws);
    clock += 11 * 60_000;
    invalid(await cb(owner, state, nonce));
    clock = Date.now();
  });

  it("requires a session and an active owner/admin membership at callback time", async () => {
    const { nonce, state } = await fresh(owner, ws);
    const anon = await h.app.request(`/v1/integrations/meta/callback?code=good-code&state=${encodeURIComponent(state)}`, { headers: { cookie: `crm_meta_nonce=${nonce}` } });
    expect(anon.status).toBe(401);
    const m = await fresh(admin, ws);
    await q("UPDATE memberships SET role='viewer' WHERE workspace_id=$1 AND user_id=$2", [ws, admin.id]); // demoted between start and callback
    const res = await cb(admin, m.state, m.nonce);
    await q("UPDATE memberships SET role='admin' WHERE workspace_id=$1 AND user_id=$2", [ws, admin.id]);
    expect(res.headers.get("location")).toContain("?meta=forbidden");
  });
});

describe("tenant isolation", () => {
  it("one Page belongs to one workspace: a second workspace gets a generic conflict and nothing changes", async () => {
    const p = page();
    expect((await connect(owner, ws, p)).status).toBe(200);
    const res = await connect(other, wsOther, p);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: { code: "account_unavailable", message: "This account can't be connected to this workspace." } });
    const rows = await q("SELECT workspace_id FROM integration_accounts WHERE platform='messenger' AND external_account_id=$1", [p.id]);
    expect(rows.map((r) => r.workspace_id)).toEqual([ws]);
    expect(await q("SELECT 1 FROM integration_secrets s JOIN integration_accounts a ON a.id=s.integration_account_id WHERE a.external_account_id=$1 AND s.workspace_id=$2", [p.id, wsOther])).toHaveLength(0);
  });

  it("a pending selection cannot be used by another user or another workspace, and other workspaces never see the account", async () => {
    const p = page();
    const { pending } = await login(owner, ws, [p]);
    const stolen = await call(other, "POST", `${WP(wsOther)}/connect`, { body: { pageId: p.id }, cookies: { crm_meta_pending: pending! } });
    expect(stolen.status).toBe(404);
    const wrongWs = await call(admin, "POST", `${WP(ws)}/connect`, { body: { pageId: p.id }, cookies: { crm_meta_pending: pending! } });
    expect(wrongWs.status).toBe(404); // admin is a different user than the one who logged in
    expect((await (await call(other, "GET", WP(wsOther))).json()).accounts).toEqual([]);
    expect((await call(other, "POST", `${WP(wsOther)}/accounts/${(await q("SELECT id FROM integration_accounts WHERE workspace_id=$1 LIMIT 1", [ws]))[0].id}/disconnect`)).status).toBe(404);
  });
});

describe("lifecycle: disconnect, reconnect, token health, subscription", () => {
  it("disconnect deletes the token, disables the account and unsubscribes; reconnect re-enables with one new token version", async () => {
    const p = page();
    const { accounts } = await (await connect(owner, ws, p)).json();
    const id = accounts[0].account.id as string;
    expect((await call(agent, "POST", `${WP(ws)}/accounts/${id}/disconnect`)).status).toBe(403);
    expect((await call(owner, "POST", `${WP(ws)}/accounts/${id}/disconnect`)).status).toBe(200);
    expect(graph.calls).toContain(`unsubscribe:${p.id}`);
    expect(await q("SELECT 1 FROM integration_secrets WHERE integration_account_id=$1", [id])).toHaveLength(0);
    expect((await q("SELECT status FROM integration_accounts WHERE id=$1", [id]))[0].status).toBe("disabled");

    const again = await (await connect(admin, ws, { ...p, accessToken: "page-token-new" })).json();
    expect(again.accounts[0]).toMatchObject({ reconnected: true, subscription: "subscribed" });
    expect(again.accounts[0].account).toMatchObject({ id, status: "connected" });
    const sec = await q("SELECT version FROM integration_secrets WHERE integration_account_id=$1", [id]);
    expect(sec).toHaveLength(1);
    expect(sec[0].version).toBe(1); // the old versions were deleted with the disconnect, so numbering restarts
    const kinds = (await q("SELECT kind FROM integration_events WHERE integration_account_id=$1 ORDER BY id", [id])).map((r) => r.kind);
    expect(kinds).toEqual(["connected", "status_changed", "disconnected", "reconnected", "status_changed"]);
  });

  it("reconnect without disconnect replaces the token (version 2) and keeps a single secret", async () => {
    const p = page();
    const id = (await (await connect(owner, ws, p)).json()).accounts[0].account.id as string;
    await connect(owner, ws, { ...p, accessToken: "page-token-rotated" });
    const sec = await q("SELECT version, ciphertext, nonce, key_id FROM integration_secrets WHERE integration_account_id=$1", [id]);
    expect(sec.map((s) => s.version)).toEqual([2]);
    expect(box.open({ ciphertext: sec[0].ciphertext, nonce: sec[0].nonce, keyId: sec[0].key_id }, `${ws}:${id}`)).toBe("page-token-rotated");
  });

  it("token check: valid keeps the account; invalid or revoked moves it to reauth_required; a Graph outage changes nothing", async () => {
    const p = page();
    const id = (await (await connect(owner, ws, p)).json()).accounts[0].account.id as string;
    const check = () => call(owner, "POST", `${WP(ws)}/accounts/${id}/check-token`);
    let r = await check();
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ status: "connected" });
    expect((await q("SELECT last_token_check_at FROM integration_accounts WHERE id=$1", [id]))[0].last_token_check_at).not.toBeNull();

    const orig = graph.debugToken;
    graph.debugToken = async () => { throw new GraphError(null, 0, "other"); };
    r = await check();
    expect(r.status).toBe(502);
    expect((await q("SELECT status FROM integration_accounts WHERE id=$1", [id]))[0].status).toBe("connected");

    graph.debugToken = async () => ({ isValid: false, expiresAt: null, scopes: [], errorCode: 190 });
    r = await check();
    expect((await r.json()).status).toBe("reauth_required");
    const ev = (await q("SELECT kind, data FROM integration_events WHERE integration_account_id=$1 AND kind='status_changed' ORDER BY id DESC LIMIT 1", [id]))[0];
    expect(ev.data).toMatchObject({ reason: "token_invalid", code: 190 });
    graph.debugToken = orig;
    expect(JSON.stringify(ev)).not.toContain(p.accessToken);
  });

  it("a failed subscription leaves the account connected, says so, and can be retried", async () => {
    graph.state.failSubscribe = true;
    const p = page();
    const res = await connect(owner, ws, p);
    graph.state.failSubscribe = false;
    const { accounts } = await res.json();
    expect(accounts[0]).toMatchObject({ subscription: "failed" });
    expect(accounts[0].account.status).toBe("connected");
    const retry = await call(owner, "POST", `${WP(ws)}/accounts/${accounts[0].account.id}/resubscribe`);
    expect(await retry.json()).toEqual({ subscription: "subscribed" });
  });

  it("the due-token job checks connected accounts that were never checked", async () => {
    const { runTokenChecks } = await import("../src/inbox/meta-connect.ts");
    const p = page();
    const id = (await (await connect(owner, ws, p)).json()).accounts[0].account.id as string;
    expect(await runTokenChecks(deps)).toBeGreaterThanOrEqual(1);
    expect((await q("SELECT last_token_check_at FROM integration_accounts WHERE id=$1", [id]))[0].last_token_check_at).not.toBeNull();
  });
});

describe("Page task validation and Meta user link", () => {
  it("refuses a Page where the person cannot send as the Page, before anything is created", async () => {
    const p = page({ tasks: ["ANALYZE", "ADVERTISE"] });
    const { pending } = await login(owner, ws, [p]);
    const list = await (await call(owner, "GET", `${WP(ws)}/pending`, { cookies: { crm_meta_pending: pending! } })).json();
    expect(list.pages[0]).toMatchObject({ pageId: p.id, eligible: false });
    expect(list.pages[0].ineligibleReason).toMatch(/cannot send messages/);
    const res = await call(owner, "POST", `${WP(ws)}/connect`, { body: { pageId: p.id }, cookies: { crm_meta_pending: pending! } });
    expect(res.status).toBe(422);
    expect((await res.json()).error.code).toBe("page_task_missing");
    expect(await q("SELECT 1 FROM integration_accounts WHERE external_account_id=$1", [p.id])).toHaveLength(0);
    expect(await q("SELECT 1 FROM integration_secrets s JOIN integration_accounts a ON a.id=s.integration_account_id WHERE a.external_account_id=$1", [p.id])).toHaveLength(0);
  });

  it("an empty task list is refused; a missing task field is allowed but recorded as unverified", async () => {
    const none = page({ tasks: [] });
    const { pending } = await login(owner, ws, [none]);
    expect((await call(owner, "POST", `${WP(ws)}/connect`, { body: { pageId: none.id }, cookies: { crm_meta_pending: pending! } })).status).toBe(422);
    const unknown = page({ tasks: null });
    const res = await connect(owner, ws, unknown);
    expect(res.status).toBe(200);
    const ev = await q("SELECT data FROM integration_events e JOIN integration_accounts a ON a.id=e.integration_account_id WHERE a.external_account_id=$1 AND e.kind='connected'", [unknown.id]);
    expect(ev[0].data).toMatchObject({ tasksUnverified: true });
  });

  it("stores only a keyed hash of the Meta user id, and null when Graph cannot tell", async () => {
    const p = page();
    await connect(owner, ws, p);
    const h1 = (await q("SELECT connected_meta_user_hash AS h FROM integration_accounts WHERE external_account_id=$1", [p.id]))[0].h;
    expect(h1).toBe(hashMetaUser(deps.userHashKey, "9000000000000001"));
    expect(h1).not.toContain("9000000000000001");
    graph.state.metaUserId = null;
    const p2 = page();
    await connect(owner, ws, p2);
    graph.state.metaUserId = undefined;
    expect((await q("SELECT connected_meta_user_hash AS h FROM integration_accounts WHERE external_account_id=$1", [p2.id]))[0].h).toBeNull();
  });
});
