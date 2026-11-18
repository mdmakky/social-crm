import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSecretBox } from "@crm/integrations";
import { endpoints, type ContactDetail, type PipelineDto } from "@crm/contracts";
import type { MetaConnectDeps } from "../src/inbox/meta-connect.ts";
import { bootstrap, failure, ok, type Harness, type TestUser } from "./harness.ts";

// One contact = one lead in the UI (D260): primary lead, virtual first stage, lazy creation through the existing lead code, counts that match the list.
const box = createSecretBox({ k1: Buffer.alloc(32, 9).toString("base64") }, "k1");
let h: Harness;
let owner: TestUser, agent: TestUser, viewer: TestUser, ownerB: TestUser;
let A = "", B = "";
let pipe: PipelineDto, reasonId = "";
const as = (u: TestUser) => h.clientFor(u);
const q = async (text: string, params: unknown[] = []) => (await h.admin.query(text, params)).rows;
const open = () => pipe.stages.filter((s) => s.kind === "open");
const won = () => pipe.stages.find((s) => s.kind === "won")!;
const lost = () => pipe.stages.find((s) => s.kind === "lost")!;
let seq = 0;
const mk = (name: string, ws = A, u = owner) => h.contact(as(u), ws, { name, email: `cl${seq++}-${Date.now()}@example.com` });
const put = (c: { id: string }, body: Record<string, unknown>, u = owner, ws = A) => as(u).call(endpoints.putContactLead, { params: { workspaceId: ws, contactId: c.id }, body: body as never });
const list = async (query: Record<string, unknown> = {}, u = owner, ws = A) => ok(await as(u).call(endpoints.listContacts, { params: { workspaceId: ws }, query: { limit: 100, ...query } as never }));
const counts = async (query: Record<string, unknown> = {}, u = owner, ws = A) => ok(await as(u).call(endpoints.contactStageCounts, { params: { workspaceId: ws }, query: query as never }));
const leadOf = async (c: { id: string }, u = owner) => ok(await as(u).call(endpoints.getContactLead, { params: { workspaceId: A, contactId: c.id } })).lead;
const code = (r: Parameters<typeof failure>[0]) => (failure(r) as unknown as { code: string }).code;
const mkLead = async (c: { id: string }, extra: Record<string, unknown> = {}) => ok(await as(owner).call(endpoints.createLead, { params: { workspaceId: A }, body: { title: "Deal", primaryContactId: c.id, allowDuplicate: true, ...extra } as never }));
const leadCount = async (c: { id: string }) => Number((await q("SELECT count(*) AS n FROM leads WHERE primary_contact_id=$1", [c.id]))[0].n);

beforeAll(async () => {
  h = await bootstrap({ capiCreatesPerUser: 1000 }, { box } as unknown as MetaConnectDeps);
  [owner, agent, viewer, ownerB] = (await Promise.all(["clo", "cla", "clv", "clb"].map((l) => h.newUser(l)))) as [TestUser, TestUser, TestUser, TestUser];
  A = await h.workspace(owner, "CL A", { agent, viewer });
  B = await h.workspace(ownerB, "CL B");
  const cfg = ok(await as(owner).call(endpoints.listPipelines, { params: { workspaceId: A } }));
  pipe = cfg.pipelines[0]!;
  reasonId = cfg.lostReasons[0]!.id;
});
afterAll(async () => { await h.close(); });

