import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { sql } from "drizzle-orm";
import { createDb, withContext, type Db } from "@crm/db";
import { buildMessagePayload, mockSecret, signedFixture } from "@crm/integrations";
import { metaWebhookRoutes } from "../src/inbox/webhook.ts";
import { processPending } from "../src/inbox/process.ts";
import { bootstrap, type Harness, type TestUser } from "./harness.ts";

const DB = process.env.CRM_DB_NAME ?? "crm";
let h: Harness;
let ingestDb: Db;
let workerDb: Db;
let hook: Hono;
let wsA: string;
let wsB: string;
let userB: TestUser;
const RUN = Math.random().toString(36).slice(2, 8);
let seq = 0;
const digits = () => `9${Math.floor(Math.random() * 1e12).toString().padStart(12, "0")}`;
const q = async (text: string, params: unknown[] = []) => (await h.admin.query(text, params)).rows;

const createdAccounts: string[] = [];
async function account(workspaceId: string, platform = "messenger") {
  const ref = digits();
  const [{ id }] = await q("INSERT INTO integration_accounts (workspace_id, platform, external_account_id, status) VALUES ($1,$2,$3,'connected') RETURNING id", [workspaceId, platform, ref]);
  createdAccounts.push(id as string);
  return { ref, id: id as string, platform };
}
async function drain() {
  for (let i = 0; i < 30; i++) {
    const r = await processPending(workerDb);
    if (r.processed + r.orphan + r.failed === 0) return;
  }
}
/** Real ingestion path: signed webhook -> ingress -> worker transaction. */
async function say(a: { ref: string; platform: string }, user: string, text: string, opts: { mid?: string; echo?: boolean } = {}) {
  const f = signedFixture(buildMessagePayload({ object: a.platform === "instagram" ? "instagram" : "page", accountId: a.ref, userId: user, mid: opts.mid ?? `${RUN}.${seq++}`, text, timestampMs: Date.now() + seq, echo: opts.echo }), mockSecret);
  const res = await hook.request(`/webhooks/meta/${a.platform}`, { method: "POST", body: new Uint8Array(f.raw), headers: { "content-type": "application/json", "x-hub-signature-256": f.signature } });
  expect(res.status).toBe(200);
  await drain();
}
const contactOf = async (accId: string, user: string) =>
  (await q("SELECT c.id, c.phone, c.phone_normalized, c.version FROM contacts c JOIN platform_identities pi ON pi.contact_id = c.id WHERE pi.integration_account_id = $1 AND pi.external_user_id = $2", [accId, user]))[0]!;
const methods = (contactId: string, kind = "phone") => q("SELECT * FROM contact_methods WHERE contact_id = $1 AND kind = $2 ORDER BY created_at, id", [contactId, kind]);
const audits = (contactId: string) => q("SELECT summary, actor_user_id FROM audit_log WHERE entity_id = $1 AND action = 'contact.method_extracted' ORDER BY created_at", [contactId]);

beforeAll(async () => {
  h = await bootstrap();
  ingestDb = createDb(`postgres://crm_ingest:ingest_dev@127.0.0.1:5436/${DB}`);
  workerDb = createDb(`postgres://crm_worker:worker_dev@127.0.0.1:5436/${DB}`);
  hook = new Hono().route("/webhooks/meta", metaWebhookRoutes({ appSecrets: [mockSecret], verifyToken: "v", ingestDb }));
  const a = await h.newUser("cma");
  userB = await h.newUser("cmb");
  [wsA, wsB] = [await h.workspace(a, "CM A"), await h.workspace(userB, "CM B")];
});
afterAll(async () => {
  // these accounts have no real token: mark them checked so the shared due-token job (meta-connect tests, LIMIT 100) is not crowded by them
  if (createdAccounts.length) await q("UPDATE integration_accounts SET last_token_check_at = now(), status = 'disabled' WHERE id = ANY($1::uuid[])", [createdAccounts]);
  await ingestDb.$client.end();
  await workerDb.$client.end();
  await h.close();
});

