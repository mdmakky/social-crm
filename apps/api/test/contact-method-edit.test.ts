import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { withContext } from "@crm/db";
import { bootstrap, type Harness, type TestUser } from "./harness.ts";

let h: Harness;
let owner: TestUser, admin: TestUser, agent: TestUser, viewer: TestUser, outsider: TestUser;
let ws: string;
let wsOther: string;
const q = async (text: string, params: unknown[] = []) => (await h.admin.query(text, params)).rows;
const req = (u: TestUser, method: string, path: string, body?: unknown) =>
  h.app.request(`/v1/workspaces/${path}`, { method, headers: { cookie: u.cookie, "content-type": "application/json", origin: "http://localhost:3000" }, body: body === undefined ? undefined : JSON.stringify(body) });

let n = 0;
/** A contact with detected methods inserted the way the worker leaves them. */
async function contact(opts: { phone?: string | null; email?: string | null } = {}) {
  const c = await h.contact(h.clientFor(owner), ws, { name: `CM Person ${n++}`, ...(opts.phone ? { phone: opts.phone } : {}), ...(opts.email ? { email: opts.email } : {}) });
  return c.id;
}
async function method(contactId: string, o: { kind?: string; value: string; source?: string; verified?: boolean; primary?: boolean }) {
  const [m] = await q("INSERT INTO contact_methods (workspace_id, contact_id, kind, value, source, confidence, verified, is_primary) VALUES ($1,$2,$3,$4,$5,0.9,$6,$7) RETURNING id", [ws, contactId, o.kind ?? "phone", o.value, o.source ?? "messenger", o.verified ?? false, o.primary ?? false]);
  return m.id as string;
}
const row = async (id: string) => (await q("SELECT * FROM contact_methods WHERE id = $1", [id]))[0];
const audit = (contactId: string, action: string) => q("SELECT actor_user_id, summary FROM audit_log WHERE entity_id = $1 AND action = $2 ORDER BY created_at", [contactId, action]);

beforeAll(async () => {
  h = await bootstrap();
  owner = await h.newUser("cmeo");
  admin = await h.newUser("cmea");
  agent = await h.newUser("cmeg");
  viewer = await h.newUser("cmev");
  outsider = await h.newUser("cmex");
  ws = await h.workspace(owner, "Method Edit", { admin, agent, viewer });
  wsOther = await h.workspace(outsider, "Method Other");
});
afterAll(async () => { await h.close(); });

describe("list detected methods", () => {
  it("members may read, a stranger gets 404", async () => {
    const c = await contact();
    await method(c, { value: "+8801712345678", primary: true });
    for (const u of [owner, admin, agent, viewer]) {
      const res = await req(u, "GET", `${ws}/contacts/${c}/methods`);
      expect(res.status).toBe(200);
      expect((await res.json()).items.map((m: { value: string }) => m.value)).toEqual(["+8801712345678"]);
    }
    expect((await req(outsider, "GET", `${ws}/contacts/${c}/methods`)).status).toBe(404);
    expect((await req(outsider, "GET", `${wsOther}/contacts/${c}/methods`)).status).toBe(404);
  });
});

