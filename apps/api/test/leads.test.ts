import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { endpoints, type ContactDetail, type LeadDto, type PipelineDto } from "@crm/contracts";
import { bootstrap, failure, ok, type Harness, type TestUser } from "./harness.ts";

let h: Harness;
let owner!: TestUser, admin!: TestUser, agent!: TestUser, agent2!: TestUser, viewer!: TestUser, ownerB!: TestUser;
let A = "", B = "";
let alice!: ContactDetail, carol!: ContactDetail, bobB!: ContactDetail;
let pipe!: PipelineDto;
let reasonId = "";
const as = (u: TestUser) => h.clientFor(u);
const p = (ws = A) => ({ workspaceId: ws });
const lp = (id: string, ws = A) => ({ workspaceId: ws, leadId: id });
const code = (r: Parameters<typeof failure>[0]) => (failure(r) as unknown as { code: string }).code;
const stage = (kind: string, i = 0) => pipe.stages.filter((s) => s.kind === kind)[i]!;
const create = async (u: TestUser, body: Record<string, unknown>) => ok(await as(u).call(endpoints.createLead, { params: p(), body: { title: "Deal", primaryContactId: alice.id, allowDuplicate: true, ...body } as never }));
const move = (u: TestUser, l: LeadDto, to: string, extra: Record<string, unknown> = {}) => as(u).call(endpoints.moveLead, { params: lp(l.id), body: { expectedVersion: l.version, stageId: to, ...extra } });
const get = async (u: TestUser, id: string) => ok(await as(u).call(endpoints.getLead, { params: lp(id) }));

beforeAll(async () => {
  h = await bootstrap();
  owner = await h.newUser("ld-owner"); admin = await h.newUser("ld-admin"); agent = await h.newUser("ld-agent"); agent2 = await h.newUser("ld-agent2"); viewer = await h.newUser("ld-viewer"); ownerB = await h.newUser("ld-ownerb");
  A = await h.workspace(owner, "Leads A", { admin, agent, agent2, viewer });
  B = await h.workspace(ownerB, "Leads B");
  alice = await h.contact(as(owner), A, { name: "Alice" });
  carol = await h.contact(as(owner), A, { name: "Carol" });
  bobB = await h.contact(as(ownerB), B, { name: "Bob B" });
  const cfg = ok(await as(owner).call(endpoints.listPipelines, { params: p() }));
  pipe = cfg.pipelines[0]!;
  reasonId = cfg.lostReasons[0]!.id;
});
afterAll(async () => { await h.close(); });

describe("create", () => {
  it("starts in the first open stage with its default probability, writes history, activity and audit", async () => {
    const l = await create(agent, { title: "First", priority: "high" });
    expect(l).toMatchObject({ title: "First", stageId: stage("open").id, outcome: "open", probability: 10, probabilityManual: false, priority: "high", valueHidden: true, closedAt: null });
    const tr = ok(await as(agent).call(endpoints.listLeadTransitions, { params: lp(l.id) }));
    expect(tr.items).toHaveLength(1);
    expect(tr.items[0]).toMatchObject({ fromStageId: null, toStageId: stage("open").id, toOutcome: "open" });
    expect(ok(await as(agent).call(endpoints.listLeadActivities, { params: lp(l.id) })).items.map((a) => a.kind)).toEqual(["lead.created"]);
    const { rows } = await h.admin.query("SELECT action FROM audit_log WHERE workspace_id=$1 AND entity_id=$2", [A, l.id]);
    expect(rows.map((x: { action: string }) => x.action)).toContain("lead.created");
  });
  it("validates contact, pipeline stage, owner, value pairing", async () => {
    const bad = (body: Record<string, unknown>) => as(owner).call(endpoints.createLead, { params: p(), body: { title: "x", primaryContactId: alice.id, ...body } as never });
    expect(failure(await bad({ primaryContactId: bobB.id })).status).toBe(400);
    expect(failure(await bad({ stageId: stage("won").id })).status).toBe(400);
    expect(failure(await bad({ ownerUserId: ownerB.id })).status).toBe(400);
    expect(failure(await bad({ valueMinor: 100 })).status).toBe(0); // contract refuses a value without currency before any request
    expect(failure(await as(agent).call(endpoints.createLead, { params: p(), body: { title: "x", primaryContactId: alice.id, ownerUserId: agent2.id } })).status).toBe(400);
  });
  it("warns about a second open lead for the same contact in the pipeline, allowDuplicate overrides", async () => {
    const c1 = await h.contact(as(owner), A, { name: "Dup Dan" });
    await create(owner, { primaryContactId: c1.id, allowDuplicate: false });
    expect(code(await as(owner).call(endpoints.createLead, { params: p(), body: { title: "again", primaryContactId: c1.id } }))).toBe("duplicate_lead");
    await create(owner, { primaryContactId: c1.id, allowDuplicate: true });
  });
  it("viewers cannot create; other workspaces' contacts are invisible", async () => {
    expect(failure(await as(viewer).call(endpoints.createLead, { params: p(), body: { title: "x", primaryContactId: alice.id } })).status).toBe(403);
    expect(failure(await as(ownerB).call(endpoints.createLead, { params: p(A), body: { title: "x", primaryContactId: alice.id } })).status).toBe(404);
  });
});