describe("list and counts", () => {
  it("a contact without a lead has lead:null and counts under the default pipeline's first stage; a lead shows its stage; counts match the list", async () => {
    const [a, b, c] = [await mk("Lazy A"), await mk("Lazy B"), await mk("Lazy C")];
    ok(await put(b, { stageId: open()[1]!.id }));
    ok(await put(c, { stageId: won().id, valueMinor: 9000, currency: "USD" }));
    const all = await list({ search: "Lazy " });
    const by = Object.fromEntries(all.items.map((x) => [x.name, x.lead]));
    expect(by["Lazy A"]).toBeNull();
    expect(by["Lazy B"]).toMatchObject({ stageId: open()[1]!.id, stageKind: "open", moreCount: 0 });
    expect(by["Lazy C"]).toMatchObject({ stageId: won().id, stageKind: "won", valueMinor: 9000, currency: "USD", valueHidden: false });
    const first = await list({ search: "Lazy ", stageId: open()[0]!.id });
    expect(first.items.map((x) => x.name)).toEqual(["Lazy A"]); // the virtual first stage
    expect(first.total).toBe(1);
    expect((await list({ search: "Lazy ", stageId: open()[1]!.id })).items.map((x) => x.name)).toEqual(["Lazy B"]);
    // counts equal the list under every stage, and add up to the total
    const cn = await counts({ search: "Lazy " });
    expect(cn.total).toBe(3);
    for (const s of pipe.stages) expect(cn.items.find((x) => x.stageId === s.id)?.count ?? 0).toBe((await list({ search: "Lazy ", stageId: s.id })).total);
    expect(a.id).toBeTruthy();
  });

  it("whole-workspace counts add up to the contact total (no lead included)", async () => {
    const total = (await list()).total;
    expect((await counts()).total).toBe(total);
    expect((await counts()).items.reduce((t, x) => t + x.count, 0)).toBe(total);
  });

  it("sorts by stage and value, with a cursor that never repeats or skips a row", async () => {
    const tag = `Srt${Date.now()}`;
    const cs = [];
    for (let i = 0; i < 5; i++) cs.push(await mk(`${tag} ${i}`));
    ok(await put(cs[0]!, { valueMinor: 500, currency: "USD" }));
    ok(await put(cs[1]!, { valueMinor: 100, currency: "USD", stageId: open()[1]!.id }));
    ok(await put(cs[2]!, { valueMinor: 300, currency: "USD", stageId: open()[2]!.id }));
    for (const sort of ["value", "stage"] as const) {
      for (const dir of ["asc", "desc"] as const) {
        const seen: string[] = [];
        let cursor: string | undefined;
        for (let i = 0; i < 6; i++) {
          const pg = await list({ search: tag, sort, dir, limit: 2, cursor });
          seen.push(...pg.items.map((x) => x.id));
          cursor = pg.nextCursor ?? undefined;
          if (!cursor) break;
        }
        expect(new Set(seen).size).toBe(5);
        expect(seen).toHaveLength(5);
      }
    }
    const byValue = (await list({ search: tag, sort: "value", dir: "desc" })).items.map((x) => x.lead?.valueMinor ?? 0);
    expect(byValue).toEqual([500, 300, 100, 0, 0]);
    expect(failure(await as(owner).call(endpoints.listContacts, { params: { workspaceId: A }, query: { sort: "value", cursor: Buffer.from(JSON.stringify({ k: "x'", id: cs[0]!.id, sort: "value", dir: "desc" })).toString("base64url") } as never })).status).toBe(400);
  });

  it("export honours the stage filter", async () => {
    const tag = `Exp${Date.now()}`;
    const x = await mk(`${tag} one`), y = await mk(`${tag} two`);
    ok(await put(y, { stageId: open()[2]!.id }));
    const csv = ok(await as(owner).call(endpoints.exportContacts, { params: { workspaceId: A }, query: { search: tag, stageId: open()[2]!.id } as never })) as unknown as string;
    expect(csv).toContain(`${tag} two`);
    expect(csv).not.toContain(`${tag} one`);
    expect(x.id).toBeTruthy();
  });
});

