import { createHmac } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { createDb, type Db } from "@crm/db";
import { buildMessagePayload, createMockGraph, createSecretBox, mockSecret, SendError, signedFixture } from "@crm/integrations";
import type { MetaConnectDeps } from "../src/inbox/meta-connect.ts";
import { processWebhookEvent } from "../src/inbox/process.ts";
import { failureCodeOf, recoverStuckSends } from "../src/inbox/send.ts";
import { metaWebhookRoutes } from "../src/inbox/webhook.ts";
import { bootstrap, type Harness, type TestUser } from "./harness.ts";

const DB = process.env.CRM_DB_NAME ?? "crm";
const box = createSecretBox({ k1: Buffer.alloc(32, 9).toString("base64") }, "k1");
const TOKEN = "PAGE-TOKEN-must-never-leak";
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
const DECIDE = (w: string, c: string, m: string) => `${SEND(w, c)}/${m}/delivery`;

/** Connected Messenger Page with an encrypted token + a contact who wrote `inboundMinsAgo` minutes ago (null = never). */
async function setup(w: string, o: { inboundMinsAgo?: number | null; token?: boolean; platform?: string; status?: string } = {}) {
  const ref = digits();
  const [a] = await q("INSERT INTO integration_accounts (workspace_id, platform, external_account_id, status, display_name) VALUES ($1,$2,$3,$4,'Test Page') RETURNING id", [w, o.platform ?? "messenger", ref, o.status ?? "connected"]);
  accounts.push(a.id);
  if (o.token !== false) {
    const s = box.seal(TOKEN, `${w}:${a.id}`);
    await q("INSERT INTO integration_secrets (workspace_id, integration_account_id, version, ciphertext, nonce, key_id) VALUES ($1,$2,1,$3,$4,$5)", [w, a.id, s.ciphertext, s.nonce, s.keyId]);
  }
  const [stage] = await q("SELECT id FROM lifecycle_stages WHERE workspace_id=$1 ORDER BY position LIMIT 1", [w]);
  const [ct] = await q("INSERT INTO contacts (workspace_id, name, lifecycle_stage_id, source) VALUES ($1,'Sender',$2,'messenger') RETURNING id", [w, stage.id]);
  const psid = digits();
  const [idn] = await q("INSERT INTO platform_identities (workspace_id, integration_account_id, external_user_id, contact_id) VALUES ($1,$2,$3,$4) RETURNING id", [w, a.id, psid, ct.id]);
  const [cv] = await q("INSERT INTO conversations (workspace_id, integration_account_id, identity_id, contact_id) VALUES ($1,$2,$3,$4) RETURNING id", [w, a.id, idn.id, ct.id]);
  const mins = o.inboundMinsAgo === undefined ? 5 : o.inboundMinsAgo;
  if (mins !== null) {
    const at = new Date(Date.now() - mins * 60_000).toISOString();
    await q("INSERT INTO messages (workspace_id, conversation_id, integration_account_id, direction, external_id, sender_kind, body, delivery_state, occurred_at) VALUES ($1,$2,$3,'in',$4,'contact','hi','received',$5)", [w, cv.id, a.id, `m.${digits()}`, at]);
    await q("UPDATE conversations SET last_inbound_at=$2::timestamptz, last_message_at=$2::timestamptz WHERE id=$1", [cv.id, at]);
  }
  return { account: a.id as string, ref, psid, conv: cv.id as string };
}
const outRows = (conv: string) => q("SELECT * FROM messages WHERE conversation_id=$1 AND direction='out' ORDER BY seq", [conv]);
const attempts = (msg: string) => q("SELECT * FROM outbound_attempts WHERE message_id=$1 ORDER BY attempt", [msg]);
const sends = () => graph.calls.filter((c) => c.startsWith("send:"));
const reset = (over: Parameters<typeof createMockGraph>[0] = {}) => { graph.calls.length = 0; Object.assign(graph.state, { sends: [], onSend: undefined, ...over }); };
/** Backdates the database-owned state clock. Triggers are skipped for this one transaction only (session_replication_role), so other test files are not affected. */
async function age(msgId: string, minutes: number) {
  await q("BEGIN");
  try {
    await q("SET LOCAL session_replication_role = replica");
    await q("UPDATE messages SET state_changed_at = now() - make_interval(mins => $2) WHERE id=$1", [msgId, minutes]);
    await q("COMMIT");
  } catch (e) { await q("ROLLBACK"); throw e; }
}
/** Processes only THIS account's stored events: draining everything would steal other test files' events on the shared database. */
async function drain(ref: string) {
  for (const e of await q("SELECT id FROM webhook_events WHERE account_ref=$1 AND status IN ('received','failed') ORDER BY received_at", [ref])) await processWebhookEvent(workerDb, e.id);
}

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
  [owner, agent, viewer, other] = (await Promise.all(["sowner", "sagent", "sviewer", "sother"].map((l) => h.newUser(l)))) as TestUser[] as [TestUser, TestUser, TestUser, TestUser];
  ws = await h.workspace(owner, "Send A", { agent, viewer });
  wsOther = await h.workspace(other, "Send B");
});
afterAll(async () => {
  if (accounts.length) await q("UPDATE integration_accounts SET last_token_check_at = now(), status = 'disabled' WHERE id = ANY($1::uuid[])", [accounts]);
  await workerDb.$client.end();
  await ingestDb.$client.end();
  await h.close();
});

