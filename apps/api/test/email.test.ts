import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { createDb, type Db } from "@crm/db";
import { buildMockInbound, EmailSendError, MockEmailProvider, MOCK_SIGNING_KEY, randomToken, signMailgun, supportAddress, tokenOfMessageId } from "@crm/integrations";
import type { EmailDeps } from "../src/inbox/email-connect.ts";
import { emailWebhookRoutes } from "../src/inbox/email-webhook.ts";
import { processPending } from "../src/inbox/process.ts";
import { bootstrap, type Harness, type TestUser } from "./harness.ts";

// Email channel, MOCK provider only: proves our pipeline (verify, store, route by token, thread, send headers, failure mapping), not Mailgun's behaviour (UNVERIFIED).
const DB = process.env.CRM_DB_NAME ?? "crm";
const IN = "in.example.test";
const OUT = "mail.example.test";
let h: Harness, workerDb: Db, ingestDb: Db, hook: Hono, provider: MockEmailProvider, deps: EmailDeps;
let owner: TestUser, agent: TestUser, viewer: TestUser, other: TestUser;
let ws: string, wsB: string, tokA: string, tokB: string;
const q = async (text: string, params: unknown[] = []) => (await h.admin.query(text, params)).rows;
const api = (u: TestUser, method: string, path: string, body?: unknown) =>
  h.app.request(path, { method, headers: { cookie: u.cookie, origin: "http://localhost:3000", "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
const post = (fields: Record<string, string>) => hook.request("/webhooks/email/inbound", { method: "POST", body: new URLSearchParams(fields) });
const tokenOf = (address: string) => /support\+([a-z2-7]{20})@/.exec(address)![1]!;
const drain = async () => { await processPending(workerDb, 200); };
let n = 0;
const mid = () => `m${Date.now()}${n++}@example.org`;
/** One inbound mail to a workspace, processed. */
async function inbound(tok: string, o: Partial<Parameters<typeof buildMockInbound>[0]> = {}) {
  const messageId = o.messageId ?? mid();
  expect((await post(buildMockInbound({ recipient: supportAddress(tok, IN), ...o, messageId }))).status).toBe(200);
  await drain();
  return messageId;
}
const convByMsg = async (messageId: string, tok: string) => (await q("SELECT m.conversation_id AS id, m.body, c.contact_id, i.external_user_id FROM email_message_meta em JOIN messages m ON m.id = em.message_id JOIN conversations c ON c.id = m.conversation_id JOIN platform_identities i ON i.id = c.identity_id WHERE em.header_message_id = $1 AND em.integration_account_id = (SELECT id FROM integration_accounts WHERE platform='email' AND external_account_id=$2)", [messageId, tok]))[0];
const SEND = (w: string, c: string) => `/v1/workspaces/${w}/conversations/${c}/messages`;
const reply = (w: string, conv: string, text = "We can help with that.") => api(owner, "POST", SEND(w, conv), { clientMsgId: crypto.randomUUID(), body: text });
const lastMail = () => provider.outbox[provider.outbox.length - 1]!;

beforeAll(async () => {
  workerDb = createDb(`postgres://crm_worker:worker_dev@127.0.0.1:5436/${DB}`);
  ingestDb = createDb(`postgres://crm_ingest:ingest_dev@127.0.0.1:5436/${DB}`);
  provider = new MockEmailProvider();
  deps = { provider, workerDb, inboundDomain: IN, sendingDomain: OUT, mock: true };
  hook = new Hono().route("/webhooks/email", emailWebhookRoutes({ signingKeys: [MOCK_SIGNING_KEY], inboundDomain: IN, ingestDb }));
  h = await bootstrap(undefined, undefined, undefined, undefined, undefined, deps);
  [owner, agent, viewer, other] = (await Promise.all(["emowner", "emagent", "emviewer", "emother"].map((l) => h.newUser(l)))) as [TestUser, TestUser, TestUser, TestUser];
  ws = await h.workspace(owner, "Acme Support", { agent, viewer });
  wsB = await h.workspace(other, "Other Co");
  for (const [w, u] of [[ws, owner], [wsB, other]] as const) expect((await api(u, "POST", `/v1/workspaces/${w}/integrations/email/connect`, {})).status).toBe(200);
  tokA = tokenOf(((await (await api(owner, "GET", `/v1/workspaces/${ws}/integrations/email`)).json()) as { account: { supportAddress: string } }).account.supportAddress);
  tokB = tokenOf(((await (await api(other, "GET", `/v1/workspaces/${wsB}/integrations/email`)).json()) as { account: { supportAddress: string } }).account.supportAddress);
});
afterAll(async () => {
  await q("UPDATE integration_accounts SET status = 'disabled' WHERE platform = 'email' AND external_account_id = ANY($1::text[])", [[tokA, tokB]]);
  await workerDb.$client.end();
  await ingestDb.$client.end();
  await h.close();
});

describe("connect (MOCK)", () => {
  it("owner connects, gets an unguessable support address and DNS steps; a second connect is the same account", async () => {
    const r = await (await api(owner, "POST", `/v1/workspaces/${ws}/integrations/email/connect`, {})).json() as { mock: boolean; provider: string; account: { supportAddress: string; fromAddress: string; displayName: string; enabled: boolean; setupStatus: string }; dns: { id: string }[] };
    expect(r).toMatchObject({ mock: true, provider: "mock", account: { supportAddress: supportAddress(tokA, IN), fromAddress: `support@${OUT}`, displayName: "Acme Support", enabled: true, setupStatus: "unchecked" } });
    expect(r.dns.map((d) => d.id)).toEqual(["mx", "spf", "dkim", "dmarc"]);
    expect(tokA).toMatch(/^[a-z2-7]{20}$/);
    expect(tokA).not.toBe(tokB);
    expect(await q("SELECT count(*)::int AS n FROM integration_accounts WHERE workspace_id = $1 AND platform = 'email'", [ws])).toEqual([{ n: 1 }]);
  });
  it("only integration.manage connects; agents can look, viewers cannot; the Meta list never shows the email account", async () => {
    expect((await api(agent, "POST", `/v1/workspaces/${ws}/integrations/email/connect`, {})).status).toBe(403);
    expect((await api(viewer, "POST", `/v1/workspaces/${ws}/integrations/email/check-setup`)).status).toBe(403);
    expect((await api(agent, "GET", `/v1/workspaces/${ws}/integrations/email`)).status).toBe(200);
    expect((await api(viewer, "GET", `/v1/workspaces/${ws}/integrations/email`)).status).toBe(403); // integration.view excludes viewers, same as the Meta panel
    expect(((await (await api(owner, "GET", `/v1/workspaces/${ws}/integrations/meta`)).json()) as { accounts: unknown[] }).accounts).toEqual([]);
  });
  it("check setup returns canned MOCK results and is audited", async () => {
    const r = await (await api(owner, "POST", `/v1/workspaces/${ws}/integrations/email/check-setup`)).json() as { mock: boolean; checks: { id: string; ok: boolean; message: string }[]; state: { account: { setupStatus: string } } };
    expect(r.mock).toBe(true);
    expect(r.checks.every((c) => c.message.startsWith("Mock result"))).toBe(true);
    expect(r.state.account.setupStatus).toBe("verified");
    expect((await q("SELECT action FROM audit_log WHERE workspace_id = $1 AND action LIKE 'integration.email.%' ORDER BY created_at", [ws])).map((a) => a.action)).toEqual(expect.arrayContaining(["integration.email.connected", "integration.email.setup_checked"]));
  });
});

describe("signature, replay, size", () => {
  it("a valid signature is stored; a bad key, bad signature and stale timestamp get 403 and store no body", async () => {
    const before = Number((await q("SELECT count(*) AS n FROM webhook_events WHERE platform = 'email'"))[0].n);
    const good = buildMockInbound({ recipient: supportAddress(tokA, IN), messageId: mid() });
    expect((await post(good)).status).toBe(200);
    expect((await post(buildMockInbound({ recipient: supportAddress(tokA, IN), key: "wrong-key-wrong-key" }))).status).toBe(403);
    expect((await post({ ...buildMockInbound({ recipient: supportAddress(tokA, IN) }), signature: "0".repeat(64) })).status).toBe(403);
    expect((await post(buildMockInbound({ recipient: supportAddress(tokA, IN), timestamp: Math.floor(Date.now() / 1000) - 7200 }))).status).toBe(403);
    expect((await hook.request("/webhooks/email/inbound", { method: "POST", body: "garbage" })).status).toBe(403);
    const rows = await q("SELECT status, raw_body FROM webhook_events WHERE platform = 'email' ORDER BY received_at DESC LIMIT 10");
    expect(Number((await q("SELECT count(*) AS n FROM webhook_events WHERE platform = 'email' AND status = 'received'"))[0].n)).toBeGreaterThanOrEqual(1);
    expect(rows.filter((r) => r.status === "rejected").every((r) => r.raw_body === null)).toBe(true);
    expect(Number((await q("SELECT count(*) AS n FROM webhook_events WHERE platform = 'email'"))[0].n)).toBeGreaterThan(before);
    await drain();
  });
  it("a replayed request (same token) is acknowledged and stored once", async () => {
    const f = buildMockInbound({ recipient: supportAddress(tokA, IN), messageId: mid() });
    expect((await post(f)).status).toBe(200);
    const r2 = await post(f);
    expect(r2.status).toBe(200);
    expect(await r2.text()).toBe("duplicate");
    expect(Number((await q("SELECT count(*) AS n FROM webhook_events WHERE convert_from(raw_body,'utf8') LIKE $1", [`%${/<(.+)>/.exec(JSON.parse(f["message-headers"]!)[2][1])![1]}%`]))[0].n)).toBe(1);
    await drain();
  });
  it("a body over 1 MB is refused", async () => {
    const r = await hook.request("/webhooks/email/inbound", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "a=" + "x".repeat(1_100_000) });
    expect(r.status).toBe(413);
  });
});

describe("inbound: conversations, contacts, text only", () => {
  it("a customer email becomes a conversation, a contact with an email method and a plain-text message with its subject", async () => {
    const id = await inbound(tokA, { from: "Ada Lovelace <ada@example.org>", subject: "Order 42", text: "Where is my order?" });
    const c = await convByMsg(id, tokA);
    expect(c).toMatchObject({ body: "Where is my order?", external_user_id: "email:ada@example.org" });
    const [ct] = await q("SELECT name, source, email FROM contacts WHERE id = $1", [c.contact_id]);
    expect(ct).toMatchObject({ name: "Ada Lovelace", source: "email", email: "ada@example.org" });
    expect(await q("SELECT kind, value, source, verified FROM contact_methods WHERE contact_id = $1", [c.contact_id])).toEqual([{ kind: "email", value: "ada@example.org", source: "email", verified: false }]);
    const msgs = await (await api(owner, "GET", `/v1/workspaces/${ws}/conversations/${c.id}/messages`)).json() as { items: { body: string; email: { subject: string; fromAddress: string; unverifiedSender: boolean } }[] };
    expect(msgs.items[0]!.email).toMatchObject({ subject: "Order 42", fromAddress: "ada@example.org", unverifiedSender: false });
    const det = await (await api(owner, "GET", `/v1/workspaces/${ws}/conversations/${c.id}`)).json() as { platform: string; replyWindow: string; email: { address: string; unverifiedSender: boolean } };
    expect(det).toMatchObject({ platform: "email", replyWindow: "open", email: { address: "ada@example.org", unverifiedSender: false } });
  });
  it("a second mail from the same verified sender goes to the same conversation; quoted text is stripped", async () => {
    const a = await inbound(tokA, { from: "grace@example.org", text: "first" });
    const b = await inbound(tokA, { from: "grace@example.org", text: "second\n\nOn Mon, Jan 1, 2026, Support wrote:\n> old stuff" });
    const [ca, cb] = [await convByMsg(a, tokA), await convByMsg(b, tokA)];
    expect(cb.id).toBe(ca.id);
    expect(cb.body).toBe("second");
  });
  it("HTML never reaches storage: an HTML-only mail becomes a placeholder, scripts are not kept", async () => {
    const id = mid();
    const f = buildMockInbound({ recipient: supportAddress(tokA, IN), messageId: id, text: "", html: "<img src=x onerror=alert(1)><script>evil()</script>" });
    f["body-plain"] = "";
    await post(f);
    await drain();
    const c = await convByMsg(id, tokA);
    expect(c.body).toContain("no plain text part");
    const ev = await q("SELECT convert_from(raw_body,'utf8') AS b FROM webhook_events WHERE convert_from(raw_body,'utf8') LIKE $1", [`%${id}%`]);
    expect(ev[0].b).not.toMatch(/script|onerror|<img/);
  });
  it("attachments are not stored, only counted with names and sizes (multipart)", async () => {
    const id = mid();
    const fd = new FormData();
    for (const [k, v] of Object.entries(buildMockInbound({ recipient: supportAddress(tokA, IN), messageId: id, attachments: 2 }))) fd.set(k, v);
    fd.set("attachment-1", new File(["%PDF-1.4 fake"], "invoice.pdf", { type: "application/pdf" }));
    fd.set("attachment-2", new File(["MZ"], "run.exe", { type: "application/octet-stream" }));
    expect((await hook.request("/webhooks/email/inbound", { method: "POST", body: fd })).status).toBe(200);
    await drain();
    const c = await convByMsg(id, tokA);
    const msgs = await (await api(owner, "GET", `/v1/workspaces/${ws}/conversations/${c.id}/messages`)).json() as { items: { email: { attachmentCount: number; attachmentsNotStored: { name: string; size: number }[] } }[] };
    expect(msgs.items.at(-1)!.email.attachmentCount).toBe(2);
    expect(msgs.items.at(-1)!.email.attachmentsNotStored).toEqual([{ name: "invoice.pdf", size: 13 }, { name: "run.exe", size: 2 }]);
    expect(await q("SELECT 1 FROM attachments WHERE conversation_id = $1", [c.id])).toEqual([]);
  });
  it("auto-generated mail is dropped and recorded as ignored with a reason", async () => {
    const id = mid();
    await inbound(tokA, { messageId: id, from: "robot@example.org", extraHeaders: [["Auto-Submitted", "auto-replied"]] });
    expect(await convByMsg(id, tokA)).toBeUndefined();
    const [ev] = await q("SELECT status, last_error FROM webhook_events WHERE convert_from(raw_body,'utf8') LIKE $1", [`%${id}%`]);
    expect(ev).toEqual({ status: "processed", last_error: "ignored:auto_submitted" });
    for (const [extra, reason] of [[[["Precedence", "bulk"]], "precedence"], [[["List-Id", "<l.example.org>"]], "mailing_list"]] as const) {
      const x = mid();
      await inbound(tokA, { messageId: x, extraHeaders: extra.map((e) => [...e] as [string, string]) });
      expect((await q("SELECT last_error FROM webhook_events WHERE convert_from(raw_body,'utf8') LIKE $1", [`%${x}%`]))[0].last_error).toBe(`ignored:${reason}`);
    }
    const y = mid();
    await inbound(tokA, { messageId: y, from: "Mailer-Daemon <mailer-daemon@example.org>", sender: "" });
    expect((await q("SELECT last_error FROM webhook_events WHERE convert_from(raw_body,'utf8') LIKE $1", [`%${y}%`]))[0].last_error).toMatch(/^ignored:(empty_return_path|automated_sender)$/);
  });
  it("the same Message-ID twice (a provider retry with a new token) makes one message", async () => {
    const id = mid();
    await inbound(tokA, { messageId: id, from: "once@example.org" });
    await inbound(tokA, { messageId: id, from: "once@example.org" });
    expect(Number((await q("SELECT count(*) AS n FROM messages WHERE external_id = $1", [id]))[0].n)).toBe(1);
  });
  it("our own address is never turned into a conversation (mail loop)", async () => {
    const id = mid();
    await inbound(tokA, { messageId: id, from: `support@${OUT}` });
    expect(await convByMsg(id, tokA)).toBeUndefined();
  });
});

describe("routing: the workspace comes only from the verified recipient token", () => {
  it("an unknown token is an orphan, nothing is created; a recipient without a token is an unrouted orphan", async () => {
    const ghost = randomToken(20);
    const id = mid();
    await inbound(ghost, { messageId: id, from: "ghost@example.org" });
    const [ev] = await q("SELECT status, last_error, workspace_id FROM webhook_events WHERE account_ref = $1", [ghost]);
    expect(ev).toEqual({ status: "orphan", last_error: "unknown_account", workspace_id: null });
    expect(await q("SELECT 1 FROM messages WHERE external_id = $1", [id])).toEqual([]);
    expect((await post(buildMockInbound({ recipient: `support@${IN}` }))).status).toBe(200);
    expect((await post(buildMockInbound({ recipient: `support+${tokA}@elsewhere.test` }))).status).toBe(200);
    await drain();
    const bare = await q("SELECT status, workspace_id, last_error FROM webhook_events WHERE account_ref IS NULL AND platform = 'email' AND status = 'orphan'");
    expect(bare.length).toBeGreaterThanOrEqual(2);
    expect(bare.every((r) => r.workspace_id === null)).toBe(true);
  });
  it("a mail to workspace B's token never lands in A, even when it names A's messages and conversation token", async () => {
    const inA = await inbound(tokA, { from: "iso@example.org", subject: "Private A" });
    const conv = await convByMsg(inA, tokA);
    const [thread] = await q("SELECT conv_token FROM email_threads WHERE conversation_id = $1", [conv.id]);
    const sneaky = mid();
    await inbound(tokB, { messageId: sneaky, from: "attacker@example.org", inReplyTo: inA, references: [inA] });
    const viaToken = mid();
    expect((await post(buildMockInbound({ recipient: supportAddress(tokB, IN, thread.conv_token), messageId: viaToken, from: "attacker@example.org" }))).status).toBe(200);
    await drain();
    for (const m of [sneaky, viaToken]) {
      const c = await convByMsg(m, tokB);
      expect(c).toBeTruthy();
      expect(c.id).not.toBe(conv.id);
      expect((await q("SELECT workspace_id FROM conversations WHERE id = $1", [c.id]))[0].workspace_id).toBe(wsB);
    }
    expect(await q("SELECT 1 FROM messages WHERE conversation_id = $1 AND external_id = ANY($2::text[])", [conv.id, [sneaky, viaToken]])).toEqual([]);
    expect(((await (await api(other, "GET", `/v1/workspaces/${wsB}/conversations/${conv.id}`)).json()) as { error?: unknown }).error).toBeTruthy();
  });
});

describe("threading and outbound headers (mock provider)", () => {
  let conv: string, inId: string, outId: string, convTok: string;
  it("a reply from the inbox sends the right headers and is recorded as sent", async () => {
    inId = await inbound(tokA, { from: "Bea <bea@example.org>", subject: "RE: Re: Delivery", text: "Is it shipped?" });
    conv = (await convByMsg(inId, tokA)).id;
    convTok = (await q("SELECT conv_token FROM email_threads WHERE conversation_id = $1", [conv]))[0].conv_token;
    const r = await reply(ws, conv, "Yes, today.");
    expect(r.status).toBe(201);
    const body = await r.json() as { message: { deliveryState: string; failureCode: string | null } };
    expect(body.message).toMatchObject({ deliveryState: "sent", failureCode: null });
    const m = lastMail();
    expect(m).toMatchObject({ from: { name: "Acme Support", address: `support@${OUT}` }, to: "bea@example.org", replyTo: supportAddress(tokA, IN, convTok), subject: "Re: Delivery", text: "Yes, today.", inReplyTo: inId, autoSubmitted: "no" });
    expect(m.references).toEqual([inId]);
    expect(m.messageId).toMatch(/^crm\.[a-z2-7]{20}\.[a-z2-7]{16}@mail\.example\.test$/);
    expect(tokenOfMessageId(m.messageId)).toBe(tokA);
    outId = m.messageId;
    const [row] = await q("SELECT delivery_state, external_id FROM messages WHERE conversation_id = $1 AND direction = 'out'", [conv]);
    expect(row).toEqual({ delivery_state: "sent", external_id: outId });
    expect((await q("SELECT outcome, request_summary FROM outbound_attempts WHERE message_id = (SELECT id FROM messages WHERE conversation_id = $1 AND direction = 'out')", [conv]))[0]).toMatchObject({ outcome: "accepted", request_summary: { channel: "email", method: "email_mock" } });
  });
  it("the next reply carries the whole chain; one Re: only", async () => {
    await reply(ws, conv, "Anything else?");
    const m = lastMail();
    expect(m.subject).toBe("Re: Delivery");
    expect(m.references).toEqual([inId, outId]);
    expect(m.inReplyTo).toBe(inId);
  });
  it("In-Reply-To to our message threads a reply from a DIFFERENT address into the conversation; References and the Reply-To token do too", async () => {
    const a = await inbound(tokA, { from: "bea.work@example.org", inReplyTo: outId, text: "forwarded answer" });
    expect((await convByMsg(a, tokA)).id).toBe(conv);
    const b = await inbound(tokA, { from: "bea.other@example.org", references: ["unrelated@x", outId] });
    expect((await convByMsg(b, tokA)).id).toBe(conv);
    const c = mid();
    expect((await post(buildMockInbound({ recipient: supportAddress(tokA, IN, convTok), messageId: c, from: "bea.third@example.org" }))).status).toBe(200);
    await drain();
    expect((await convByMsg(c, tokA)).id).toBe(conv);
  });
  it("the subject alone never threads", async () => {
    const x = await inbound(tokA, { from: "stranger@example.org", subject: "Re: Delivery" });
    expect((await convByMsg(x, tokA)).id).not.toBe(conv);
  });
  it("reply goes to the conversation's own identity, never the From of a threaded message", async () => {
    await reply(ws, conv, "To Bea only.");
    expect(lastMail().to).toBe("bea@example.org");
  });
  it("failure mapping: rejected -> failed with the code; ambiguous -> unknown and never retried", async () => {
    provider.next.push(new EmailSendError("rejected", 401, "provider_auth"));
    const failed = await (await reply(ws, conv, "x1")).json() as { message: { deliveryState: string; failureCode: string } };
    expect(failed.message).toMatchObject({ deliveryState: "failed", failureCode: "provider_auth" });
    const sent = provider.outbox.length;
    provider.next.push(new EmailSendError("ambiguous", 503, "provider_unavailable"));
    const unknown = await (await reply(ws, conv, "x2")).json() as { message: { deliveryState: string; failureCode: string } };
    expect(unknown.message).toMatchObject({ deliveryState: "unknown", failureCode: "provider_unavailable" });
    expect(provider.outbox.length).toBe(sent); // nothing was sent twice, nothing retried
    expect((await q("SELECT outcome FROM outbound_attempts WHERE message_id IN (SELECT id FROM messages WHERE conversation_id = $1 AND delivery_state IN ('failed','unknown')) ORDER BY started_at", [conv])).map((r) => r.outcome)).toEqual(["rejected", "ambiguous"]);
  });
  it("viewers cannot reply; email turned off refuses a reply", async () => {
    expect((await api(viewer, "POST", SEND(ws, conv), { clientMsgId: crypto.randomUUID(), body: "no" })).status).toBe(403);
    await api(owner, "POST", `/v1/workspaces/${ws}/integrations/email/enabled`, { enabled: false });
    const r = await reply(ws, conv);
    expect(r.status).toBe(409);
    expect(((await r.json()) as { error: { code: string } }).error.code).toBe("account_not_connected");
    // inbound while off is stored as an orphan, never processed
    const off = mid();
    await inbound(tokA, { messageId: off });
    expect((await q("SELECT status, last_error FROM webhook_events WHERE convert_from(raw_body,'utf8') LIKE $1", [`%${off}%`]))[0]).toEqual({ status: "orphan", last_error: "account_disabled" });
    await api(owner, "POST", `/v1/workspaces/${ws}/integrations/email/enabled`, { enabled: true });
  });
});

describe("unverified senders", () => {
  it("a failed SPF/DKIM verdict gets its own identity and badge, cannot join a customer's thread by From, and cannot be replied to", async () => {
    const real = await inbound(tokA, { from: "victim@example.org", text: "real mail" });
    const forged = await inbound(tokA, { from: "victim@example.org", text: "forged mail", spf: "Fail", dkim: "None" });
    const [cr, cf] = [await convByMsg(real, tokA), await convByMsg(forged, tokA)];
    expect(cr.external_user_id).toBe("email:victim@example.org");
    expect(cf.external_user_id).toBe("email-unverified:victim@example.org");
    expect(cf.id).not.toBe(cr.id);
    expect(cf.contact_id).not.toBe(cr.contact_id);
    expect(await q("SELECT 1 FROM contact_methods WHERE contact_id = $1", [cf.contact_id])).toEqual([]);
    const msgs = await (await api(owner, "GET", `/v1/workspaces/${ws}/conversations/${cf.id}/messages`)).json() as { items: { email: { unverifiedSender: boolean } }[] };
    expect(msgs.items[0]!.email.unverifiedSender).toBe(true);
    expect(((await (await api(owner, "GET", `/v1/workspaces/${ws}/conversations/${cf.id}`)).json()) as { email: { unverifiedSender: boolean } }).email.unverifiedSender).toBe(true);
    const r = await reply(ws, cf.id);
    expect(r.status).toBe(422);
    expect(((await r.json()) as { error: { code: string } }).error.code).toBe("sender_unverified");
  });
  it("an unverified mail may join a thread only by In-Reply-To, and is flagged there", async () => {
    const a = await inbound(tokA, { from: "carl@example.org" });
    const c = await convByMsg(a, tokA);
    await reply(ws, c.id);
    const out = lastMail().messageId;
    const x = await inbound(tokA, { from: "carl@example.org", spf: "SoftFail", inReplyTo: out });
    expect((await convByMsg(x, tokA)).id).toBe(c.id);
    expect((await q("SELECT unverified_sender FROM email_message_meta WHERE header_message_id = $1", [x]))[0].unverified_sender).toBe(true);
  });
});

describe("bounces and complaints (event shape UNVERIFIED)", () => {
  const event = (o: { messageId: string; event?: string; severity?: string; key?: string; timestamp?: number }) => {
    const timestamp = String(o.timestamp ?? Math.floor(Date.now() / 1000));
    const token = randomToken(40);
    return { signature: { timestamp, token, signature: signMailgun(timestamp, token, o.key ?? MOCK_SIGNING_KEY) }, "event-data": { event: o.event ?? "failed", severity: o.severity ?? "permanent", reason: "mailbox does not exist", message: { headers: { "message-id": o.messageId } } } };
  };
  const postEvent = (b: unknown) => hook.request("/webhooks/email/events", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) });
  it("a permanent failure marks the contact's email undeliverable, shows it, and stops further replies", async () => {
    const id = await inbound(tokA, { from: "gone@example.org", text: "hello" });
    const c = await convByMsg(id, tokA);
    await reply(ws, c.id);
    const out = lastMail().messageId;
    expect((await postEvent(event({ messageId: `<${out}>`, key: "wrong-key-wrong-key" }))).status).toBe(403);
    expect((await postEvent(event({ messageId: `<${out}>`, severity: "temporary" }))).status).toBe(200);
    await drain();
    expect((await q("SELECT undeliverable_at FROM contact_methods WHERE contact_id = $1", [c.contact_id]))[0].undeliverable_at).toBeNull();
    expect((await postEvent(event({ messageId: `<${out}>` }))).status).toBe(200);
    await drain();
    expect((await q("SELECT undeliverable_at, undeliverable_reason FROM contact_methods WHERE contact_id = $1", [c.contact_id]))[0]).toMatchObject({ undeliverable_reason: "bounce" });
    const det = await (await api(owner, "GET", `/v1/workspaces/${ws}/conversations/${c.id}`)).json() as { email: { undeliverable: boolean }; contactSummary: { methods: { undeliverable?: boolean }[] } };
    expect(det.email.undeliverable).toBe(true);
    expect(det.contactSummary.methods[0]!.undeliverable).toBe(true);
    const r = await reply(ws, c.id);
    expect(r.status).toBe(422);
    expect(((await r.json()) as { error: { code: string } }).error.code).toBe("address_undeliverable");
  });
  it("an event for another workspace's message id, or an unknown one, changes nothing", async () => {
    const id = await inbound(tokB, { from: "b-customer@example.org" });
    const c = await convByMsg(id, tokB);
    await api(other, "POST", SEND(wsB, c.id), { clientMsgId: crypto.randomUUID(), body: "hi" });
    const outB = lastMail().messageId;
    // routed by the token inside the id: a forged id carrying A's token but B's random part finds no message in A
    const forged = outB.replace(tokB, tokA);
    expect((await postEvent(event({ messageId: forged }))).status).toBe(200);
    expect((await postEvent(event({ messageId: "foreign@example.org" }))).status).toBe(200);
    await drain();
    expect((await q("SELECT undeliverable_at FROM contact_methods WHERE contact_id = $1", [c.contact_id]))[0].undeliverable_at).toBeNull();
  });
});