describe("PUT /contacts/:id/lead", () => {
  it("creates the lead lazily (201, default pipeline, first stage), then moves it with expectedVersion", async () => {
    const c = await mk("Put One");
    expect(await leadCount(c)).toBe(0);
    const r = ok(await put(c, { valueMinor: 1500, currency: "USD" }));
    expect(r.created).toBe(true);
    expect(r.lead).toMatchObject({ stageId: open()[0]!.id, valueMinor: 1500, version: 1, moreCount: 0 });
    expect(await leadCount(c)).toBe(1);
    const lead = ok(await as(owner).call(endpoints.getLead, { params: { workspaceId: A, leadId: r.lead.id } }));
    expect(lead).toMatchObject({ title: "Put One", pipelineId: pipe.id, outcome: "open" });
    const m = ok(await put(c, { expectedVersion: 1, stageId: open()[1]!.id }));
    expect(m.created).toBe(false);
    expect(m.lead).toMatchObject({ stageId: open()[1]!.id, version: 2 });
    expect(await leadCount(c)).toBe(1);
    const tr = ok(await as(owner).call(endpoints.listLeadTransitions, { params: { workspaceId: A, leadId: r.lead.id } }));
    expect(tr.items).toHaveLength(2);
  });

  it("version conflict is 409, missing expectedVersion on an existing lead is 400, a lost stage needs a reason (and rolls the lazy create back)", async () => {
    const c = await mk("Put Two");
    const r = ok(await put(c, { stageId: open()[1]!.id }));
    expect(code(await put(c, { expectedVersion: 99, stageId: open()[2]!.id }))).toBe("version_conflict");
    expect(failure(await put(c, { stageId: open()[2]!.id })).status).toBe(400);
    expect(await leadOf(c)).toMatchObject({ stageId: open()[1]!.id, version: r.lead.version });
    const d = await mk("Put Three");
    expect(code(await put(d, { stageId: lost().id }))).toBe("lost_reason_required");
    expect(await leadCount(d)).toBe(0); // nothing half-created
    ok(await put(d, { stageId: lost().id, lostReasonId: reasonId }));
    expect(await leadOf(d)).toMatchObject({ stageKind: "lost" });
  });

  it("value and owner update the existing lead; a failed move undoes the value change", async () => {
    const c = await mk("Put Four");
    const r = ok(await put(c, { valueMinor: 100, currency: "USD", ownerUserId: agent.id }));
    expect(r.lead).toMatchObject({ ownerId: agent.id, valueMinor: 100 });
    const u = ok(await put(c, { expectedVersion: 1, valueMinor: 250, currency: "USD" }));
    expect(u.lead).toMatchObject({ valueMinor: 250, version: 2 });
    expect(code(await put(c, { expectedVersion: 2, valueMinor: 999, currency: "USD", stageId: lost().id }))).toBe("lost_reason_required");
    expect(await leadOf(c)).toMatchObject({ valueMinor: 250, version: 2 });
    expect(failure(await put(c, { expectedVersion: 2, valueMinor: 5 })).status).toBe(0); // value without currency is refused by the contract
  });

  it("same stage is a no-op (no version bump); unknown or foreign ids are 404", async () => {
    const c = await mk("Put Five");
    const r = ok(await put(c, { stageId: open()[1]!.id }));
    const same = ok(await put(c, { expectedVersion: r.lead.version, stageId: open()[1]!.id }));
    expect(same).toMatchObject({ created: false, lead: { version: r.lead.version } });
    const bobB = await mk("Bob B", B, ownerB);
    expect(failure(await put(bobB, { stageId: open()[1]!.id })).status).toBe(404);
    expect(failure(await put({ id: "00000000-0000-4000-8000-000000000000" }, { stageId: open()[1]!.id })).status).toBe(404);
    expect(await q("SELECT 1 FROM leads WHERE primary_contact_id=$1", [bobB.id])).toHaveLength(0);
  });

  it("stage of another workspace is refused", async () => {
    const c = await mk("Put Six");
    const cfgB = ok(await as(ownerB).call(endpoints.listPipelines, { params: { workspaceId: B } }));
    expect(failure(await put(c, { stageId: cfgB.pipelines[0]!.stages[0]!.id })).status).toBe(400);
    expect(await leadCount(c)).toBe(0);
  });

  it("permissions: viewers cannot write; an agent cannot see or set a value; sorting by value is owner/admin only", async () => {
    const c = await mk("Put Seven");
    expect(failure(await put(c, { stageId: open()[1]!.id }, viewer)).status).toBe(403);
    const r = ok(await put(c, { stageId: open()[1]!.id }, agent));
    expect(r.lead).toMatchObject({ valueMinor: null, valueHidden: true });
    expect(failure(await put(c, { expectedVersion: r.lead.version, valueMinor: 5, currency: "USD" }, agent)).status).toBe(403);
    ok(await put(c, { expectedVersion: r.lead.version, valueMinor: 700, currency: "USD" }, owner));
    expect((await leadOf(c, agent))).toMatchObject({ valueMinor: null, valueHidden: true });
    expect((await list({ search: "Put Seven" }, agent)).items[0]!.lead).toMatchObject({ valueMinor: null, valueHidden: true });
    expect(failure(await as(agent).call(endpoints.listContacts, { params: { workspaceId: A }, query: { sort: "value" } as never })).status).toBe(403);
    ok(await as(viewer).call(endpoints.contactStageCounts, { params: { workspaceId: A }, query: {} as never })); // viewers may read counts
  });

  it("value access grant: only owner/admin manage it; a granted agent sees the value in list and detail, revoking hides it again; a lead removed and restored keeps its grant", async () => {
    const c = await mk("Grant Eight");
    const lead = ok(await put(c, { stageId: open()[1]!.id, valueMinor: 800, currency: "USD" })).lead;
    const gp = { workspaceId: A, leadId: lead.id };
    expect(failure(await as(agent).call(endpoints.listLeadValueGrants, { params: gp })).status).toBe(403);
    expect(failure(await as(agent).call(endpoints.setLeadValueGrant, { params: { ...gp, userId: agent.id }, body: { canEdit: false } })).status).toBe(403);
    expect((await leadOf(c, agent))).toMatchObject({ valueMinor: null, valueHidden: true });
    ok(await as(owner).call(endpoints.setLeadValueGrant, { params: { ...gp, userId: agent.id }, body: { canEdit: false } }));
    expect((await leadOf(c, agent))).toMatchObject({ valueMinor: 800, valueHidden: false });
    expect((await list({ search: "Grant Eight" }, agent)).items[0]!.lead).toMatchObject({ valueMinor: 800, valueHidden: false });
    ok(await as(owner).call(endpoints.removeLeadValueGrant, { params: { ...gp, userId: agent.id } }));
    expect((await leadOf(c, agent))).toMatchObject({ valueMinor: null, valueHidden: true });
    expect((await list({ search: "Grant Eight" }, agent)).items[0]!.lead).toMatchObject({ valueMinor: null, valueHidden: true });
  });

  it("remove from pipeline and restore: owner only, the contact stays, the stage comes back", async () => {
    const c = await mk("Remove Nine");
    const lead = ok(await put(c, { stageId: open()[1]!.id, valueMinor: 900, currency: "USD" })).lead;
    expect(failure(await as(agent).call(endpoints.deleteLead, { params: { workspaceId: A, leadId: lead.id }, query: { expectedVersion: lead.version } })).status).toBe(403);
    const del = ok(await as(owner).call(endpoints.deleteLead, { params: { workspaceId: A, leadId: lead.id }, query: { expectedVersion: lead.version } }));
    expect(await leadOf(c)).toBeNull();
    expect(failure(await as(agent).call(endpoints.listLeads, { params: { workspaceId: A }, query: { deleted: "true" } as never })).status).toBe(403);
    const gone = ok(await as(owner).call(endpoints.listLeads, { params: { workspaceId: A }, query: { deleted: "true" } as never }));
    expect(gone.items.map((x) => x.id)).toContain(lead.id);
    ok(await as(owner).call(endpoints.restoreLead, { params: { workspaceId: A, leadId: lead.id }, body: { expectedVersion: del.version } }));
    expect(await leadOf(c)).toMatchObject({ id: lead.id, stageId: open()[1]!.id, valueMinor: 900 });
  });

  it("two parallel first writes create one lead", async () => {
    const c = await mk("Race");
    const rs = await Promise.all([put(c, { stageId: open()[1]!.id }), put(c, { stageId: open()[1]!.id })]);
    expect(rs.filter((r) => r.ok)).toHaveLength(1);
    expect(await leadCount(c)).toBe(1);
  });
});