describe("sending a text reply", () => {
  it("sends through the Send API with the Page token, stores sent + Meta id, and records the attempt BEFORE the call", async () => {
    const s = await setup(ws);
    reset();
    let duringCall: Record<string, unknown>[] = [];
    graph.state.onSend = async () => { duringCall = await q("SELECT m.delivery_state, a.outcome FROM messages m JOIN outbound_attempts a ON a.message_id = m.id WHERE m.conversation_id=$1", [s.conv]); };
    graph.state.sends = ["mid.real.1"];
    const id = uuid();
    const res = await call(agent, SEND(ws, s.conv), { clientMsgId: id, body: "  Hello there  " });
    expect(res.status).toBe(201);
    const j = await res.json();
    expect(j.message).toMatchObject({ direction: "out", senderKind: "user", deliveryState: "sent", body: "Hello there", failureCode: null });
    expect(sends()).toEqual([`send:${s.ref}:${s.psid}:Hello there`]);
    expect(duringCall).toEqual([{ delivery_state: "sending", outcome: null }]); // persisted as "sending" with an open attempt before the network call
    const [row] = await outRows(s.conv);
    expect(row).toMatchObject({ external_id: "mid.real.1", delivery_state: "sent", client_msg_id: id, sender_user_id: agent.id });
    const [att] = await attempts(row.id);
    expect(att).toMatchObject({ attempt: 1, outcome: "accepted", http_status: 200 });
    expect(JSON.stringify(att.request_summary)).not.toContain("Hello");
    const [audit] = await q("SELECT summary FROM audit_log WHERE entity_id=$1 AND action='message.send_requested'", [row.id]);
    expect(JSON.stringify(audit.summary)).not.toContain("Hello");
    expect(JSON.stringify([j, att, audit])).not.toContain(TOKEN);
  });

  it("repeating a client id returns the stored message and never sends again, even concurrently", async () => {
    const s = await setup(ws);
    reset();
    const id = uuid();
    const rs = await Promise.all([1, 2, 3, 4].map(() => call(owner, SEND(ws, s.conv), { clientMsgId: id, body: "once" })));
    expect(rs.every((r) => r.status === 200 || r.status === 201)).toBe(true);
    expect(sends()).toHaveLength(1);
    expect(await outRows(s.conv)).toHaveLength(1);
    const again = await call(owner, SEND(ws, s.conv), { clientMsgId: id, body: "once" });
    expect(again.status).toBe(200);
    expect((await again.json()).message.id).toBe((await outRows(s.conv))[0].id);
    expect(sends()).toHaveLength(1);
    // the same id for a different conversation or person is refused, not silently reused
    const s2 = await setup(ws);
    expect((await call(owner, SEND(ws, s2.conv), { clientMsgId: id, body: "x" })).status).toBe(409);
    expect((await call(agent, SEND(ws, s.conv), { clientMsgId: id, body: "x" })).status).toBe(409);
  });

  it("refuses outside the 24 hour window, with no inbound message, for Instagram, and for a Page that needs reconnecting; nothing is stored or sent", async () => {
    reset();
    const cases = [
      [await setup(ws, { inboundMinsAgo: 24 * 60 + 1 }), 409, "window_closed"],
      [await setup(ws, { inboundMinsAgo: null }), 409, "window_closed"],
      [await setup(ws, { platform: "instagram" }), 422, "unsupported_channel"],
      [await setup(ws, { status: "reauth_required" }), 409, "account_not_connected"],
    ] as const;
    for (const [s, status, code] of cases) {
      const res = await call(owner, SEND(ws, s.conv), { clientMsgId: uuid(), body: "hi" });
      expect(res.status).toBe(status);
      expect((await res.json()).error.code).toBe(code);
      expect(await outRows(s.conv)).toHaveLength(0);
    }
    expect(sends()).toHaveLength(0);
  });

  it("just inside the window still sends, and no message tag is ever used", async () => {
    const s = await setup(ws, { inboundMinsAgo: 24 * 60 - 2 });
    reset();
    expect((await call(owner, SEND(ws, s.conv), { clientMsgId: uuid(), body: "late but fine" })).status).toBe(201);
    expect(sends()).toHaveLength(1);
  });

  it("validates input: empty, whitespace, too long, bad id", async () => {
    const s = await setup(ws);
    for (const body of [{ clientMsgId: uuid(), body: "" }, { clientMsgId: uuid(), body: "   " }, { clientMsgId: uuid(), body: "x".repeat(2001) }, { clientMsgId: "nope", body: "hi" }, { body: "hi" }, { clientMsgId: uuid(), body: "a\u0000b" }]) {
      expect((await call(owner, SEND(ws, s.conv), body)).status).toBe(400);
    }
    expect((await call(owner, SEND(ws, "not-a-uuid"), { clientMsgId: uuid(), body: "hi" })).status).toBe(404);
    expect((await call(owner, SEND(ws, s.conv), { clientMsgId: uuid(), body: "x".repeat(2000) })).status).toBe(201);
  });
});

