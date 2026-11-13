import { createHmac, randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { createDb, type Db } from "@crm/db";
import { hashMetaUser } from "../src/inbox/meta-connect.ts";
import { metaUserCallbackRoutes, parseSignedRequest, type UserCallbackConfig } from "../src/inbox/meta-callbacks.ts";
import { bootstrap, type Harness } from "./harness.ts";

const DB = process.env.CRM_DB_NAME ?? "crm";
const SECRET = "app-secret-for-callback-tests";
const PREVIOUS = "previous-app-secret-for-tests";
const b64u = (b: Buffer | string) => Buffer.from(b).toString("base64url");
const signedRequest = (payload: Record<string, unknown>, secret = SECRET) => {
  const p = b64u(JSON.stringify(payload));
  return `${b64u(createHmac("sha256", secret).update(p).digest())}.${p}`;
};
const good = (userId: string) => signedRequest({ algorithm: "HMAC-SHA256", user_id: userId, issued_at: 1_700_000_000 });
const digits = () => `7${Math.floor(Math.random() * 1e13).toString().padStart(13, "0")}`;

let h: Harness;
let workerDb: Db;
let cfg: UserCallbackConfig;
let app: Hono;
let wsA: string, wsB: string;
const userHashKey = createHmac("sha256", "cb-test-user-hash-key").update("crm-meta-user-v1").digest();
const q = async (text: string, params: unknown[] = []) => (await h.admin.query(text, params)).rows;
const post = (path: string, signed: string | null, a: Hono = app) =>
  a.request(`/meta/callbacks${path}`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: signed === null ? "" : new URLSearchParams({ signed_request: signed }).toString() });

/** Inserts an account (as the superuser) already linked to a Meta user, with a stored token row. */
async function account(ws: string, metaUser: string | null, status = "connected") {
  const ext = digits();
  const [a] = await q("INSERT INTO integration_accounts (workspace_id, platform, external_account_id, status, connected_meta_user_hash) VALUES ($1,'messenger',$2,$3,$4) RETURNING id", [ws, ext, status, metaUser ? hashMetaUser(userHashKey, metaUser) : null]);
  await q("INSERT INTO integration_secrets (workspace_id, integration_account_id, version, ciphertext, nonce, key_id) VALUES ($1,$2,1,$3,$4,'dev1')", [ws, a.id, randomBytes(40), randomBytes(12)]);
  return a.id as string;
}
const state = async (id: string) => (await q("SELECT status, connected_meta_user_hash AS h, (SELECT count(*)::int FROM integration_secrets s WHERE s.integration_account_id = a.id) AS secrets FROM integration_accounts a WHERE id=$1", [id]))[0];
const events = async (id: string) => (await q("SELECT kind, data FROM integration_events WHERE integration_account_id=$1 ORDER BY id", [id]));

beforeAll(async () => {
  h = await bootstrap();
  workerDb = createDb(`postgres://crm_worker:worker_dev@127.0.0.1:5436/${DB}`);
  cfg = { appSecrets: [SECRET, PREVIOUS], workerDb, userHashKey, statusKey: createHmac("sha256", "status-key").update("x").digest(), publicBaseUrl: "https://example.trycloudflare.com" };
  app = new Hono().route("/meta/callbacks", metaUserCallbackRoutes(cfg));
  const [a, b] = await Promise.all([h.newUser("cba"), h.newUser("cbb")]);
  [wsA, wsB] = [await h.workspace(a, "CB A"), await h.workspace(b, "CB B")];
});
afterAll(async () => {
  await workerDb.$client.end();
  await h.close();
});

describe("signed_request parsing", () => {
  const ok = { algorithm: "HMAC-SHA256", user_id: "12345" };
  it("accepts a correctly signed request, with the current or the previous secret", () => {
    expect(parseSignedRequest(signedRequest(ok), [SECRET])).toEqual({ userId: "12345" });
    expect(parseSignedRequest(signedRequest(ok, PREVIOUS), [SECRET, PREVIOUS])).toEqual({ userId: "12345" });
  });
  it("rejects anything else without throwing", () => {
    const sr = signedRequest(ok);
    const [sig, payload] = sr.split(".") as [string, string];
    const cases: [string, string[]][] = [
      [signedRequest(ok, "wrong-secret"), [SECRET]],
      [sr, []], [sr, [""]],
      [`${sig}.${b64u(JSON.stringify({ ...ok, user_id: "99999" }))}`, [SECRET]], // payload changed after signing
      [signedRequest({ algorithm: "HMAC-SHA1", user_id: "1" }), [SECRET]],
      [signedRequest({ algorithm: "HMAC-SHA256" }), [SECRET]],
      [signedRequest({ algorithm: "HMAC-SHA256", user_id: 12345 }), [SECRET]],
      [signedRequest({ algorithm: "HMAC-SHA256", user_id: "a b" }), [SECRET]],
      [`${sig}`, [SECRET]], [`.${payload}`, [SECRET]], [`${sig}.`, [SECRET]], ["", [SECRET]], ["not base64!.also not!", [SECRET]],
      [`${sig}.${"A".repeat(20_000)}`, [SECRET]],
      [(() => { const p = b64u("not json"); return `${b64u(createHmac("sha256", SECRET).update(p).digest())}.${p}`; })(), [SECRET]],
    ];
    for (const [input, secrets] of cases) expect(parseSignedRequest(input, secrets)).toBeNull();
  });
});