describe("rate limits", () => {
  it("per sender: beyond the limit mail is acknowledged and dropped", async () => {
    const small = new Hono().route("/webhooks/email", emailWebhookRoutes({ signingKeys: [MOCK_SIGNING_KEY], inboundDomain: IN, ingestDb, limits: { perKeyPerWindow: 600, failedPerKeyPerWindow: 20, rejectedRowsPerWindow: 200, perSenderPerHour: 2, windowMs: 60_000 } }));
    const ids: string[] = [];
    for (let i = 0; i < 4; i++) {
      const id = mid();
      ids.push(id);
      expect((await small.request("/webhooks/email/inbound", { method: "POST", body: new URLSearchParams(buildMockInbound({ recipient: supportAddress(tokA, IN), messageId: id, from: "flood@example.org" })) })).status).toBe(200);
    }
    await drain();
    expect(Number((await q("SELECT count(*) AS n FROM messages WHERE external_id = ANY($1::text[])", [ids]))[0].n)).toBe(2);
  });
  it("per conversation: a flood into one thread is stored as ignored", async () => {
    const first = await inbound(tokA, { from: "loop@example.org" });
    const c = await convByMsg(first, tokA);
    await q("INSERT INTO messages (workspace_id, conversation_id, integration_account_id, direction, external_id, sender_kind, body, delivery_state) SELECT $1, $2, integration_account_id, 'in', 'flood-' || g, 'contact', 'x', 'received' FROM conversations, generate_series(1, 61) g WHERE id = $2", [ws, c.id]);
    const over = mid();
    await inbound(tokA, { from: "loop@example.org", messageId: over });
    expect((await q("SELECT last_error FROM webhook_events WHERE convert_from(raw_body,'utf8') LIKE $1", [`%${over}%`]))[0].last_error).toBe("ignored:conversation_rate_limited");
  });
});