describe("existing duplicates: one primary lead", () => {
  it("the most recent OPEN lead wins; older and closed leads only add to moreCount; nothing is deleted or merged", async () => {
    const c = await mk("Dupe One");
    const oldWon = await mkLead(c, { title: "old" });
    ok(await as(owner).call(endpoints.moveLead, { params: { workspaceId: A, leadId: oldWon.id }, body: { expectedVersion: oldWon.version, stageId: won().id } as never }));
    const open1 = await mkLead(c, { title: "open1", stageId: open()[1]!.id });
    const open2 = await mkLead(c, { title: "open2", stageId: open()[2]!.id });
    const l = (await list({ search: "Dupe One" })).items[0]!.lead!;
    expect(l).toMatchObject({ id: open2.id, stageId: open()[2]!.id, moreCount: 2 });
    expect(await leadCount(c)).toBe(3);
    // a stage write moves the primary lead only
    ok(await put(c, { expectedVersion: open2.version, stageId: open()[3]?.id ?? open()[0]!.id }));
    expect(ok(await as(owner).call(endpoints.getLead, { params: { workspaceId: A, leadId: open1.id } })).stageId).toBe(open()[1]!.id);
    expect(await leadCount(c)).toBe(3);
    // counted once, under its primary lead's stage
    expect((await counts({ search: "Dupe One" })).total).toBe(1);
  });

  it("with only closed leads the most recent one is shown; a deleted lead does not count", async () => {
    const c = await mk("Dupe Two");
    const a = await mkLead(c, { title: "a" });
    const b = await mkLead(c, { title: "b" });
    ok(await as(owner).call(endpoints.moveLead, { params: { workspaceId: A, leadId: a.id }, body: { expectedVersion: a.version, stageId: won().id } as never }));
    ok(await as(owner).call(endpoints.moveLead, { params: { workspaceId: A, leadId: b.id }, body: { expectedVersion: b.version, stageId: lost().id, lostReasonId: reasonId } as never }));
    expect((await leadOf(c))).toMatchObject({ id: b.id, stageKind: "lost", moreCount: 1 });
    ok(await as(owner).call(endpoints.deleteLead, { params: { workspaceId: A, leadId: b.id }, query: { expectedVersion: 2 } as never }));
    expect((await leadOf(c))).toMatchObject({ id: a.id, stageKind: "won", moreCount: 0 });
  });
});