describe("delete a detected method", () => {
  it("deletes it, audits without the value, attributes the actor, and an agent may", async () => {
    const c = await contact();
    const m = await method(c, { value: "+8801712345678" });
    const res = await req(agent, "DELETE", `${ws}/contacts/${c}/methods/${m}`);
    expect(res.status).toBe(204);
    expect(await row(m)).toBeUndefined();
    const [a] = await audit(c, "contact.method_deleted");
    expect(a.actor_user_id).toBe(agent.id);
    expect(a.summary).toMatchObject({ kind: "phone", source: "messenger", methodId: m });
    expect(JSON.stringify(a.summary)).not.toContain("1712");
  });
  it("clears the contact's auto-filled primary, but never a different value that is there now", async () => {
    const c1 = await contact();
    const m1 = await method(c1, { value: "+8801712345678", primary: true });
    await q("UPDATE contacts SET phone = '+8801712345678', phone_normalized = '+8801712345678' WHERE id = $1", [c1]);
    expect((await req(admin, "DELETE", `${ws}/contacts/${c1}/methods/${m1}`)).status).toBe(204);
    expect((await q("SELECT phone, phone_normalized FROM contacts WHERE id = $1", [c1]))[0]).toEqual({ phone: null, phone_normalized: null });

    const c2 = await contact();
    const m2 = await method(c2, { value: "+8801712345678", primary: true });
    await q("UPDATE contacts SET phone = '01999999999', phone_normalized = '01999999999' WHERE id = $1", [c2]); // a person has since entered another number
    expect((await req(admin, "DELETE", `${ws}/contacts/${c2}/methods/${m2}`)).status).toBe(204);
    expect((await q("SELECT phone FROM contacts WHERE id = $1", [c2]))[0].phone).toBe("01999999999");
  });
  it("refuses verified and manually entered rows (409) and leaves them intact", async () => {
    const c = await contact({ phone: "01712345678", email: "owner@shop.com" });
    const verified = await method(c, { value: "+8801555555555", verified: true });
    const manual = await method(c, { value: "+8801444444444", source: "manual" });
    const imported = await method(c, { kind: "email", value: "imp@shop.com", source: "import" });
    for (const id of [verified, manual, imported]) {
      const res = await req(owner, "DELETE", `${ws}/contacts/${c}/methods/${id}`);
      expect(res.status).toBe(409);
      expect((await res.json()).error.code).toBe("not_detected");
      expect(await row(id)).toBeTruthy();
      const patch = await req(owner, "PATCH", `${ws}/contacts/${c}/methods/${id}`, { value: "+8801333333333" });
      expect(patch.status).toBe(409);
    }
    expect((await q("SELECT phone, email FROM contacts WHERE id = $1", [c]))[0]).toEqual({ phone: "01712345678", email: "owner@shop.com" });
    expect(await audit(c, "contact.method_deleted")).toHaveLength(0);
  });
  it("viewers and strangers cannot delete; bad ids are 404", async () => {
    const c = await contact();
    const m = await method(c, { value: "+8801712345678" });
    expect((await req(viewer, "DELETE", `${ws}/contacts/${c}/methods/${m}`)).status).toBe(403);
    expect((await req(outsider, "DELETE", `${ws}/contacts/${c}/methods/${m}`)).status).toBe(404);
    expect((await req(outsider, "DELETE", `${wsOther}/contacts/${c}/methods/${m}`)).status).toBe(404);
    expect((await req(owner, "DELETE", `${ws}/contacts/${c}/methods/not-a-uuid`)).status).toBe(404);
    expect((await req(owner, "DELETE", `${ws}/contacts/${c}/methods/01a1d865-bad1-7e29-8209-6614e8d6d459`)).status).toBe(404);
    expect(await row(m)).toBeTruthy();
  });
});