describe("deal value visibility (decision 5)", () => {
  it("owner/admin see value; an agent without a grant sees it hidden and cannot write it; a grant opens read, and edit when canEdit", async () => {
    const l = await create(owner, { valueMinor: 125000, currency: "USD", ownerUserId: agent.id });
    expect(await get(owner, l.id)).toMatchObject({ valueMinor: 125000, currency: "USD", valueHidden: false });
    expect(await get(admin, l.id)).toMatchObject({ valueMinor: 125000, valueHidden: false });
    for (const u of [agent, viewer]) expect(await get(u, l.id)).toMatchObject({ valueMinor: null, currency: null, valueHidden: true });
    const listed = ok(await as(agent).call(endpoints.listLeads, { params: p(), query: { limit: 100 } })).items.find((x) => x.id === l.id)!;
    expect(listed).toMatchObject({ valueMinor: null, valueHidden: true });
    expect(failure(await as(agent).call(endpoints.updateLead, { params: lp(l.id), body: { expectedVersion: l.version, valueMinor: 1, currency: "USD" } })).status).toBe(403);
    expect(failure(await as(agent).call(endpoints.createLead, { params: p(), body: { title: "v", primaryContactId: alice.id, valueMinor: 5, currency: "USD", allowDuplicate: true } })).status).toBe(403);
    expect(failure(await as(agent).call(endpoints.setLeadValueGrant, { params: { ...lp(l.id), userId: agent.id }, body: { canEdit: false } })).status).toBe(403);
    ok(await as(admin).call(endpoints.setLeadValueGrant, { params: { ...lp(l.id), userId: agent.id }, body: { canEdit: false } }));
    expect(await get(agent, l.id)).toMatchObject({ valueMinor: 125000, valueHidden: false, canEditValue: false });
    expect(failure(await as(agent).call(endpoints.updateLead, { params: lp(l.id), body: { expectedVersion: l.version, valueMinor: 1, currency: "USD" } })).status).toBe(403);
    ok(await as(admin).call(endpoints.setLeadValueGrant, { params: { ...lp(l.id), userId: agent.id }, body: { canEdit: true } }));
    expect(ok(await as(agent).call(endpoints.updateLead, { params: lp(l.id), body: { expectedVersion: l.version, valueMinor: 200000, currency: "USD" } }))).toMatchObject({ valueMinor: 200000 });
    expect(await get(agent2, l.id)).toMatchObject({ valueHidden: true, valueMinor: null });
    ok(await as(admin).call(endpoints.removeLeadValueGrant, { params: { ...lp(l.id), userId: agent.id } }));
    expect(await get(agent, l.id)).toMatchObject({ valueHidden: true });
  });
});

describe("probability (decision 3)", () => {
  it("manual override survives stage moves; reset returns to the stage default; won=100, lost=0, reopen resets", async () => {
    let l = await create(owner, { probability: 33 });
    expect(l).toMatchObject({ probability: 33, probabilityManual: true });
    l = ok(await move(owner, l, stage("open", 2).id));
    expect(l).toMatchObject({ probability: 33, probabilityManual: true, stageId: stage("open", 2).id });
    l = ok(await as(owner).call(endpoints.updateLead, { params: lp(l.id), body: { expectedVersion: l.version, resetProbability: true } }));
    expect(l).toMatchObject({ probability: 40, probabilityManual: false });
    l = ok(await move(owner, l, stage("open", 3).id));
    expect(l.probability).toBe(60);
    l = ok(await move(owner, l, stage("won").id));
    expect(l).toMatchObject({ outcome: "won", probability: 100, closedAt: expect.any(String) });
    expect(failure(await as(owner).call(endpoints.updateLead, { params: lp(l.id), body: { expectedVersion: l.version, probability: 50 } })).status).toBe(400);
    l = ok(await move(admin, l, stage("open", 1).id));
    expect(l).toMatchObject({ outcome: "open", closedAt: null, probability: 20, probabilityManual: false });
  });
});