describe("bulk stage", () => {
  it("creates leads lazily, moves existing ones, reports unchanged, and isolates failures per contact", async () => {
    const [n, e, s] = [await mk("Bulk New"), await mk("Bulk Existing"), await mk("Bulk Same")];
    ok(await put(e, { stageId: open()[0]!.id }));
    ok(await put(s, { stageId: open()[2]!.id }));
    const r = ok(await as(owner).call(endpoints.bulkContactStage, { params: { workspaceId: A }, body: { contactIds: [n.id, e.id, s.id], stageId: open()[2]!.id } }));
    expect(r.results.map((x) => x.code)).toEqual(["created", "ok", "unchanged"]);
    expect((await leadOf(n))!.stageId).toBe(open()[2]!.id);
    const lostBulk = ok(await as(owner).call(endpoints.bulkContactStage, { params: { workspaceId: A }, body: { contactIds: [n.id, (await mk("Bulk Fresh")).id], stageId: lost().id } }));
    expect(lostBulk.results.map((x) => x.code)).toEqual(["lost_reason_required", "lost_reason_required"]);
    expect(await q("SELECT 1 FROM leads l JOIN contacts c ON c.id=l.primary_contact_id WHERE c.name='Bulk Fresh'")).toHaveLength(0);
    expect(failure(await as(viewer).call(endpoints.bulkContactStage, { params: { workspaceId: A }, body: { contactIds: [n.id], stageId: open()[1]!.id } })).status).toBe(403);
    expect(failure(await as(owner).call(endpoints.bulkContactStage, { params: { workspaceId: A }, body: { contactIds: Array.from({ length: 101 }, () => n.id), stageId: open()[1]!.id } as never })).status).toBe(0); // contract: max 100
  });

  it("a contact of another workspace is not found and untouched", async () => {
    const bobB = await mk("Bulk Bob", B, ownerB);
    const r = ok(await as(owner).call(endpoints.bulkContactStage, { params: { workspaceId: A }, body: { contactIds: [bobB.id], stageId: open()[1]!.id } }));
    expect(r.results[0]).toMatchObject({ ok: false, code: "not_found" });
    expect(await q("SELECT 1 FROM leads WHERE primary_contact_id=$1", [bobB.id])).toHaveLength(0);
  });
});