describe("phone extraction from Messenger messages (mock webhook -> real worker -> local database)", () => {
  it("saves a Bangladeshi number as an unverified contact method with provenance, fills the empty phone, and audits without the number", async () => {
    const a = await account(wsA);
    const u = digits();
    await say(a, u, "আমার নাম্বার 01712-345678, please call");
    const c = await contactOf(a.id, u);
    const [m] = await methods(c.id);
    expect(m).toMatchObject({ kind: "phone", value: "+8801712345678", raw_value: "01712-345678", source: "messenger", verified: false, is_primary: true, workspace_id: wsA });
    expect(Number(m.confidence)).toBeGreaterThanOrEqual(0.9);
    expect(m.source_conversation_id).toBeTruthy();
    expect(m.source_message_id).toBeTruthy();
    expect(m.extracted_at).toBeTruthy();
    expect([c.phone, c.phone_normalized]).toEqual(["+8801712345678", "+8801712345678"]);
    const au = await audits(c.id);
    expect(au).toHaveLength(1);
    expect(au[0].actor_user_id).toBeNull();
    expect(au[0].summary).toMatchObject({ kind: "phone", source: "messenger", primary: true });
    expect(JSON.stringify(au[0].summary)).not.toContain("1712");
  });

  it("is idempotent: a re-delivered webhook, a repeat and another written form add nothing", async () => {
    const a = await account(wsA);
    const u = digits();
    const mid = `${RUN}.same-mid`;
    await say(a, u, "01712345678", { mid });
    await say(a, u, "01712345678", { mid }); // duplicate delivery
    await say(a, u, "again 01712345678");
    await say(a, u, "or +880 1712-345678");
    const c = await contactOf(a.id, u);
    expect(await methods(c.id)).toHaveLength(1);
    expect(await audits(c.id)).toHaveLength(1);
  });

  it("keeps several numbers as separate methods; only the first becomes the primary", async () => {
    const a = await account(wsA);
    const u = digits();
    await say(a, u, "office 01712345678 and home +8801812345678");
    const c = await contactOf(a.id, u);
    const ms = await methods(c.id);
    expect(ms.map((m) => m.value).sort()).toEqual(["+8801712345678", "+8801812345678"]);
    expect(ms.filter((m) => m.is_primary).map((m) => m.value)).toEqual(["+8801712345678"]);
    expect(c.phone).toBe("+8801712345678");
    await say(a, u, "also +14155552671");
    expect((await methods(c.id)).map((m) => m.value)).toContain("+14155552671");
    expect((await contactOf(a.id, u)).phone).toBe("+8801712345678"); // the primary never moves by itself
  });

  it("never overwrites a phone a person entered, and does not duplicate it", async () => {
    const a = await account(wsA);
    const u = digits();
    await say(a, u, "hi");
    const c0 = await contactOf(a.id, u);
    await q("UPDATE contacts SET phone = '01712345678', phone_normalized = '01712345678' WHERE id = $1", [c0.id]); // entered by hand, national form
    await say(a, u, "my number is +8801712345678");
    expect(await methods(c0.id)).toHaveLength(0); // same number: the entered value stays the only record
    await say(a, u, "my other number 01998765432");
    const after = await contactOf(a.id, u);
    expect([after.phone, after.phone_normalized]).toEqual(["01712345678", "01712345678"]);
    const ms = await methods(c0.id);
    expect(ms.map((m) => [m.value, m.is_primary, m.verified])).toEqual([["+8801998765432", false, false]]);
  });

  it("never downgrades a verified method that already exists", async () => {
    const a = await account(wsA);
    const u = digits();
    await say(a, u, "hi");
    const c = await contactOf(a.id, u);
    await q("INSERT INTO contact_methods (workspace_id, contact_id, kind, value, source, confidence, verified, verified_at) VALUES ($1,$2,'phone','+8801712345678','manual',1,true,now())", [wsA, c.id]);
    await say(a, u, "01712345678");
    const ms = await methods(c.id);
    expect(ms).toHaveLength(1);
    expect([ms[0].source, ms[0].verified, Number(ms[0].confidence)]).toEqual(["manual", true, 1]);
    expect(await audits(c.id)).toHaveLength(0);
  });

  it("ignores malformed numbers, dates, quantities, the Page's own echoes, and non-text", async () => {
    const a = await account(wsA);
    const u = digits();
    await say(a, u, "price? qty 25, ref 123456, date 2026-11-14, +1111111111, 0171234");
    await say(a, u, "my number 01712345678", { echo: true }); // sent by the Page, not by the customer
    const c = await contactOf(a.id, u);
    expect(await methods(c.id)).toHaveLength(0);
    expect(c.phone).toBeNull();
  });

  it("extraction failure never blocks or fails message storage", async () => {
    const a = await account(wsA);
    const u = digits();
    await q("CREATE OR REPLACE FUNCTION cm_boom() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'boom'; END $$");
    await q("CREATE TRIGGER cm_boom_trg BEFORE INSERT ON contact_methods FOR EACH ROW EXECUTE FUNCTION cm_boom()");
    try {
      await say(a, u, "call 01712345678");
    } finally {
      await q("DROP TRIGGER cm_boom_trg ON contact_methods");
      await q("DROP FUNCTION cm_boom()");
    }
    const c = await contactOf(a.id, u);
    expect(await methods(c.id)).toHaveLength(0);
    expect((await q("SELECT count(*)::int n FROM messages WHERE integration_account_id = $1", [a.id]))[0].n).toBe(1);
    expect((await q("SELECT status FROM webhook_events WHERE account_ref = $1", [a.ref])).map((r) => r.status)).toEqual(["processed"]);
    await say(a, u, "retry 01712345678"); // and extraction recovers on the next message
    expect(await methods(c.id)).toHaveLength(1);
  });

  it("works for Instagram messages as well, with the right source", async () => {
    const a = await account(wsA, "instagram");
    const u = digits();
    await say(a, u, "whatsapp +8801812345678");
    const c = await contactOf(a.id, u);
    expect((await methods(c.id)).map((m) => [m.value, m.source])).toEqual([["+8801812345678", "instagram"]]);
  });
});