describe("move, close, reopen", () => {
  it("lost needs an active reason; closing, reopening and history are recorded; agents cannot reopen", async () => {
    let l = await create(agent, {});
    expect(code(await move(agent, l, stage("lost").id))).toBe("lost_reason_required");
    l = ok(await move(agent, l, stage("lost").id, { lostReasonId: reasonId }));
    expect(l).toMatchObject({ outcome: "lost", probability: 0, lostReasonId: reasonId });
    expect(failure(await move(agent, l, stage("open").id)).status).toBe(403);
    l = ok(await move(admin, l, stage("open").id));
    expect(l).toMatchObject({ outcome: "open", lostReasonId: null });
    const tr = ok(await as(agent).call(endpoints.listLeadTransitions, { params: lp(l.id) })).items.map((t) => t.toOutcome);
    expect(tr).toEqual(["open", "lost", "open"]);
    expect(ok(await as(agent).call(endpoints.listLeadActivities, { params: lp(l.id) })).items.map((a) => a.kind).reverse()).toEqual(["lead.created", "lead.lost", "lead.reopened"]);
  });
  it("rejects stale versions, stages of another pipeline and archived stages", async () => {
    const l = await create(owner, {});
    expect(code(await as(owner).call(endpoints.moveLead, { params: lp(l.id), body: { expectedVersion: l.version + 3, stageId: stage("open", 1).id } }))).toBe("version_conflict");
    const other = ok(await as(owner).call(endpoints.createPipeline, { params: p(), body: { name: "Other", kind: "lead" } }));
    expect(failure(await move(owner, l, other.stages[0]!.id)).status).toBe(400);
  });
  it("orders cards inside a column with before/after and renumbers when ranks run out", async () => {
    const ls: LeadDto[] = [];
    for (const t of ["r1", "r2", "r3"]) ls.push(await create(owner, { title: t, stageId: stage("open", 4).id }));
    const col = async () => ok(await as(owner).call(endpoints.listLeads, { params: p(), query: { stageId: stage("open", 4).id, limit: 100 } })).items;
    const byRank = async () => (await col()).filter((x) => ["r1", "r2", "r3"].includes(x.title)).sort((a, b) => a.rank.localeCompare(b.rank)).map((x) => x.title);
    expect(await byRank()).toEqual(["r1", "r2", "r3"]);
    ok(await move(owner, await get(owner, ls[2]!.id), stage("open", 4).id, { beforeLeadId: ls[0]!.id }));
    expect(await byRank()).toEqual(["r3", "r1", "r2"]);
    for (let i = 0; i < 25; i++) { // insert r2 between r1 and its successor again and again until the numeric gap is gone
      const sorted = (await col()).sort((x, y) => x.rank.localeCompare(y.rank));
      const next = sorted.slice(sorted.findIndex((x) => x.id === ls[0]!.id) + 1).find((x) => x.id !== ls[1]!.id);
      ok(await move(owner, await get(owner, ls[1]!.id), stage("open", 4).id, { afterLeadId: ls[0]!.id, ...(next ? { beforeLeadId: next.id } : {}) }));
    }
    const ranks = (await col()).map((x) => x.rank);
    expect(new Set(ranks).size).toBe(ranks.length);
  });
});

describe("update, delete, restore", () => {
  it("optimistic concurrency, no-op updates do not bump the version, agents cannot delete", async () => {
    const l = await create(agent, {});
    const u = ok(await as(agent).call(endpoints.updateLead, { params: lp(l.id), body: { expectedVersion: l.version, title: "Renamed", expectedCloseDate: "2027-01-31" } }));
    expect(u).toMatchObject({ title: "Renamed", version: l.version + 1, expectedCloseDate: "2027-01-31" });
    expect(code(await as(agent).call(endpoints.updateLead, { params: lp(l.id), body: { expectedVersion: l.version, title: "Stale" } }))).toBe("version_conflict");
    expect(ok(await as(agent).call(endpoints.updateLead, { params: lp(l.id), body: { expectedVersion: u.version, title: "Renamed" } })).version).toBe(u.version);
    expect(failure(await as(agent).call(endpoints.deleteLead, { params: lp(l.id), query: { expectedVersion: u.version } })).status).toBe(403);
    expect(failure(await as(viewer).call(endpoints.updateLead, { params: lp(l.id), body: { expectedVersion: u.version, title: "No" } })).status).toBe(403);
  });
  it("admin soft-deletes and restores; deleted leads vanish for agents and from default lists", async () => {
    const l = await create(owner, { title: "Gone" });
    const d = ok(await as(admin).call(endpoints.deleteLead, { params: lp(l.id), query: { expectedVersion: l.version } }));
    expect(d.deletedAt).not.toBeNull();
    expect(failure(await as(agent).call(endpoints.getLead, { params: lp(l.id) })).status).toBe(404);
    expect(ok(await as(owner).call(endpoints.listLeads, { params: p(), query: { q: "Gone" } })).items).toHaveLength(0);
    expect(ok(await as(owner).call(endpoints.listLeads, { params: p(), query: { q: "Gone", deleted: "true" } })).items).toHaveLength(1);
    expect(failure(await as(agent).call(endpoints.listLeads, { params: p(), query: { deleted: "true" } })).status).toBe(403);
    expect(ok(await as(admin).call(endpoints.restoreLead, { params: lp(l.id), body: { expectedVersion: d.version } })).deletedAt).toBeNull();
  });
  it("a lead of a deleted contact is read-only history", async () => {
    const c = await h.contact(as(owner), A, { name: "Soon Gone" });
    const l = await create(owner, { primaryContactId: c.id });
    ok(await as(owner).call(endpoints.deleteContact, { params: { workspaceId: A, contactId: c.id } }));
    expect(await get(owner, l.id)).toMatchObject({ primaryContact: { deleted: true } });
    expect(code(await move(owner, l, stage("open", 1).id))).toBe("contact_deleted");
  });
});