describe("tenancy of the list and counts", () => {
  it("workspace B never sees A's leads or counts", async () => {
    const bb = await mk("Only B", B, ownerB);
    const lb = await list({}, ownerB, B);
    expect(lb.items.every((x) => x.name !== "Lazy A")).toBe(true);
    expect(lb.items.find((x) => x.id === bb.id)!.lead).toBeNull();
    const cfgB = ok(await as(ownerB).call(endpoints.listPipelines, { params: { workspaceId: B } }));
    const cB = await counts({}, ownerB, B);
    expect(cB.items.every((x) => cfgB.pipelines.some((p) => p.stages.some((s) => s.id === x.stageId)))).toBe(true);
    expect(failure(await as(ownerB).call(endpoints.listContacts, { params: { workspaceId: A }, query: {} as never })).status).toBe(404);
  });
});

describe("CAPI keeps firing through the existing lead code", () => {
  const TOKEN = "EAAB-secret-token-" + "q".repeat(40);
  let dsSeq = 0;
  const bare = async () => {
    const d = ok(await as(owner).call(endpoints.createCapiDataset, { params: { workspaceId: A }, body: { datasetId: `7${Date.now()}${dsSeq++}`, name: "Main", accessToken: TOKEN, events: [] } as never }));
    await q("DELETE FROM capi_event_mappings WHERE dataset_id=$1", [d.id]);
    return d;
  };
  const map = (dsUuid: string, m: Record<string, unknown>) => as(owner).call(endpoints.createCapiMapping, { params: { workspaceId: A, datasetId: dsUuid }, body: { stageId: null, valueMode: "lead_value", fixedValueMinor: null, currency: null, enabled: true, ...m } as never });
  const events = async (ds: string) => (await q("SELECT * FROM capi_events WHERE dataset_id=$1 ORDER BY id", [ds])).map((r) => r.event_name as string).sort();
  const consent = async (c: ContactDetail) => ok(await as(owner).call(endpoints.setAdConsent, { params: { workspaceId: A, contactId: c.id }, body: { status: "granted", source: "manual" } }));

  it("lazy creation fires created and first-stage rules; a later stage move and the won move fire theirs, once each, with the lead value", async () => {
    const d = await bare();
    ok(await map(d.id, { triggerType: "lead_created", eventName: "Lead", valueMode: "none" }));
    ok(await map(d.id, { triggerType: "lead_stage_entered", stageId: open()[1]!.id, eventName: "Schedule", valueMode: "none" }));
    ok(await map(d.id, { triggerType: "lead_won", eventName: "Purchase" }));
    const c = await mk("Capi One"); await consent(c);
    expect(await events(d.id)).toEqual([]); // looking at the contact creates nothing
    await list({ search: "Capi One" });
    expect(await events(d.id)).toEqual([]);
    const r = ok(await put(c, { valueMinor: 4200, currency: "USD" })); // first write: the lead is created
    expect(await events(d.id)).toEqual(["Lead"]);
    const m = ok(await put(c, { expectedVersion: r.lead.version, stageId: open()[1]!.id }));
    expect(await events(d.id)).toEqual(["Lead", "Schedule"]);
    ok(await put(c, { expectedVersion: m.lead.version, stageId: won().id }));
    expect(await events(d.id)).toEqual(["Lead", "Purchase", "Schedule"]);
    const [pv] = await q("SELECT payload FROM capi_events WHERE dataset_id=$1 AND event_name='Purchase'", [d.id]);
    expect(pv.payload.custom_data).toEqual({ value: 42, currency: "USD" });
  });

  it("a contact without a lead moved straight to Won: the lead is created, then won (created and won rules both fire); without consent rows are skipped, not sent", async () => {
    const d = await bare();
    ok(await map(d.id, { triggerType: "lead_created", eventName: "Lead", valueMode: "none" }));
    ok(await map(d.id, { triggerType: "lead_won", eventName: "Purchase" }));
    const c = await mk("Capi Two"); await consent(c);
    ok(await put(c, { stageId: won().id, valueMinor: 1000, currency: "USD" }));
    expect(await events(d.id)).toEqual(["Lead", "Purchase"]);
    const noConsent = await mk("Capi Three");
    ok(await put(noConsent, { stageId: won().id, valueMinor: 1000, currency: "USD" }));
    const rows = await q("SELECT status FROM capi_events WHERE dataset_id=$1 AND contact_id=$2", [d.id, noConsent.id]);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((x) => x.status === "skipped_no_consent")).toBe(true);
  });

  it("bulk stage uses the same hook", async () => {
    const d = await bare();
    ok(await map(d.id, { triggerType: "lead_stage_entered", stageId: open()[1]!.id, eventName: "Schedule", valueMode: "none" }));
    const c = await mk("Capi Bulk"); await consent(c);
    ok(await as(owner).call(endpoints.bulkContactStage, { params: { workspaceId: A }, body: { contactIds: [c.id], stageId: open()[1]!.id } }));
    expect(await events(d.id)).toEqual(["Schedule"]);
  });
});