describe("access control and tenant isolation", () => {
  it("viewers cannot send; outsiders and other workspaces cannot reach the conversation", async () => {
    const s = await setup(ws);
    const sB = await setup(wsOther);
    reset();
    expect((await call(viewer, SEND(ws, s.conv), { clientMsgId: uuid(), body: "hi" })).status).toBe(403);
    expect((await call(other, SEND(ws, s.conv), { clientMsgId: uuid(), body: "hi" })).status).toBe(404); // not a member of ws: the workspace is hidden
    expect((await call(owner, SEND(wsOther, sB.conv), { clientMsgId: uuid(), body: "hi" })).status).toBe(404); // not a member of wsOther
    expect((await call(owner, SEND(ws, sB.conv), { clientMsgId: uuid(), body: "hi" })).status).toBe(404); // another workspace's conversation through my workspace path
    expect((await call(other, SEND(wsOther, s.conv), { clientMsgId: uuid(), body: "hi" })).status).toBe(404);
    expect(sends()).toHaveLength(0);
    expect(await outRows(s.conv)).toHaveLength(0);
    expect(await outRows(sB.conv)).toHaveLength(0);
  });

  it("answers 503 when messaging is not configured on the server", async () => {
    const un = await bootstrap();
    try {
      const u = await un.newUser("snoconf");
      const w = await un.workspace(u, "NoConf");
      const res = await un.app.request(SEND(w, uuid()), { method: "POST", headers: { cookie: u.cookie, origin: "http://localhost:3000", "content-type": "application/json" }, body: JSON.stringify({ clientMsgId: uuid(), body: "hi" }) });
      expect(res.status).toBe(503);
    } finally { await un.close(); }
  });
});

