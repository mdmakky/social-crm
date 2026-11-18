import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { endpoints } from "@crm/contracts";
import { bootstrap, failure, ok, type Harness, type TestUser } from "./harness.ts";

// Enquiry vs lead (D310): computed from phone number (own, imported, channel-provided or detected) and lead rows. No data is written for the classification.
let h: Harness;
let owner: TestUser, agent: TestUser, viewer: TestUser, ownerB: TestUser;
let A = "", B = "";
const as = (u: TestUser) => h.clientFor(u);
const q = async (text: string, params: unknown[] = []) => (await h.admin.query(text, params)).rows;
let n = 0;
const mk = (name: string, extra: Record<string, unknown> = {}, ws = A, u = owner) => h.contact(as(u), ws, { name, email: `enq${n++}-${Date.now()}@example.com`, ...extra });
const list = async (query: Record<string, unknown> = {}, u = owner, ws = A) => ok(await as(u).call(endpoints.listContacts, { params: { workspaceId: ws }, query: { limit: 100, ...query } as never }));
const counts = async (query: Record<string, unknown> = {}, u = owner, ws = A) => ok(await as(u).call(endpoints.contactStageCounts, { params: { workspaceId: ws }, query: query as never }));
const names = async (query: Record<string, unknown>) => (await list(query)).items.map((x) => x.name).sort();
const addMethod = (c: { id: string }, value: string, source = "messenger", ws = A) => q("INSERT INTO contact_methods (workspace_id, contact_id, kind, value, source, confidence, verified, is_primary) VALUES ($1,$2,'phone',$3,$4,0.9,false,false)", [ws, c.id, value, source]);

beforeAll(async () => {
  h = await bootstrap();
  [owner, agent, viewer, ownerB] = (await Promise.all(["eno", "ena", "env", "enb"].map((l) => h.newUser(l)))) as [TestUser, TestUser, TestUser, TestUser];
  A = await h.workspace(owner, "ENQ A", { agent, viewer });
  B = await h.workspace(ownerB, "ENQ B");
});
afterAll(async () => { await h.close(); });

describe("classification", () => {
  it("no phone and no lead row: enquiry. Phone, detected phone, or a lead row: lead. A deleted detected phone makes it an enquiry again", async () => {
    const plain = await mk("Cls Plain");
    const own = await mk("Cls Phone", { phone: "+8801712345601" });
    const det = await mk("Cls Detected");
    await addMethod(det, "+8801712345602"); // a second detected number lives only in contact_methods
    const withLead = await mk("Cls LeadRow");
    ok(await as(owner).call(endpoints.putContactLead, { params: { workspaceId: A, contactId: withLead.id }, body: { valueMinor: 100, currency: "USD" } }));
    const gone = await mk("Cls Gone");
    await addMethod(gone, "+8801712345603");
    expect(await names({ search: "Cls " })).toEqual(["Cls Detected", "Cls Gone", "Cls LeadRow", "Cls Phone"]);
    expect(await names({ search: "Cls ", kind: "enquiry" })).toEqual(["Cls Plain"]);
    expect(await names({ search: "Cls ", kind: "all" })).toHaveLength(5);
    await q("DELETE FROM contact_methods WHERE contact_id = $1", [gone.id]);
    expect(await names({ search: "Cls ", kind: "enquiry" })).toEqual(["Cls Gone", "Cls Plain"]);
    const all = (await list({ search: "Cls ", kind: "all" })).items;
    expect(Object.fromEntries(all.map((x) => [x.name, x.isEnquiry]))).toEqual({ "Cls Plain": true, "Cls Gone": true, "Cls Phone": false, "Cls Detected": false, "Cls LeadRow": false });
    expect(ok(await as(owner).call(endpoints.getContact, { params: { workspaceId: A, contactId: plain.id } })).isEnquiry).toBe(true);
    expect(ok(await as(owner).call(endpoints.getContact, { params: { workspaceId: A, contactId: own.id } })).isEnquiry).toBe(false);
  });

  it("adding a phone through the API moves the person from enquiries to leads (New) and writes no lead row and no event", async () => {
    const c = await mk("Promo One");
    expect(await names({ search: "Promo ", kind: "enquiry" })).toEqual(["Promo One"]);
    ok(await as(owner).call(endpoints.updateContact, { params: { workspaceId: A, contactId: c.id }, body: { expectedVersion: c.version, phone: "01712345699" } }));
    expect(await names({ search: "Promo ", kind: "enquiry" })).toEqual([]);
    const l = await list({ search: "Promo " });
    expect(l.items.map((x) => x.name)).toEqual(["Promo One"]);
    expect(l.items[0]!.lead).toBeNull(); // virtual New
    const first = ok(await as(owner).call(endpoints.listPipelines, { params: { workspaceId: A } })).pipelines[0]!.stages.find((s) => s.kind === "open")!;
    expect((await list({ search: "Promo ", stageId: first.id })).total).toBe(1);
    expect(await q("SELECT 1 FROM leads WHERE primary_contact_id = $1", [c.id])).toHaveLength(0);
    expect(await q("SELECT 1 FROM domain_events WHERE entity_id = $1 AND type <> 'contact.created'", [c.id])).toHaveLength(0);
  });
});

