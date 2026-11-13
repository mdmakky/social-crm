import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { endpoints, type ContactDetail, type LeadDto, type PipelineDto } from "@crm/contracts";
import { bootstrap, failure, ok, type Harness, type TestUser } from "./harness.ts";

let h: Harness;
let owner!: TestUser, admin!: TestUser, agent!: TestUser, viewer!: TestUser, ownerB!: TestUser;
let A = "", B = "";
let pipe!: PipelineDto, reasonId = "", alice!: ContactDetail;
const as = (u: TestUser) => h.clientFor(u);
const p = (ws = A) => ({ workspaceId: ws });
const st = (kind: string, i = 0) => pipe.stages.filter((s) => s.kind === kind)[i]!;
const mk = async (title: string, extra: Record<string, unknown> = {}) => ok(await as(owner).call(endpoints.createLead, { params: p(), body: { title, primaryContactId: alice.id, allowDuplicate: true, ...extra } as never }));
const mv = async (l: LeadDto, to: string, extra: Record<string, unknown> = {}) => ok(await as(owner).call(endpoints.moveLead, { params: { ...p(), leadId: l.id }, body: { expectedVersion: l.version, stageId: to, ...extra } }));
const report = async (u: TestUser, query: Record<string, string> = {}, ws = A) => ok(await as(u).call(endpoints.leadReport, { params: p(ws), query }));

beforeAll(async () => {
  h = await bootstrap();
  owner = await h.newUser("rp-owner"); admin = await h.newUser("rp-admin"); agent = await h.newUser("rp-agent"); viewer = await h.newUser("rp-viewer"); ownerB = await h.newUser("rp-ownerb");
  A = await h.workspace(owner, "Reports A", { admin, agent, viewer });
  B = await h.workspace(ownerB, "Reports B");
  alice = await h.contact(as(owner), A, { name: "Alice" });
  const cfg = ok(await as(owner).call(endpoints.listPipelines, { params: p() }));
  pipe = cfg.pipelines[0]!; reasonId = cfg.lostReasons[0]!.id;
  await mk("o1", { valueMinor: 100000, currency: "USD" });
  await mk("o2", { valueMinor: 50000, currency: "USD", stageId: st("open", 2).id, expectedCloseDate: "2020-01-01" });
  await mk("o3", { valueMinor: 7000, currency: "EUR", stageId: st("open", 2).id });
  const w = await mk("w1", { valueMinor: 200000, currency: "USD" });
  await mv(w, st("won").id);
  const l1 = await mk("l1", { valueMinor: 30000, currency: "USD" });
  await mv(l1, st("lost").id, { lostReasonId: reasonId });
});
afterAll(async () => { await h.close(); });

describe("lead report", () => {
  it("owner and admin see counts, per-currency values, conversion and closing buckets", async () => {
    for (const u of [owner, admin]) {
      const r = await report(u);
      expect(r).toMatchObject({ pipelineName: "Sales", valuesVisible: true, openTotal: { count: 3 }, won: { count: 1, values: [{ currency: "USD", minor: 200000 }] }, lost: { count: 1, values: [{ currency: "USD", minor: 30000 }] } });
      expect(r.stages.map((s) => [s.name, s.count])).toEqual([["New", 1], ["Contacted", 0], ["Qualified", 2], ["Proposal", 0], ["Negotiation", 0]]);
      expect(r.stages[2]!.values).toEqual(expect.arrayContaining([{ currency: "USD", minor: 50000 }, { currency: "EUR", minor: 7000 }]));
      expect(r.openTotal.values).toEqual(expect.arrayContaining([{ currency: "USD", minor: 150000 }, { currency: "EUR", minor: 7000 }]));
      expect(r.stages.reduce((n, s) => n + s.share, 0)).toBeCloseTo(1);
      expect(r.lost.reasons).toEqual([{ reasonId, name: "No budget", count: 1 }]);
      expect(r.conversion).toMatchObject({ created: 5, winRate: 0.5 });
      expect(r.closing.find((b) => b.bucket === "overdue")).toMatchObject({ count: 1 });
      expect(r.closing.find((b) => b.bucket === "none")).toMatchObject({ count: 2 });
    }
  });
  it("agents and viewers get counts only: every value field is null and no amount appears in the payload", async () => {
    const l = ok(await as(owner).call(endpoints.listLeads, { params: p(), query: { q: "o1" } })).items[0]!;
    ok(await as(admin).call(endpoints.setLeadValueGrant, { params: { ...p(), leadId: l.id, userId: agent.id }, body: { canEdit: true } })); // a grant on one lead must not leak through aggregates
    for (const u of [agent, viewer]) {
      const r = await report(u);
      expect(r.valuesVisible).toBe(false);
      expect(r).toMatchObject({ openTotal: { count: 3, values: null }, won: { count: 1, values: null }, lost: { count: 1, values: null } });
      expect(r.stages.every((s) => s.values === null) && r.closing.every((b) => b.values === null)).toBe(true);
      const res = await h.app.request(`/v1/workspaces/${A}/lead-reports/overview`, { headers: { cookie: u.cookie, origin: "http://localhost:3000" } });
      const raw = await res.text();
      for (const n of ["100000", "50000", "200000", "30000", "7000"]) expect(raw).not.toContain(n);
    }
  });
  it("period filter, validation and tenant isolation", async () => {
    expect((await report(owner, { from: "2000-01-01", to: "2000-01-31" })).won.count).toBe(0);
    expect(failure(await as(owner).call(endpoints.leadReport, { params: p(), query: { from: "2026-02-01", to: "2026-01-01" } })).status).toBe(400);
    expect(failure(await as(owner).call(endpoints.leadReport, { params: p(), query: { pipelineId: crypto.randomUUID() } })).status).toBe(404);
    expect(failure(await as(ownerB).call(endpoints.leadReport, { params: p(A), query: {} })).status).toBe(404);
    expect((await report(ownerB, {}, B)).openTotal.count).toBe(0);
    expect(failure(await as(ownerB).call(endpoints.leadReport, { params: p(B), query: { pipelineId: pipe.id } })).status).toBe(404); // another workspace's pipeline id
  });
});