describe("Meta errors, timeouts and the UNKNOWN state", () => {
  it("a refusal (4xx with a Graph error) is a definite failure with a safe code, and is not retried", async () => {
    const s = await setup(ws);
    reset({ sends: [new SendError("rejected", 400, 551, 1234)] });
    const res = await call(owner, SEND(ws, s.conv), { clientMsgId: uuid(), body: "hi" });
    expect(res.status).toBe(201);
    expect((await res.json()).message).toMatchObject({ deliveryState: "failed", failureCode: "recipient_unavailable" });
    const [row] = await outRows(s.conv);
    expect(row.external_id).toBeNull();
    expect(await attempts(row.id)).toMatchObject([{ outcome: "rejected", http_status: 400, platform_error_code: "551/1234" }]);
    await recoverStuckSends(workerDb);
    expect(sends()).toHaveLength(1);
  });

  it("maps documented Meta codes to stable failure codes", () => {
    const e = (code: number | null, status = 400) => new SendError("rejected", status, code, null);
    expect(failureCodeOf(e(190))).toBe("token_invalid");
    expect(failureCodeOf(e(551))).toBe("recipient_unavailable");
    expect(failureCodeOf(e(1545041))).toBe("recipient_unavailable");
    expect(failureCodeOf(e(613))).toBe("rate_limited");
    expect(failureCodeOf(e(10))).toBe("permission_denied");
    expect(failureCodeOf(e(100))).toBe("invalid_request");
    expect(failureCodeOf(e(2018278))).toBe("meta_error_2018278");
  });

  it("a timeout / unreadable answer is UNKNOWN: stored, never re-sent, not marked failed, no Meta id", async () => {
    const s = await setup(ws);
    reset({ sends: [new SendError("ambiguous", null, null, null)] });
    const res = await call(owner, SEND(ws, s.conv), { clientMsgId: uuid(), body: "maybe" });
    expect(res.status).toBe(201);
    expect((await res.json()).message).toMatchObject({ deliveryState: "unknown", failureCode: "no_response" });
    const [row] = await outRows(s.conv);
    expect(row).toMatchObject({ delivery_state: "unknown", external_id: null });
    expect(await attempts(row.id)).toMatchObject([{ outcome: "ambiguous" }]);
    await recoverStuckSends(workerDb);
    await recoverStuckSends(workerDb);
    expect(sends()).toHaveLength(1); // nothing re-sent, however often recovery runs
    expect((await outRows(s.conv))[0].delivery_state).toBe("unknown");
  });

  it("a process that died mid-send leaves `sending`; recovery makes it UNKNOWN (never failed, never re-sent)", async () => {
    const s = await setup(ws);
    reset();
    await q("INSERT INTO messages (workspace_id, conversation_id, integration_account_id, direction, delivery_state, sender_kind, sender_user_id, client_msg_id, body) VALUES ($1,$2,$3,'out','pending','user',$4,$5,'crashed')", [ws, s.conv, s.account, owner.id, uuid()]);
    const [row] = await outRows(s.conv);
    await q("UPDATE messages SET delivery_state='sending' WHERE id=$1", [row.id]);
    await q("INSERT INTO outbound_attempts (workspace_id, message_id, attempt) VALUES ($1,$2,1)", [ws, row.id]);
    await recoverStuckSends(workerDb);
    expect((await outRows(s.conv))[0].delivery_state).toBe("sending"); // too fresh to judge
    await age(row.id, 3);
    await recoverStuckSends(workerDb);
    expect((await outRows(s.conv))[0]).toMatchObject({ delivery_state: "unknown", failure_code: "interrupted" });
    expect(await attempts(row.id)).toMatchObject([{ outcome: "ambiguous", platform_error_code: "interrupted" }]);
    expect(sends()).toHaveLength(0);
  });

  it("no usable token: definite failure, nothing sent", async () => {
    const s = await setup(ws, { token: false });
    reset();
    const res = await call(owner, SEND(ws, s.conv), { clientMsgId: uuid(), body: "hi" });
    expect((await res.json()).message).toMatchObject({ deliveryState: "failed", failureCode: "token_unavailable" });
    expect(sends()).toHaveLength(0);
  });

  it("an UNKNOWN message can be decided by a person only after 10 minutes, and the decision is audited", async () => {
    const s = await setup(ws);
    reset({ sends: [new SendError("ambiguous", 502, null, null), new SendError("ambiguous", 500, null, null)] });
    const m1 = (await (await call(owner, SEND(ws, s.conv), { clientMsgId: uuid(), body: "one" })).json()).message.id as string;
    const m2 = (await (await call(owner, SEND(ws, s.conv), { clientMsgId: uuid(), body: "two" })).json()).message.id as string;
    expect((await call(owner, DECIDE(ws, s.conv, m1), { decision: "not_sent" })).status).toBe(409);
    await age(m1, 11);
    await age(m2, 11);
    expect((await call(viewer, DECIDE(ws, s.conv, m1), { decision: "sent" })).status).toBe(403);
    const ok = await call(agent, DECIDE(ws, s.conv, m1), { decision: "not_sent" });
    expect(ok.status).toBe(200);
    expect((await ok.json()).message).toMatchObject({ deliveryState: "failed", failureCode: "marked_not_sent" });
    expect((await (await call(agent, DECIDE(ws, s.conv, m2), { decision: "sent" })).json()).message.deliveryState).toBe("sent");
    expect((await call(agent, DECIDE(ws, s.conv, m1), { decision: "sent" })).status).toBe(409); // decided already
    expect((await call(other, DECIDE(wsOther, s.conv, m1), { decision: "sent" })).status).toBe(404);
    const audits = await q("SELECT summary FROM audit_log WHERE action='message.delivery_decided' AND entity_id = ANY($1::text[]) ORDER BY created_at", [[m1, m2]]);
    expect(audits.map((a) => a.summary.decision)).toEqual(["not_sent", "sent"]);
    expect(sends()).toHaveLength(2); // deciding never sends anything
  });
});