describe("list, counts, export, owner counts agree", () => {
  it("default is leads only; stage counts add up to the lead list; enquiryCount matches kind=enquiry; filters apply to both", async () => {
    for (let i = 0; i < 3; i++) await mk(`Cnt Lead ${i}`, { phone: `+88017123457${10 + i}`, ownerUserId: agent.id });
    for (let i = 0; i < 4; i++) await mk(`Cnt Enq ${i}`, { ownerUserId: i < 2 ? agent.id : null });
    expect((await list({ search: "Cnt " })).total).toBe(3);
    const e = await list({ search: "Cnt ", kind: "enquiry" });
    expect(e.total).toBe(4);
    expect(e.items.every((x) => x.isEnquiry && x.lead === null && "conversation" in x)).toBe(true);
    const c = await counts({ search: "Cnt " });
    expect(c.total).toBe(3);
    expect(c.items.reduce((t, x) => t + x.count, 0)).toBe(3);
    expect(c.enquiryCount).toBe(4);
    expect((await counts({ search: "Cnt ", ownerId: agent.id })).enquiryCount).toBe(2);
    const own = async (kind?: string) => ok(await as(owner).call(endpoints.contactOwnerCounts, { params: { workspaceId: A }, query: { search: "Cnt ", ...(kind ? { kind } : {}) } as never })).items;
    expect((await own()).reduce((t, x) => t + x.count, 0)).toBe(3);
    expect((await own("enquiry")).reduce((t, x) => t + x.count, 0)).toBe(4);
    expect((await own("all")).reduce((t, x) => t + x.count, 0)).toBe(7);
    const csv = async (kind?: string) => ok(await as(owner).call(endpoints.exportContacts, { params: { workspaceId: A }, query: { search: "Cnt ", ...(kind ? { kind } : {}) } as never })).trim().split("\n").length - 1;
    expect(await csv()).toBe(3);
    expect(await csv("enquiry")).toBe(4);
  });

  it("pagination over a few hundred rows: no repeats or gaps for leads and for enquiries", async () => {
    for (let i = 0; i < 240; i++) await h.contact(as(owner), A, { name: `Pg ${String(i).padStart(3, "0")}`, ...(i % 2 ? { phone: `+8801555${String(100000 + i)}` } : {}) });
    for (const kind of ["lead", "enquiry"] as const) {
      const seen: string[] = [];
      let cursor: string | undefined;
      for (let i = 0; i < 20; i++) {
        const pg = await list({ search: "Pg ", kind, sort: "name", dir: "asc", limit: 25, cursor });
        seen.push(...pg.items.map((x) => x.id));
        expect(pg.total).toBe(120);
        cursor = pg.nextCursor ?? undefined;
        if (!cursor) break;
      }
      expect(new Set(seen).size).toBe(120);
      expect(seen).toHaveLength(120);
    }
  });
});

describe("what else depends on everyone", () => {
  it("search and the task picker (kind=all) still find enquiries; the default list does not", async () => {
    await mk("Findme Enquirer");
    const s = ok(await as(owner).call(endpoints.search, { params: { workspaceId: A }, query: { q: "Findme" } as never }));
    expect(JSON.stringify(s)).toContain("Findme Enquirer");
    expect(await names({ search: "Findme" })).toEqual([]);
    expect(await names({ search: "Findme", kind: "all" })).toEqual(["Findme Enquirer"]);
  });

  it("workspace isolation, viewer permissions and value hiding are unchanged", async () => {
    await mk("Iso A Enq");
    const b = await mk("Iso B Enq", {}, B, ownerB);
    expect((await list({ kind: "enquiry" }, ownerB, B)).items.map((x) => x.id)).toEqual([b.id]);
    expect((await counts({}, ownerB, B)).enquiryCount).toBe(1);
    expect(failure(await as(ownerB).call(endpoints.listContacts, { params: { workspaceId: A }, query: { kind: "enquiry" } as never })).status).toBe(404);
    expect((await list({ kind: "enquiry", search: "Iso A" }, viewer)).items).toHaveLength(1);
    const lead = await mk("Iso Valued", { phone: "+8801712345650" });
    ok(await as(owner).call(endpoints.putContactLead, { params: { workspaceId: A, contactId: lead.id }, body: { valueMinor: 5000, currency: "USD" } }));
    const seen = (await list({ search: "Iso Valued" }, viewer)).items[0]!;
    expect(seen.lead?.valueMinor).toBeNull();
    expect(seen.lead?.valueHidden).toBe(true);
    expect(failure(await as(viewer).call(endpoints.exportContacts, { params: { workspaceId: A }, query: { kind: "enquiry" } as never })).status).toBe(403);
  });

  it("an enquiry shows its latest conversation to roles with Inbox access", async () => {
    const c = await mk("Conv Enq");
    const acc = (await q("INSERT INTO integration_accounts (workspace_id, platform, external_account_id, display_name, status) VALUES ($1,'messenger',$2,'Page','connected') RETURNING id", [A, String(Date.now())]))[0];
    const ident = (await q("INSERT INTO platform_identities (workspace_id, integration_account_id, external_user_id, contact_id) VALUES ($1,$2,'1234567',$3) RETURNING id", [A, acc.id, c.id]))[0];
    const cv = (await q("INSERT INTO conversations (workspace_id, integration_account_id, identity_id, contact_id, last_message_at) VALUES ($1,$2,$3,$4,now()) RETURNING id", [A, acc.id, ident.id, c.id]))[0];
    await q("INSERT INTO messages (workspace_id, integration_account_id, conversation_id, seq, direction, sender_kind, body, delivery_state, external_id) VALUES ($1,$3,$2,1,'in','contact','hello there','received','m1')", [A, cv.id, acc.id]);
    const e = (await list({ search: "Conv Enq", kind: "enquiry" })).items[0]!;
    expect(e.conversation).toMatchObject({ id: cv.id, platform: "messenger", preview: "hello there", previewDirection: "in" });
  });
});