describe("deauthorize callback", () => {
  it("marks that person's connections reauth_required, deletes their tokens, records an event, and leaves everyone else alone", async () => {
    const me = digits(), someoneElse = digits();
    const [a1, a2, other, already] = [await account(wsA, me), await account(wsB, me), await account(wsA, someoneElse), await account(wsA, me, "disabled")];
    const res = await post("/deauthorize", good(me));
    expect(res.status).toBe(200);
    for (const id of [a1, a2]) expect(await state(id)).toMatchObject({ status: "reauth_required", secrets: 0 }); // both workspaces: it is one person's authorisation
    expect(await state(other)).toMatchObject({ status: "connected", secrets: 1 });
    expect(await state(already)).toMatchObject({ status: "disabled" });
    expect((await events(a1)).at(-1)).toMatchObject({ kind: "status_changed", data: { reason: "meta_deauthorized" } });
    expect(JSON.stringify(await events(a1))).not.toContain(me); // no raw Meta user id anywhere
    expect((await post("/deauthorize", good(me))).status).toBe(200); // idempotent
    expect((await events(a1)).filter((e) => e.kind === "status_changed")).toHaveLength(1);
  });

  it("answers an unknown user exactly like a known one and changes nothing", async () => {
    const id = await account(wsA, digits());
    const res = await post("/deauthorize", good(digits()));
    expect([res.status, await res.json()]).toEqual([200, { ok: true }]);
    expect(await state(id)).toMatchObject({ status: "connected", secrets: 1 });
  });

  it("rejects unsigned, mis-signed, empty and oversized bodies with 400 and changes nothing", async () => {
    const me = digits();
    const id = await account(wsA, me);
    expect((await post("/deauthorize", signedRequest({ algorithm: "HMAC-SHA256", user_id: me }, "attacker-secret"))).status).toBe(400);
    expect((await post("/deauthorize", null)).status).toBe(400);
    expect((await post("/deauthorize", "garbage")).status).toBe(400);
    const big = await app.request("/meta/callbacks/deauthorize", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "signed_request=" + "A".repeat(40_000) });
    expect(big.status).toBe(400);
    const json = await app.request("/meta/callbacks/deauthorize", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ signed_request: good(me) }) });
    expect(json.status).toBe(400); // only the documented form encoding is accepted
    expect(await state(id)).toMatchObject({ status: "connected", secrets: 1 });
  });

  it("rate limits per source", async () => {
    const limited = new Hono().route("/meta/callbacks", metaUserCallbackRoutes({ ...cfg, limitPerWindow: 2 }));
    const out = [];
    for (let i = 0; i < 4; i++) out.push((await post("/deauthorize", null, limited)).status);
    expect(out).toEqual([400, 400, 429, 429]);
  });
});

describe("data-deletion callback", () => {
  it("disconnects the person's accounts, erases tokens and the Meta user link, and returns a signed status link", async () => {
    const me = digits(), other = digits();
    const [a1, a2, keep] = [await account(wsA, me), await account(wsB, me, "reauth_required"), await account(wsA, other)];
    const res = await post("/data-deletion", good(me));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Object.keys(body).sort()).toEqual(["confirmation_code", "url"]);
    expect(body.url).toMatch(/^https:\/\/example\.trycloudflare\.com\/meta\/callbacks\/data-deletion\/status\?code=/);
    for (const id of [a1, a2]) expect(await state(id)).toEqual({ status: "disabled", h: null, secrets: 0 });
    expect(await state(keep)).toMatchObject({ status: "connected", secrets: 1 });
    expect((await events(a1)).at(-1)).toMatchObject({ data: { reason: "meta_data_deletion" } });

    const status = await app.request(new URL(body.url).pathname + new URL(body.url).search);
    expect(status.status).toBe(200);
    expect(await status.text()).toMatch(/2 connected account\(s\) were disconnected/);
    const again = await (await post("/data-deletion", good(me))).json();
    expect(await (await app.request(`/meta/callbacks/data-deletion/status?code=${encodeURIComponent(again.confirmation_code)}`)).text()).toMatch(/0 connected account/); // nothing left to delete
  });

  it("status link: a tampered or foreign code is 404, and the response never contains the Meta user id", async () => {
    const me = digits();
    const body = await (await post("/data-deletion", good(me))).json();
    const [payload, sig] = body.confirmation_code.split(".") as [string, string];
    for (const code of [`${payload}.${sig.slice(0, -2)}AA`, `${b64u('{"t":1,"n":999}')}.${sig}`, "x", "", "."]) {
      expect((await app.request(`/meta/callbacks/data-deletion/status?code=${encodeURIComponent(code)}`)).status).toBe(404);
    }
    expect(JSON.stringify(body)).not.toContain(me);
  });

  it("is 503 without a public base URL, and 400 for a bad signature", async () => {
    const noBase = new Hono().route("/meta/callbacks", metaUserCallbackRoutes({ ...cfg, publicBaseUrl: undefined }));
    expect((await post("/data-deletion", good(digits()), noBase)).status).toBe(503);
    expect((await post("/data-deletion", signedRequest({ algorithm: "HMAC-SHA256", user_id: "1" }, "bad"))).status).toBe(400);
  });
});