describe("correct a detected method", () => {
  it("normalises a corrected phone, records who and when, drops the raw text, audits without values", async () => {
    const c = await contact();
    const m = await method(c, { value: "+8801712345678" });
    const res = await req(agent, "PATCH", `${ws}/contacts/${c}/methods/${m}`, { value: "01712-999888" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ id: m, value: "+8801712999888", verified: false, source: "messenger" });
    const r = await row(m);
    expect([r.corrected_by, r.raw_value, r.verified, r.source]).toEqual([agent.id, null, false, "messenger"]);
    expect(r.corrected_at).toBeTruthy();
    const [a] = await audit(c, "contact.method_corrected");
    expect(a.actor_user_id).toBe(agent.id);
    expect(JSON.stringify(a.summary)).not.toContain("999888");
  });
  it("corrects an email and rejects invalid values, duplicates and an already-entered value", async () => {
    const c = await contact({ phone: "01711111111", email: "entered@shop.com" });
    const m = await method(c, { kind: "email", value: "wrong@shop.com" });
    await method(c, { kind: "email", value: "other@shop.com" });
    expect((await (await req(admin, "PATCH", `${ws}/contacts/${c}/methods/${m}`, { value: "Right@Shop.com" })).json()).value).toBe("right@shop.com");
    expect((await req(admin, "PATCH", `${ws}/contacts/${c}/methods/${m}`, { value: "not an email" })).status).toBe(400);
    expect((await req(admin, "PATCH", `${ws}/contacts/${c}/methods/${m}`, { value: "other@shop.com" })).status).toBe(409);
    expect((await req(admin, "PATCH", `${ws}/contacts/${c}/methods/${m}`, { value: "entered@shop.com" })).status).toBe(409);
    const p = await method(c, { value: "+8801712345678" });
    expect((await req(admin, "PATCH", `${ws}/contacts/${c}/methods/${p}`, { value: "12345" })).status).toBe(400);
    expect((await req(admin, "PATCH", `${ws}/contacts/${c}/methods/${p}`, { value: "01711111111" })).status).toBe(409); // equals the entered phone in another form
    expect((await q("SELECT email FROM contacts WHERE id = $1", [c]))[0].email).toBe("entered@shop.com");
  });
  it("keeps the contact's auto-filled primary in step, and viewers cannot correct", async () => {
    const c = await contact();
    const m = await method(c, { value: "+8801712345678", primary: true });
    await q("UPDATE contacts SET phone = '+8801712345678', phone_normalized = '+8801712345678' WHERE id = $1", [c]);
    expect((await req(viewer, "PATCH", `${ws}/contacts/${c}/methods/${m}`, { value: "01812345678" })).status).toBe(403);
    expect((await req(owner, "PATCH", `${ws}/contacts/${c}/methods/${m}`, { value: "01812345678" })).status).toBe(200);
    expect((await q("SELECT phone_normalized FROM contacts WHERE id = $1", [c]))[0].phone_normalized).toBe("+8801812345678");
  });
});

describe("row level security (app role)", () => {
  it("another workspace's app role cannot update or delete detected methods; a member cannot touch verified rows or protected columns", async () => {
    const c = await contact();
    const m = await method(c, { value: "+8801712345678" });
    const v = await method(c, { value: "+8801555555555", verified: true });
    const asOutsider = (stmt: ReturnType<typeof sql>) => withContext(h.db, { userId: outsider.id, workspaceId: wsOther }, async (tx) => (await tx.execute(stmt)).rowCount);
    expect(await asOutsider(sql`UPDATE contact_methods SET value = '+8801000000000' WHERE id = ${m}`)).toBe(0);
    expect(await asOutsider(sql`DELETE FROM contact_methods WHERE id = ${m}`)).toBe(0);
    const asAgent = (stmt: ReturnType<typeof sql>) => withContext(h.db, { userId: agent.id, workspaceId: ws }, async (tx) => (await tx.execute(stmt)).rowCount);
    expect(await asAgent(sql`DELETE FROM contact_methods WHERE id = ${v}`)).toBe(0); // verified: invisible to the delete policy
    expect(await asAgent(sql`UPDATE contact_methods SET value = '+8801000000000' WHERE id = ${v}`)).toBe(0);
    await expect(asAgent(sql`UPDATE contact_methods SET verified = true WHERE id = ${m}`)).rejects.toThrow(); // no column grant
    await expect(asAgent(sql`UPDATE contact_methods SET source = 'manual' WHERE id = ${m}`)).rejects.toThrow();
    await expect(asAgent(sql`UPDATE contact_methods SET contact_id = ${c} WHERE id = ${m}`)).rejects.toThrow();
    await expect(asAgent(sql`INSERT INTO contact_methods (workspace_id, contact_id, kind, value, source) VALUES (${ws}, ${c}, 'phone', '+8801999999999', 'messenger')`)).rejects.toThrow(); // app role never inserts
    expect((await row(m)).value).toBe("+8801712345678");
    expect((await row(v)).value).toBe("+8801555555555");
  });
});