describe("email extraction (same pipeline, Slice 3)", () => {
  const emailsOf = (cid: string) => methods(cid, "email");
  const emailOf = async (cid: string) => (await q("SELECT email, email_normalized FROM contacts WHERE id = $1", [cid]))[0];

  it("saves an address as an unverified method with provenance, fills an empty email, audits without the address", async () => {
    const a = await account(wsA);
    const u = digits();
    await say(a, u, "my email: Rahim.Uddin@Example.com thanks");
    const c = await contactOf(a.id, u);
    const [m] = await emailsOf(c.id);
    expect(m).toMatchObject({ kind: "email", value: "rahim.uddin@example.com", raw_value: "Rahim.Uddin@Example.com", source: "messenger", verified: false, is_primary: true });
    expect(Number(m.confidence)).toBe(0.95);
    expect(m.source_message_id).toBeTruthy();
    expect(await emailOf(c.id)).toEqual({ email: "rahim.uddin@example.com", email_normalized: "rahim.uddin@example.com" });
    const au = await audits(c.id);
    expect(au).toHaveLength(1);
    expect(JSON.stringify(au[0].summary)).not.toContain("example.com");
  });

  it("is idempotent across re-delivery, repeats and different case", async () => {
    const a = await account(wsA);
    const u = digits();
    const mid = `${RUN}.email-mid`;
    await say(a, u, "a@b.com", { mid });
    await say(a, u, "a@b.com", { mid });
    await say(a, u, "again A@B.COM");
    const c = await contactOf(a.id, u);
    expect(await emailsOf(c.id)).toHaveLength(1);
    expect(await audits(c.id)).toHaveLength(1);
  });

  it("keeps several addresses separately; the first is primary and never moves", async () => {
    const a = await account(wsA);
    const u = digits();
    await say(a, u, "work a@b.com home c@d.org");
    await say(a, u, "also e@f.net");
    const c = await contactOf(a.id, u);
    const ms = await emailsOf(c.id);
    expect(ms.map((m) => m.value).sort()).toEqual(["a@b.com", "c@d.org", "e@f.net"]);
    expect(ms.filter((m) => m.is_primary).map((m) => m.value)).toEqual(["a@b.com"]);
    expect((await emailOf(c.id)).email).toBe("a@b.com");
  });

  it("never overwrites an entered email (nor a verified method) and does not duplicate it", async () => {
    const a = await account(wsA);
    const u = digits();
    await say(a, u, "hi");
    const c = await contactOf(a.id, u);
    await q("UPDATE contacts SET email = 'Owner@Shop.com', email_normalized = 'owner@shop.com' WHERE id = $1", [c.id]);
    await say(a, u, "reach me at owner@shop.com or other@shop.com");
    expect((await emailsOf(c.id)).map((m) => [m.value, m.is_primary, m.verified])).toEqual([["other@shop.com", false, false]]);
    expect((await emailOf(c.id)).email).toBe("Owner@Shop.com");
    await q("INSERT INTO contact_methods (workspace_id, contact_id, kind, value, source, confidence, verified, verified_at) VALUES ($1,$2,'email','vip@shop.com','manual',1,true,now())", [wsA, c.id]);
    await say(a, u, "vip@shop.com");
    const vip = (await emailsOf(c.id)).find((m) => m.value === "vip@shop.com");
    expect([vip.source, vip.verified, Number(vip.confidence)]).toEqual(["manual", true, 1]);
  });

  it("a message with a phone and an email stores both; junk and echoes store nothing", async () => {
    const a = await account(wsA);
    const u = digits();
    await say(a, u, "call 01712345678 or mail x@y.com");
    await say(a, u, "icon@2x.png, a@b, @c.com");
    await say(a, u, "reach us at team@page.com", { echo: true });
    const c = await contactOf(a.id, u);
    expect((await emailsOf(c.id)).map((m) => m.value)).toEqual(["x@y.com"]);
    expect((await methods(c.id)).map((m) => m.value)).toEqual(["+8801712345678"]);
  });

  it("the conversation detail API exposes methods with provenance to members only", async () => {
    const owner = await h.newUser("cmowner");
    const ws = await h.workspace(owner, "CM Detail");
    const a = await account(ws);
    const u = digits();
    await say(a, u, "01712345678 and a@b.com");
    const list = await h.app.request(`/v1/workspaces/${ws}/conversations`, { headers: { cookie: owner.cookie } });
    const conv = (await list.json()).items[0];
    const detail = await (await h.app.request(`/v1/workspaces/${ws}/conversations/${conv.id}`, { headers: { cookie: owner.cookie } })).json();
    const got = detail.contactSummary.methods.map((m: { kind: string; value: string; verified: boolean; source: string; isPrimary: boolean }) => [m.kind, m.value, m.verified, m.source, m.isPrimary]);
    expect(got).toEqual(expect.arrayContaining([["phone", "+8801712345678", false, "messenger", true], ["email", "a@b.com", false, "messenger", true]]));
    expect(detail.contactSummary.email).toBe("a@b.com");
    const stranger = await h.app.request(`/v1/workspaces/${ws}/conversations/${conv.id}`, { headers: { cookie: userB.cookie } });
    expect(stranger.status).toBe(404);
  });
});