describe("echo of our own message", () => {
  const echo = async (s: { ref: string; psid: string }, mid: string, text: string) => {
    const f = signedFixture(buildMessagePayload({ accountId: s.ref, userId: s.psid, mid, text, timestampMs: Date.now(), echo: true }), mockSecret);
    expect((await hook.request("/webhooks/meta/messenger", { method: "POST", body: new Uint8Array(f.raw), headers: { "content-type": "application/json", "x-hub-signature-256": f.signature } })).status).toBe(200);
    await drain(s.ref);
  };

  it("adopts the Meta id of an UNKNOWN message (no duplicate row), and ignores a later echo of an already recorded one", async () => {
    const s = await setup(ws);
    reset({ sends: [new SendError("ambiguous", null, null, null)] });
    await call(owner, SEND(ws, s.conv), { clientMsgId: uuid(), body: "did it arrive" });
    await echo(s, `mid.echo.${digits()}`, "did it arrive");
    const rows = await outRows(s.conv);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ delivery_state: "sent", sender_kind: "user" });
    expect(rows[0].external_id).toMatch(/^mid\.echo\./);

    reset({ sends: ["mid.fast.1"] });
    await call(owner, SEND(ws, s.conv), { clientMsgId: uuid(), body: "normal" });
    await echo(s, "mid.fast.1", "normal"); // the echo that follows a successful send
    expect(await outRows(s.conv)).toHaveLength(2);
  });

  it("an echo that arrives while the send is still in flight does not create a copy", async () => {
    const s = await setup(ws);
    reset({ sends: ["mid.race.1"] });
    graph.state.onSend = async () => { await echo(s, "mid.race.1", "racing"); };
    await call(owner, SEND(ws, s.conv), { clientMsgId: uuid(), body: "racing" });
    const rows = await outRows(s.conv);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ delivery_state: "sent", external_id: "mid.race.1" });
  });

  it("a message typed in the Facebook app (no CRM row) is still stored as an external echo", async () => {
    const s = await setup(ws);
    await echo(s, `mid.ext.${digits()}`, "typed elsewhere");
    expect(await outRows(s.conv)).toMatchObject([{ sender_kind: "external", delivery_state: "sent" }]);
  });
});