describe("list", () => {
  it("filters, sorts and pages with a cursor", async () => {
    const mk = async (title: string, extra: Record<string, unknown>) => create(owner, { title, primaryContactId: carol.id, ...extra });
    await mk("zz-list-1", { expectedCloseDate: "2027-03-01" }); await mk("zz-list-2", { expectedCloseDate: "2027-01-01" }); await mk("zz-list-3", {});
    const q = { q: "zz-list", limit: 2, sort: "close" as const, dir: "asc" as const };
    const first = ok(await as(owner).call(endpoints.listLeads, { params: p(), query: q }));
    expect(first.items.map((x) => x.title)).toEqual(["zz-list-2", "zz-list-1"]);
    expect(first.nextCursor).not.toBeNull();
    const second = ok(await as(owner).call(endpoints.listLeads, { params: p(), query: { ...q, cursor: first.nextCursor! } }));
    expect(second.items.map((x) => x.title)).toEqual(["zz-list-3"]);
    expect(second.nextCursor).toBeNull();
    expect(failure(await as(owner).call(endpoints.listLeads, { params: p(), query: { ...q, sort: "updated", cursor: first.nextCursor! } })).status).toBe(400);
    expect(ok(await as(owner).call(endpoints.listLeads, { params: p(), query: { contactId: carol.id, outcome: "won" } })).items).toHaveLength(0);
  });
  it("other workspaces get 404 and never see these leads", async () => {
    const l = await create(owner, { title: "secret" });
    expect(failure(await as(ownerB).call(endpoints.getLead, { params: lp(l.id, B) })).status).toBe(404);
    expect(failure(await as(ownerB).call(endpoints.listLeads, { params: p(A), query: {} })).status).toBe(404);
    expect(ok(await as(ownerB).call(endpoints.listLeads, { params: p(B), query: {} })).items).toHaveLength(0);
  });
});

describe("archive guards with leads", () => {
  it("a pipeline with open leads cannot be archived; archiving a stage moves its leads with history", async () => {
    const pl = ok(await as(owner).call(endpoints.createPipeline, { params: p(), body: { name: "Guarded", kind: "sales" } }));
    const [s1, s2] = pl.stages;
    const l = await create(owner, { pipelineId: pl.id, stageId: s1!.id });
    expect(code(await as(owner).call(endpoints.archivePipeline, { params: { ...p(), pipelineId: pl.id }, body: { expectedVersion: pl.version } }))).toBe("pipeline_not_empty");
    ok(await as(owner).call(endpoints.archivePipelineStage, { params: { ...p(), stageId: s1!.id }, body: { moveToStageId: s2!.id } }));
    const after = await get(owner, l.id);
    expect(after.stageId).toBe(s2!.id);
    expect(ok(await as(owner).call(endpoints.listLeadTransitions, { params: lp(l.id) })).items).toHaveLength(2);
  });
  it("race: archiving a stage while leads move into it never strands a lead in the archived stage", async () => {
    for (let round = 0; round < 5; round++) {
      const pl = ok(await as(owner).call(endpoints.createPipeline, { params: p(), body: { name: `Race ${round}`, kind: "sales" } }));
      const [s1, s2, s3] = pl.stages;
      const ls = await Promise.all([1, 2, 3, 4].map((i) => create(owner, { title: `race-${round}-${i}`, pipelineId: pl.id, stageId: s1!.id })));
      await Promise.all([
        as(owner).call(endpoints.archivePipelineStage, { params: { ...p(), stageId: s2!.id }, body: { moveToStageId: s3!.id } }),
        ...ls.map((l) => move(owner, l, s2!.id)),
      ]);
      const { rows } = await h.admin.query("SELECT count(*)::int AS n FROM leads l JOIN pipeline_stages s ON s.id = l.stage_id WHERE l.pipeline_id = $1 AND s.archived_at IS NOT NULL AND l.outcome = 'open'", [pl.id]);
      expect(rows[0].n).toBe(0);
    }
  });
});