describe("agent filter: several owners and per-owner counts", () => {
  it("ownerId takes comma-separated me/unassigned/user ids; owner-counts follows the other filters but not the owner", async () => {
    const [m, a] = [await mk("OwnMulti Me"), await mk("OwnMulti Agent")];
    await mk("OwnMulti None");
    ok(await as(owner).call(endpoints.updateContact, { params: { workspaceId: A, contactId: m.id }, body: { expectedVersion: m.version, ownerUserId: owner.id } }));
    ok(await as(owner).call(endpoints.updateContact, { params: { workspaceId: A, contactId: a.id }, body: { expectedVersion: a.version, ownerUserId: agent.id } }));
    const names = async (ownerId: string) => (await list({ search: "OwnMulti ", ownerId })).items.map((x) => x.name).sort();
    expect(await names(`me,${agent.id}`)).toEqual(["OwnMulti Agent", "OwnMulti Me"]);
    expect(await names("unassigned,me")).toEqual(["OwnMulti Me", "OwnMulti None"]);
    expect(await names(agent.id)).toEqual(["OwnMulti Agent"]);
    const oc = ok(await as(owner).call(endpoints.contactOwnerCounts, { params: { workspaceId: A }, query: { search: "OwnMulti " } }));
    const n = (id: string | null) => oc.items.find((x) => x.ownerId === id)?.count ?? 0;
    expect([n(owner.id), n(agent.id), n(null)]).toEqual([1, 1, 1]);
    expect((await as(viewer).call(endpoints.contactOwnerCounts, { params: { workspaceId: A }, query: {} })).ok).toBe(true);
  });
});
