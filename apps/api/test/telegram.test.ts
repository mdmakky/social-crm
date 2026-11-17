import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import { Hono } from "hono";
import { createDb, type Db } from "@crm/db";
import { createMockGraph, createMockTelegram, createSecretBox, tgMyChatMember, tgPrivateText, TelegramError, TelegramSendError, type TelegramClient } from "@crm/integrations";
import type { MetaConnectDeps } from "../src/inbox/meta-connect.ts";
import { processWebhookEvent } from "../src/inbox/process.ts";
import { telegramWebhookRoutes } from "../src/inbox/telegram-webhook.ts";
import { bootstrap, type Harness, type TestUser } from "./harness.ts";

// Telegram channel, MOCK ONLY: the Telegram port is the in-memory mock or a fake. These tests prove OUR handling (validation, sealing, routing, secret check, dedupe, sending, failure mapping, tenancy), not Telegram's behaviour.
const DB = process.env.CRM_DB_NAME ?? "crm";
const box = createSecretBox({ k1: Buffer.alloc(32, 5).toString("base64") }, "k1");
const BASE = "https://crm.test";
let h: Harness, workerDb: Db, ingestDb: Db, hook: Hono, deps: MetaConnectDeps, mock: ReturnType<typeof createMockTelegram>;
let owner: TestUser, agent: TestUser, other: TestUser;
let ws: string, wsOther: string;
const violations: string[] = [];
let openTx = 0;
const rnd = () => Math.floor(Math.random() * 1e9) + 1e9;
const q = async (text: string, params: unknown[] = []) => (await h.admin.query(text, params)).rows;
const call = (u: TestUser, method: string, path: string, body?: unknown) =>
  h.app.request(path, { method, headers: { cookie: u.cookie, origin: "http://localhost:3000", ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
const TG = (w: string) => `/v1/workspaces/${w}/integrations/telegram`;
const SEND = (w: string, c: string) => `/v1/workspaces/${w}/conversations/${c}/messages`;
const uuid = () => crypto.randomUUID();
const botIds: string[] = [];

/** A bot the mock knows about, with a fresh id and token per test (bot ids are globally unique across workspaces). */
function newBot() {
  const id = String(rnd());
  const token = `${id}:tg-mock-token-${Math.random().toString(36).slice(2)}-0000`;
  mock.state.bots.set(token, { id, username: `bot_${id}` });
  botIds.push(id);
  return { id, token };
}
const connect = (u: TestUser, w: string, token: string) => call(u, "POST", `${TG(w)}/connect`, { botToken: token });
const hookFor = (token: string) => {
  const w = mock.state.webhooks.get(token)!;
  const path = new URL(w.url).pathname;
  return { path, secret: w.secretToken, url: w.url };
};
const post = (path: string, update: unknown, secret?: string) =>
  hook.request(path, { method: "POST", body: JSON.stringify(update), headers: { "content-type": "application/json", ...(secret ? { "x-telegram-bot-api-secret-token": secret } : {}) } });
async function drain(botId: string) {
  for (const e of await q("SELECT id FROM webhook_events WHERE platform='telegram' AND account_ref=$1 AND status IN ('received','failed')", [botId])) await processWebhookEvent(workerDb, e.id);
}
/** Connects a bot and lets one person write once, returning what a reply needs. */
async function chat(w = ws, user = rnd(), date?: number) {
  const bot = newBot();
  expect((await connect(owner, w, bot.token)).status).toBe(200);
  const hk = hookFor(bot.token);
  expect((await post(hk.path, tgPrivateText({ updateId: rnd(), userId: user, messageId: 1, text: "hello from telegram", date }), hk.secret)).status).toBe(200);
  await drain(bot.id);
  const [conv] = await q("SELECT c.id FROM conversations c JOIN integration_accounts a ON a.id = c.integration_account_id WHERE a.platform='telegram' AND a.external_account_id=$1", [bot.id]);
  return { bot, hk, user, conv: conv.id as string };
}

beforeEach(() => { deps.telegram = mock; });
/** Swaps the Telegram client for a fake for one test. */
const withClient = (c: Partial<TelegramClient>) => { deps.telegram = { ...mock, ...c } as TelegramClient; };

beforeAll(async () => {
  workerDb = createDb(`postgres://crm_worker:worker_dev@127.0.0.1:5436/${DB}`);
  ingestDb = createDb(`postgres://crm_ingest:ingest_dev@127.0.0.1:5436/${DB}`);
  hook = new Hono().route("/webhooks/telegram", telegramWebhookRoutes({ ingestDb }));
  mock = createMockTelegram({ bots: new Map() });
  // Instrumentation: flag every Telegram call made while a worker transaction is open (decision D72: no network call inside a DB transaction).
  for (const k of ["getMe", "setWebhook", "deleteWebhook", "getWebhookInfo", "sendMessage"] as const) {
    const f = mock[k] as (...a: unknown[]) => unknown;
    (mock as unknown as Record<string, unknown>)[k] = (...a: unknown[]) => { if (openTx > 0) violations.push(k); return f(...a); };
  }
  deps = {
    graph: createMockGraph({ pages: [] }), telegram: mock, publicBaseUrl: BASE, box, workerDb, appId: "123456", configId: "654321", graphVersion: "v25.0", redirectUri: "http://localhost:3000/v1/integrations/meta/callback", webOrigin: "http://localhost:3000",
    stateKey: createHmac("sha256", "k").update("s").digest(), userHashKey: createHmac("sha256", "k").update("u").digest(), mock: true, secureCookies: false,
  };
  deps.workerDb = new Proxy(workerDb, { get: (t, k) => (k === "transaction" ? (fn: (tx: unknown) => Promise<unknown>, ...rest: unknown[]) => (t as unknown as { transaction: (...a: unknown[]) => Promise<unknown> }).transaction(async (tx: unknown) => { openTx++; try { return await fn(tx); } finally { openTx--; } }, ...rest) : Reflect.get(t, k)) }) as Db;
  h = await bootstrap({ tgLimits: { connectsPerUser: 1000 } }, deps); // the rate limit has its own test
  [owner, agent, other] = (await Promise.all(["tgowner", "tgagent", "tgother"].map((l) => h.newUser(l)))) as [TestUser, TestUser, TestUser];
  ws = await h.workspace(owner, "TG A", { agent });
  wsOther = await h.workspace(other, "TG B");
});
afterAll(async () => {
  if (botIds.length) await q("UPDATE integration_accounts SET status = 'disabled' WHERE platform = 'telegram' AND external_account_id = ANY($1::text[])", [botIds]);
  await workerDb.$client.end();
  await ingestDb.$client.end();
  await h.close();
});

describe("connect", () => {
  it("only owners and admins connect; a bad token is refused before anything is stored", async () => {
    const bot = newBot();
    expect((await connect(agent, ws, bot.token)).status).toBe(403);
    expect((await call(owner, "POST", `${TG(ws)}/connect`, { botToken: "short" })).status).toBe(400);
    const bad = await connect(owner, ws, "1234567890:not-a-token-known-to-the-mock-0000");
    expect(bad.status).toBe(422);
    expect((await bad.json()).error.code).toBe("token_invalid");
    expect(await q("SELECT 1 FROM integration_accounts WHERE external_account_id = $1", [bot.id])).toHaveLength(0);
  });

  it("connects: bot id from getMe, token sealed, only a hash of the secret stored, webhook set with the documented parameters, no network call inside a transaction", async () => {
    const bot = newBot();
    const res = await connect(owner, ws, bot.token);
    expect(res.status).toBe(200);
    const out = await res.json();
    expect(out).toMatchObject({ webhook: "set", reconnected: false, botUsername: `bot_${bot.id}`, account: { platform: "telegram", externalAccountId: bot.id, displayName: `@bot_${bot.id}`, status: "connected" } });
    expect(JSON.stringify(out)).not.toContain(bot.token);
    const hk = hookFor(bot.token);
    expect(hk.url.startsWith(`${BASE}/webhooks/telegram/`)).toBe(true);
    expect(mock.state.webhooks.get(bot.token)).toMatchObject({ maxConnections: 3, allowedUpdates: ["message", "my_chat_member"], dropPendingUpdates: false });
    expect(/^[A-Za-z0-9_-]{43}$/.test(hk.secret)).toBe(true);
    const [t] = await q("SELECT * FROM telegram_accounts WHERE bot_id=$1", [bot.id]);
    expect(t.secret_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(t)).not.toContain(hk.secret);
    expect(hk.url.endsWith(t.webhook_path_id)).toBe(true);
    const [s] = await q("SELECT ciphertext FROM integration_secrets WHERE integration_account_id=$1", [t.integration_account_id]);
    expect(Buffer.from(s.ciphertext).toString("latin1")).not.toContain(bot.token);
    expect(violations).toEqual([]);
  });

  it("a bot held by another workspace is refused with 409; the application role never sees the path id or secret hash", async () => {
    const bot = newBot();
    expect((await connect(owner, ws, bot.token)).status).toBe(200);
    expect((await connect(other, wsOther, bot.token)).status).toBe(409);
    const app = await h.db.$client.query("SELECT 1");
    expect(app.rows).toHaveLength(1);
    await expect(h.db.$client.query("SELECT secret_hash FROM telegram_accounts")).rejects.toThrow(/permission denied/);
    await expect(h.db.$client.query("SELECT webhook_path_id FROM telegram_accounts")).rejects.toThrow(/permission denied/);
  });

  it("reconnecting rotates the path id and the secret: the old pair stops working", async () => {
    const bot = newBot();
    await connect(owner, ws, bot.token);
    const first = hookFor(bot.token);
    const res = await connect(owner, ws, bot.token);
    expect((await res.json()).reconnected).toBe(true);
    const second = hookFor(bot.token);
    expect(second.path).not.toBe(first.path);
    expect(second.secret).not.toBe(first.secret);
    expect((await post(first.path, tgPrivateText({ updateId: rnd(), userId: rnd(), messageId: 1, text: "x" }), first.secret)).status).toBe(403);
    expect((await post(second.path, tgPrivateText({ updateId: rnd(), userId: rnd(), messageId: 1, text: "x" }), second.secret)).status).toBe(200);
  });

  it("a webhook that Telegram refuses keeps the connection and says so; connecting again retries", async () => {
    const bot = newBot();
    withClient({ setWebhook: async () => { throw new TelegramError("other", 400, 400); } });
    expect((await (await connect(owner, ws, bot.token)).json()).webhook).toBe("failed");
    deps.telegram = mock;
    expect((await (await connect(owner, ws, bot.token)).json()).webhook).toBe("set");
  });

  it("health reports the webhook; disconnect deletes it, drops the token and audits", async () => {
    const bot = newBot();
    const acct = (await (await connect(owner, ws, bot.token)).json()).account;
    const health = await call(owner, "GET", `${TG(ws)}/accounts/${acct.id}/health`);
    expect(await health.json()).toMatchObject({ webhookSet: true, pendingUpdateCount: 0, lastErrorMessage: null });
    expect((await call(agent, "GET", `${TG(ws)}/accounts/${acct.id}/health`)).status).toBe(403);
    expect((await call(other, "GET", `${TG(wsOther)}/accounts/${acct.id}/health`)).status).toBe(404);
    expect((await call(owner, "POST", `/v1/workspaces/${ws}/integrations/meta/accounts/${acct.id}/disconnect`)).status).toBe(200);
    expect(mock.state.webhooks.has(bot.token)).toBe(false);
    expect(await q("SELECT 1 FROM integration_secrets WHERE integration_account_id=$1", [acct.id])).toHaveLength(0);
    const audit = await q("SELECT action FROM audit_log WHERE entity_id=$1 ORDER BY created_at", [acct.id]);
    expect(audit.map((a) => a.action)).toEqual(["integration.telegram.connected", "integration.telegram.disconnected"]);
    expect((await call(owner, "POST", `/v1/workspaces/${ws}/integrations/meta/accounts/${acct.id}/check-token`)).status).toBe(422); // Telegram has its own check
  });
});

describe("rate limit", () => {
  it("connect attempts are limited per user, so the route cannot be used to probe bot tokens in bulk", async () => {
    const lim = await bootstrap({ tgLimits: { connectsPerUser: 2 } }, deps);
    try {
      const u = await lim.newUser("tglim");
      const w = await lim.workspace(u, "TG L");
      const codes: number[] = [];
      for (let i = 0; i < 3; i++) codes.push((await lim.app.request(`${TG(w)}/connect`, { method: "POST", headers: { cookie: u.cookie, origin: "http://localhost:3000", "content-type": "application/json" }, body: JSON.stringify({ botToken: `1234567890:not-known-${i}-xxxxxxxxxxxxxxxx` }) })).status);
      expect(codes).toEqual([422, 422, 429]);
    } finally { await lim.close(); }
  });
});

describe("webhook ingress", () => {
  it("wrong, missing and unknown secrets or paths get 403 and store no body; the right pair is stored once per identical body", async () => {
    const bot = newBot();
    await connect(owner, ws, bot.token);
    const hk = hookFor(bot.token);
    const upd = tgPrivateText({ updateId: rnd(), userId: rnd(), messageId: 1, text: "dup" });
    expect((await post(hk.path, upd)).status).toBe(403);
    expect((await post(hk.path, upd, "wrong-secret")).status).toBe(403);
    expect((await post(hk.path, upd, hk.secret + "x")).status).toBe(403);
    expect((await post(`/webhooks/telegram/${"a".repeat(32)}`, upd, hk.secret)).status).toBe(403); // unknown path, right-looking secret
    expect((await post("/webhooks/telegram/short", upd, hk.secret)).status).toBe(403);
    expect(await q("SELECT 1 FROM webhook_events WHERE platform='telegram' AND account_ref=$1", [bot.id])).toHaveLength(0);
    expect((await q("SELECT count(*)::int AS n FROM webhook_events WHERE platform='telegram' AND status='rejected' AND raw_body IS NULL"))[0].n).toBeGreaterThan(0);
    expect((await post(hk.path, upd, hk.secret)).status).toBe(200);
    expect((await post(hk.path, upd, hk.secret)).status).toBe(200); // Telegram retry of the same update
    expect(await q("SELECT 1 FROM webhook_events WHERE platform='telegram' AND account_ref=$1", [bot.id])).toHaveLength(1);
    expect((await post(hk.path, "not json", hk.secret)).status).toBe(200); // acknowledged, nothing stored
    expect(await q("SELECT 1 FROM webhook_events WHERE platform='telegram' AND account_ref=$1", [bot.id])).toHaveLength(1);
  });

  it("a body over 1 MB is refused with 413", async () => {
    const bot = newBot();
    await connect(owner, ws, bot.token);
    const hk = hookFor(bot.token);
    expect((await post(hk.path, { update_id: 1, pad: "x".repeat(1024 * 1024 + 10) }, hk.secret)).status).toBe(413);
  });

  it("a private message creates the contact (named from the update), identity and conversation; a second delivery of the message adds nothing", async () => {
    const c = await chat();
    const [row] = await q("SELECT ct.name, ct.source, i.external_user_id FROM conversations v JOIN contacts ct ON ct.id = v.contact_id JOIN platform_identities i ON i.id = v.identity_id WHERE v.id=$1", [c.conv]);
    expect(row).toMatchObject({ name: "Mina Rahman", source: "telegram", external_user_id: String(c.user) });
    // same message again inside a different update (new update_id): the message key (chat:message) dedupes it
    await post(c.hk.path, tgPrivateText({ updateId: rnd(), userId: c.user, messageId: 1, text: "hello from telegram" }), c.hk.secret);
    await drain(c.bot.id);
    expect((await q("SELECT 1 FROM messages WHERE conversation_id=$1", [c.conv]))).toHaveLength(1);
    const [m] = await q("SELECT external_id, body, direction FROM messages WHERE conversation_id=$1", [c.conv]);
    expect(m).toMatchObject({ external_id: `${c.user}:1`, body: "hello from telegram", direction: "in" });
  });

  it("the same message id in two different chats is two messages (ids are unique per chat only)", async () => {
    const bot = newBot();
    await connect(owner, ws, bot.token);
    const hk = hookFor(bot.token);
    for (const u of [rnd(), rnd()]) await post(hk.path, tgPrivateText({ updateId: rnd(), userId: u, messageId: 7, text: "same id" }), hk.secret);
    await drain(bot.id);
    expect((await q("SELECT count(*)::int AS n FROM messages m JOIN integration_accounts a ON a.id = m.integration_account_id WHERE a.external_account_id=$1", [bot.id]))[0].n).toBe(2);
  });

  it("groups and edited messages create nothing; media is stored as a placeholder without a file URL or a download row", async () => {
    const bot = newBot();
    await connect(owner, ws, bot.token);
    const hk = hookFor(bot.token);
    const user = rnd();
    const group = tgPrivateText({ updateId: rnd(), userId: user, messageId: 1, text: "in a group" });
    (group.message.chat as { type: string }).type = "supergroup";
    await post(hk.path, group, hk.secret);
    await post(hk.path, { update_id: rnd(), edited_message: { message_id: 1, text: "edit" } }, hk.secret);
    await drain(bot.id);
    expect(await q("SELECT 1 FROM conversations c JOIN integration_accounts a ON a.id=c.integration_account_id WHERE a.external_account_id=$1", [bot.id])).toHaveLength(0);
    await post(hk.path, tgPrivateText({ updateId: rnd(), userId: user, messageId: 2, extra: { caption: "receipt", photo: [{ file_id: "FILEID" }] } }), hk.secret);
    await drain(bot.id);
    const [m] = await q("SELECT body, attachments FROM messages m JOIN integration_accounts a ON a.id = m.integration_account_id WHERE a.external_account_id=$1", [bot.id]);
    expect(m.body).toBe("receipt");
    expect(m.attachments).toEqual([{ type: "photo", url: null, fileId: "FILEID" }]);
    expect(await q("SELECT 1 FROM attachments WHERE provider_media_id = 'FILEID'")).toHaveLength(0);
  });

  it("blocking the bot marks the person unreachable (a reply is refused up front); writing again clears it", async () => {
    const c = await chat();
    await post(c.hk.path, tgMyChatMember({ updateId: rnd(), userId: c.user, status: "kicked" }), c.hk.secret);
    await drain(c.bot.id);
    expect((await q("SELECT contact_unreachable_at FROM conversations WHERE id=$1", [c.conv]))[0].contact_unreachable_at).not.toBeNull();
    const r = await call(owner, "POST", SEND(ws, c.conv), { clientMsgId: uuid(), body: "are you there" });
    expect(r.status).toBe(422);
    expect((await r.json()).error.code).toBe("not_reachable");
    expect(mock.state.sent.filter((s) => s.text === "are you there")).toHaveLength(0);
    await post(c.hk.path, tgPrivateText({ updateId: rnd(), userId: c.user, messageId: 2, text: "back" }), c.hk.secret);
    await drain(c.bot.id);
    expect((await q("SELECT contact_unreachable_at FROM conversations WHERE id=$1", [c.conv]))[0].contact_unreachable_at).toBeNull();
  });
});

describe("reply", () => {
  it("sends plain text through the mock, records the attempt, and has no reply window", async () => {
    const c = await chat(ws, rnd(), Math.floor(Date.now() / 1000) - 3 * 86400); // written 3 days ago: Telegram has no 24 hour window (UNVERIFIED)
    const res = await call(owner, "POST", SEND(ws, c.conv), { clientMsgId: uuid(), body: "Hi *Mina*, thanks" });
    expect(res.status).toBe(201);
    const { message } = await res.json();
    expect(message).toMatchObject({ deliveryState: "sent", body: "Hi *Mina*, thanks" });
    expect(mock.state.sent.at(-1)).toEqual({ chatId: String(c.user), text: "Hi *Mina*, thanks" });
    const [m] = await q("SELECT external_id FROM messages WHERE id=$1", [message.id]);
    expect(m.external_id).toMatch(new RegExp(`^${c.user}:\\d+$`));
    const [a] = await q("SELECT outcome, request_summary FROM outbound_attempts WHERE message_id=$1", [message.id]);
    expect(a.outcome).toBe("accepted");
    expect(a.request_summary).toMatchObject({ kind: "text", channel: "telegram", method: "telegram_bot" });
    expect(JSON.stringify(a)).not.toContain(c.bot.token);
    expect(violations).toEqual([]);
  });

  it("429 becomes a failed message coded telegram_rate_limited with retry_after kept on the attempt; nothing is retried", async () => {
    const c = await chat();
    let n = 0;
    withClient({ sendMessage: async () => { n++; throw new TelegramSendError("rejected", 429, 429, "telegram_rate_limited", 17); } });
    const { message } = await (await call(owner, "POST", SEND(ws, c.conv), { clientMsgId: uuid(), body: "too fast" })).json();
    expect(message).toMatchObject({ deliveryState: "failed", failureCode: "telegram_rate_limited" });
    expect(n).toBe(1);
    const [a] = await q("SELECT outcome, http_status, platform_error_code FROM outbound_attempts WHERE message_id=$1", [message.id]);
    expect(a).toMatchObject({ outcome: "rejected", http_status: 429, platform_error_code: "429/retry_after_17" });
  });

  it("403 (blocked) becomes failed with not_reachable; an ambiguous failure becomes unknown, never failed", async () => {
    const c = await chat();
    withClient({ sendMessage: async () => { throw new TelegramSendError("rejected", 403, 403, "not_reachable"); } });
    expect((await (await call(owner, "POST", SEND(ws, c.conv), { clientMsgId: uuid(), body: "x" })).json()).message).toMatchObject({ deliveryState: "failed", failureCode: "not_reachable" });
    withClient({ sendMessage: async () => { throw new TelegramSendError("ambiguous", null, null, "no_response"); } });
    expect((await (await call(owner, "POST", SEND(ws, c.conv), { clientMsgId: uuid(), body: "y" })).json()).message).toMatchObject({ deliveryState: "unknown", failureCode: "no_response" });
  });

  it("a replayed client id sends once; text over the limit is refused; a bot cannot start a chat", async () => {
    const c = await chat();
    const id = uuid();
    const before = mock.state.sent.length;
    await call(owner, "POST", SEND(ws, c.conv), { clientMsgId: id, body: "once" });
    await call(owner, "POST", SEND(ws, c.conv), { clientMsgId: id, body: "once" });
    expect(mock.state.sent.length - before).toBe(1);
    expect((await call(owner, "POST", SEND(ws, c.conv), { clientMsgId: uuid(), body: "x".repeat(2001) })).status).toBe(400);
    // A conversation only exists after an inbound message, so this state needs the triggers off (this transaction only): it proves the rule holds if a row ever lacks one.
    await q("BEGIN");
    await q("SET LOCAL session_replication_role = replica");
    await q("UPDATE conversations SET last_inbound_at = NULL WHERE id=$1", [c.conv]);
    await q("COMMIT");
    const r = await call(owner, "POST", SEND(ws, c.conv), { clientMsgId: uuid(), body: "first!" });
    expect(r.status).toBe(422);
    expect((await r.json()).error.code).toBe("no_chat");
  });

  it("tenancy: another workspace cannot reply into or read this conversation", async () => {
    const c = await chat();
    expect((await call(other, "POST", SEND(wsOther, c.conv), { clientMsgId: uuid(), body: "hijack" })).status).toBe(404);
    expect((await call(agent, "POST", SEND(ws, c.conv), { clientMsgId: uuid(), body: "agents may reply" })).status).toBe(201);
  });
});