describe("contact_methods isolation and database guards", () => {
  it("is invisible across workspaces (app role) and to the worker outside its workspace context", async () => {
    const a = await account(wsA);
    const u = digits();
    await say(a, u, "01712345678");
    const c = await contactOf(a.id, u);
    const asB = await withContext(h.db, { userId: userB.id, workspaceId: wsB }, (tx) => tx.execute(sql`SELECT * FROM contact_methods WHERE contact_id = ${c.id}`));
    expect((asB as { rows: unknown[] }).rows).toHaveLength(0);
    const workerB = await withContext(workerDb, { workspaceId: wsB }, (tx) => tx.execute(sql`SELECT * FROM contact_methods WHERE contact_id = ${c.id}`));
    expect((workerB as { rows: unknown[] }).rows).toHaveLength(0);
    // the app role can never insert, and its delete/update reach only detected rows of its own workspace (migration 0023)
    const deleted = await withContext(h.db, { userId: userB.id, workspaceId: wsB }, async (tx) => (await tx.execute(sql`DELETE FROM contact_methods WHERE contact_id = ${c.id}`)).rowCount);
    expect(deleted).toBe(0);
    expect(await methods(c.id)).toHaveLength(1);
  });

  it("the worker cannot write a verified method, a foreign workspace, or replace an entered phone/email", async () => {
    const a = await account(wsA);
    const u = digits();
    await say(a, u, "hello");
    const c = await contactOf(a.id, u);
    await q("UPDATE contacts SET phone = '+8801555555555', phone_normalized = '+8801555555555', email = 'x@y.example', email_normalized = 'x@y.example' WHERE id = $1", [c.id]);
    const attempt = (stmt: ReturnType<typeof sql>, ws = wsA) => withContext(workerDb, { workspaceId: ws }, (tx) => tx.execute(stmt));
    const cause = async (p: Promise<unknown>) => ((await p.then(() => null, (e: Error & { cause?: Error }) => e))?.cause?.message ?? "did not throw");
    await expect(attempt(sql`INSERT INTO contact_methods (workspace_id, contact_id, kind, value, source, verified) VALUES (${wsA}, ${c.id}, 'phone', '+8801711111111', 'messenger', true)`)).rejects.toThrow();
    await expect(attempt(sql`INSERT INTO contact_methods (workspace_id, contact_id, kind, value, source) VALUES (${wsA}, ${c.id}, 'phone', '+8801711111111', 'manual')`)).rejects.toThrow();
    await expect(attempt(sql`INSERT INTO contact_methods (workspace_id, contact_id, kind, value, source) VALUES (${wsA}, ${c.id}, 'phone', '+8801711111111', 'messenger')`, wsB)).rejects.toThrow();
    expect(await cause(attempt(sql`UPDATE contacts SET phone = '+8801000000000', phone_normalized = '+8801000000000' WHERE id = ${c.id}`))).toMatch(/empty phone/);
    expect(await cause(attempt(sql`UPDATE contacts SET email = 'evil@y.example', email_normalized = 'evil@y.example' WHERE id = ${c.id}`))).toMatch(/empty email/);
    await expect(attempt(sql`UPDATE contact_methods SET verified = true`)).rejects.toThrow();
    const after = (await q("SELECT phone, email FROM contacts WHERE id = $1", [c.id]))[0];
    expect(after).toEqual({ phone: "+8801555555555", email: "x@y.example" });
  });
});
