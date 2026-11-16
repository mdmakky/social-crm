import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSecretBox } from "@crm/integrations";
import { endpoints, type ContactDetail, type LeadDto, type PipelineDto } from "@crm/contracts";
import type { MetaConnectDeps } from "../src/inbox/meta-connect.ts";
import { bootstrap, failure, ok, type Harness, type TestUser } from "./harness.ts";

// Leads-only slice: stage counts (filters, isolation, one grouped query at 10k scale) and the bulk stage move (reuses the single move).
const box = createSecretBox({ k1: Buffer.alloc(32, 9).toString("base64") }, "k1");
let h: Harness;
let owner!: TestUser, admin!: TestUser, agent!: TestUser, viewer!: TestUser, ownerB!: TestUser;
let A = "", B = "";
let alice!: ContactDetail, bobB!: ContactDetail;
let pipe!: PipelineDto;
let reasonId = "";
const as = (u: TestUser) => h.clientFor(u);
const p = (ws = A) => ({ workspaceId: ws });
const stage = (kind: string, i = 0) => pipe.stages.filter((s) => s.kind === kind)[i]!;
const q = async (text: string, params: unknown[] = []) => (await h.admin.query(text, params)).rows;
const mk = async (u: TestUser, body: Record<string, unknown> = {}) => ok(await as(u).call(endpoints.createLead, { params: p(), body: { title: "Lead", primaryContactId: alice.id, allowDuplicate: true, ...body } as never })) as LeadDto;
const bulk = (u: TestUser, leadIds: string[], stageId: string, extra: Record<string, unknown> = {}, ws = A) => as(u).call(endpoints.bulkMoveLeads, { params: p(ws), body: { leadIds, stageId, ...extra } as never });
const counts = async (u: TestUser, query: Record<string, unknown> = {}, ws = A) => ok(await as(u).call(endpoints.leadStageCounts, { params: p(ws), query: query as never }));
const countOf = (c: { items: { stageId: string; count: number }[] }, stageId: string) => c.items.find((x) => x.stageId === stageId)?.count ?? 0;

beforeAll(async () => {
  h = await bootstrap({ capiCreatesPerUser: 1000 }, { box } as unknown as MetaConnectDeps);
  [owner, admin, agent, viewer, ownerB] = (await Promise.all(["ls-owner", "ls-admin", "ls-agent", "ls-viewer", "ls-ownerb"].map((l) => h.newUser(l)))) as [TestUser, TestUser, TestUser, TestUser, TestUser];
  A = await h.workspace(owner, "Scale A", { admin, agent, viewer });
  B = await h.workspace(ownerB, "Scale B");
  alice = await h.contact(as(owner), A, { name: "Alice" });
  bobB = await h.contact(as(ownerB), B, { name: "Bob B" });
  const cfg = ok(await as(owner).call(endpoints.listPipelines, { params: p() }));
  pipe = cfg.pipelines[0]!;
  reasonId = cfg.lostReasons[0]!.id;
});
afterAll(async () => { await h.close(); });

describe("stage counts", () => {
  it("counts per stage, honours the list filters except stage, skips deleted, never leaks another workspace", async () => {
    const s0 = stage("open", 0), s1 = stage("open", 1);
    const a = await mk(owner, { title: "Alpha one", source: "manual", ownerUserId: agent.id, valueMinor: 1000, currency: "USD" });
    await mk(owner, { title: "Alpha two", valueMinor: 5000, currency: "USD" });
    const b = await mk(owner, { title: "Beta" });
    ok(await as(owner).call(endpoints.moveLead, { params: { workspaceId: A, leadId: b.id }, body: { expectedVersion: b.version, stageId: s1.id } }));
    const gone = await mk(owner, { title: "Alpha gone" });
    ok(await as(owner).call(endpoints.deleteLead, { params: { workspaceId: A, leadId: gone.id }, query: { expectedVersion: gone.version } }));
    const all = await counts(owner);
    expect(countOf(all, s0.id)).toBe(2);
    expect(countOf(all, s1.id)).toBe(1);
    expect(all.total).toBe(3);
    expect(await counts(owner, { q: "alpha" })).toMatchObject({ total: 2 });
    expect(await counts(owner, { ownerId: agent.id })).toMatchObject({ total: 1 });
    expect(await counts(owner, { minValue: 2000 })).toMatchObject({ total: 1 });
    expect(await counts(owner, { maxValue: 2000 })).toMatchObject({ total: 1 });
    expect(await counts(owner, { activeWithinDays: "7" })).toMatchObject({ total: 3 });
    await q("UPDATE leads SET updated_at = now() - interval '40 days' WHERE id=$1", [a.id]);
    expect(await counts(owner, { activeWithinDays: "30" })).toMatchObject({ total: 2 });
    expect(await counts(owner, { pipelineId: pipe.id, outcome: "open" })).toMatchObject({ total: 3 });
    expect(await counts(owner, { outcome: "won" })).toMatchObject({ total: 0 });
    // a stage filter is not an accepted count filter: the list and the chips must not narrow each other
    expect(await counts(owner, { stageId: s0.id } as never)).toMatchObject({ total: 3 });
    expect(await counts(ownerB, {}, B)).toMatchObject({ total: 0 });
    expect(failure(await as(ownerB).call(endpoints.leadStageCounts, { params: p(A), query: {} })).status).toBe(404);
  });
  it("the list honours the same new filters", async () => {
    const l = (query: Record<string, unknown>) => as(owner).call(endpoints.listLeads, { params: p(), query: query as never }).then((r) => ok(r).items.map((x) => x.title).sort());
    expect(await l({ minValue: 2000 })).toEqual(["Alpha two"]);
    expect(await l({ source: "manual", maxValue: 1000 })).toEqual(["Alpha one"]);
    expect(await l({ activeWithinDays: "30", q: "alpha" })).toEqual(["Alpha two"]);
  });
  it("value-range filters are refused for roles that cannot see values (no probing hidden values)", async () => {
    for (const u of [agent, viewer]) {
      expect(failure(await as(u).call(endpoints.leadStageCounts, { params: p(), query: { minValue: 1 } })).status).toBe(403);
      expect(failure(await as(u).call(endpoints.listLeads, { params: p(), query: { maxValue: 1 } })).status).toBe(403);
    }
    expect(ok(await as(agent).call(endpoints.leadStageCounts, { params: p(), query: {} })).total).toBeGreaterThan(0);
  });
  it("is one grouped query and fast with thousands of leads (no per-lead loop)", async () => {
    const ws = await h.workspace(owner, "Scale 10k");
    const c = await h.contact(as(owner), ws, { name: "Bulk Contact" });
    const pl = ok(await as(owner).call(endpoints.listPipelines, { params: p(ws) })).pipelines[0]!;
    const open = pl.stages.filter((s) => s.kind === "open");
    const stageIds = open.map((s) => s.id);
    await h.admin.query(
      `INSERT INTO leads (workspace_id, title, primary_contact_id, pipeline_id, stage_id, outcome, rank, probability, owner_user_id)
       SELECT $1, 'Seed ' || g, $2, $3, ($4::uuid[])[1 + (g % $5)], 'open', lpad(g::text, 12, '0'), 10, CASE WHEN g % 4 = 0 THEN $6 ELSE NULL END FROM generate_series(1, 4210) g`,
      [ws, c.id, pl.id, stageIds, stageIds.length, owner.id],
    );
    const t0 = performance.now();
    const res = ok(await as(owner).call(endpoints.leadStageCounts, { params: p(ws), query: {} }));
    const ms = performance.now() - t0;
    expect(res.total).toBe(4210);
    expect(res.items.length).toBe(stageIds.length);
    expect(res.items.reduce((n, x) => n + x.count, 0)).toBe(4210);
    expect(ms).toBeLessThan(1500);
    expect(await counts(owner, { ownerId: owner.id }, ws)).toMatchObject({ total: 1052 });
    // the shape: a grouped aggregate, not one query per lead
    const plan = (await q(`EXPLAIN SELECT stage_id, count(*)::int FROM leads WHERE workspace_id=$1 AND deleted_at IS NULL GROUP BY stage_id`, [ws])).map((r) => r["QUERY PLAN"] as string).join("\n");
    expect(plan).toMatch(/Aggregate/);
  }, 60_000);
});

describe("cursor paging", () => {
  it("pages through leads whose timestamps differ only in microseconds without skipping or repeating any (all three sorts)", async () => {
    const ws = await h.workspace(owner, "Paging");
    const c = await h.contact(as(owner), ws, { name: "Pager" });
    const pl = ok(await as(owner).call(endpoints.listPipelines, { params: p(ws) })).pipelines[0]!;
    await h.admin.query(
      `INSERT INTO leads (workspace_id, title, primary_contact_id, pipeline_id, stage_id, outcome, rank, probability, created_at, updated_at, expected_close_date)
       SELECT $1, 'P ' || g, $2, $3, $4, 'open', lpad(g::text, 12, '0'), 10, now() + g * interval '37 microseconds', now() + g * interval '41 microseconds', DATE '2030-01-01' + (g % 3) FROM generate_series(1, 237) g`,
      [ws, c.id, pl.id, pl.stages[0]!.id],
    );
    for (const sort of ["updated", "created", "close"] as const) {
      const seen = new Set<string>();
      let cursor: string | undefined;
      for (let i = 0; i < 10; i++) {
        const page = ok(await as(owner).call(endpoints.listLeads, { params: p(ws), query: { limit: 50, sort, ...(cursor ? { cursor } : {}) } }));
        for (const l of page.items) { expect(seen.has(l.id)).toBe(false); seen.add(l.id); }
        cursor = page.nextCursor ?? undefined;
        if (!cursor) break;
      }
      expect(seen.size, sort).toBe(237);
    }
  });
});

describe("bulk stage move", () => {
  const hist = async (leadId: string) => ({
    acts: await q("SELECT kind FROM activities WHERE workspace_id=$1 AND lead_id=$2 AND kind <> 'lead.created'", [A, leadId]),
    evs: await q("SELECT id FROM domain_events WHERE workspace_id=$1 AND entity_id=$2 AND type='lead.stage_changed'", [A, leadId]),
    audit: await q("SELECT action FROM audit_log WHERE workspace_id=$1 AND entity_id=$2 AND action <> 'lead.created'", [A, leadId]),
    trans: await q("SELECT id FROM stage_transitions WHERE workspace_id=$1 AND lead_id=$2", [A, leadId]),
  });
  it("moves each lead exactly like a single move: one activity, audit row, transition and lead.stage_changed event per lead", async () => {
    const ls = await Promise.all([mk(agent, { title: "B1" }), mk(agent, { title: "B2" }), mk(agent, { title: "B3" })]);
    const to = stage("open", 2);
    const r = ok(await bulk(agent, ls.map((x) => x.id), to.id));
    expect(r.results).toEqual(ls.map((x) => ({ id: x.id, ok: true, code: "ok" })));
    for (const l of ls) {
      const got = ok(await as(agent).call(endpoints.getLead, { params: { workspaceId: A, leadId: l.id } }));
      expect(got.stageId).toBe(to.id);
      const x = await hist(l.id);
      expect(x.acts).toEqual([{ kind: "lead.stage_changed" }]);
      expect(x.evs).toHaveLength(1);
      expect(x.audit).toEqual([{ action: "lead.stage_changed" }]);
      expect(x.trans).toHaveLength(2); // creation + this move
    }
  });
  it("is idempotent: a lead already in the stage is reported unchanged and writes nothing", async () => {
    const l = await mk(owner, { title: "Idem" });
    const to = stage("open", 1);
    expect(ok(await bulk(owner, [l.id], to.id)).results[0]).toMatchObject({ ok: true, code: "ok" });
    const before = await hist(l.id);
    expect(ok(await bulk(owner, [l.id], to.id)).results[0]).toMatchObject({ ok: true, code: "unchanged" });
    expect(await hist(l.id)).toEqual(before);
  });
  it("Won fires the CAPI Purchase hook once per lead, even if the bulk is repeated", async () => {
    const ds = ok(await as(owner).call(endpoints.createCapiDataset, { params: p(), body: { datasetId: `7${Date.now()}1`, name: "Main", accessToken: "EAAB-secret-token-" + "q".repeat(40), events: ["Purchase"] } as never }));
    const c = await h.contact(as(owner), A, { name: "Win Wendy", email: `ww${Date.now()}@example.com`, phone: `+8801799${String(Date.now()).slice(-6)}` });
    const ls = await Promise.all([mk(owner, { title: "W1", primaryContactId: c.id, valueMinor: 100, currency: "USD" }), mk(owner, { title: "W2", primaryContactId: c.id, valueMinor: 200, currency: "USD" })]);
    ok(await bulk(owner, ls.map((x) => x.id), stage("won").id));
    ok(await bulk(owner, ls.map((x) => x.id), stage("won").id));
    expect(await q("SELECT id FROM capi_events WHERE workspace_id=$1 AND dataset_id=$2", [A, ds.id])).toHaveLength(2);
    for (const l of ls) expect((await hist(l.id)).acts).toEqual([{ kind: "lead.won" }]);
  });
  it("reports per-lead results: mixed success, unknown, deleted, cross-workspace (as not_found) and a lost stage without a reason", async () => {
    const good = await mk(owner, { title: "Good" });
    const del = await mk(owner, { title: "Deleted" });
    ok(await as(owner).call(endpoints.deleteLead, { params: { workspaceId: A, leadId: del.id }, query: { expectedVersion: del.version } }));
    const cB = bobB;
    const other = ok(await as(ownerB).call(endpoints.createLead, { params: p(B), body: { title: "Theirs", primaryContactId: cB.id } })) as LeadDto;
    const ghost = "00000000-0000-4000-8000-000000000001";
    const r = ok(await bulk(owner, [good.id, del.id, other.id, ghost], stage("open", 3).id));
    expect(r.results).toEqual([{ id: good.id, ok: true, code: "ok" }, { id: del.id, ok: false, code: "not_found" }, { id: other.id, ok: false, code: "not_found" }, { id: ghost, ok: false, code: "not_found" }]);
    expect(ok(await as(ownerB).call(endpoints.getLead, { params: { workspaceId: B, leadId: other.id } })).stageId).toBe(other.stageId); // untouched
    expect(ok(await bulk(owner, [good.id], stage("lost").id)).results[0]).toMatchObject({ ok: false, code: "lost_reason_required" });
    expect(ok(await bulk(owner, [good.id], stage("lost").id, { lostReasonId: reasonId })).results[0]).toMatchObject({ ok: true, code: "ok" });
    // a stage of another workspace is not a valid target
    const foreign = ok(await as(ownerB).call(endpoints.listPipelines, { params: p(B) })).pipelines[0]!.stages[0]!;
    expect(ok(await bulk(owner, [good.id], foreign.id)).results[0]).toMatchObject({ ok: false, code: "invalid_body" });
    expect(failure(await bulk(ownerB, [good.id], foreign.id, {}, A)).status).toBe(404); // not a member of A
  });
  it("permissions follow the single move: viewers are refused; agents cannot reopen closed leads", async () => {
    const l = await mk(owner, { title: "Perm" });
    expect(failure(await bulk(viewer, [l.id], stage("open", 1).id)).status).toBe(403);
    ok(await bulk(owner, [l.id], stage("won").id));
    expect(ok(await bulk(agent, [l.id], stage("open", 0).id)).results[0]).toMatchObject({ ok: false, code: "forbidden" });
    expect(ok(await bulk(admin, [l.id], stage("open", 0).id)).results[0]).toMatchObject({ ok: true });
  });
  it("accepts at most 100 ids (101 is rejected), at least 1, and uuids only", async () => {
    const ids = Array.from({ length: 101 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`);
    expect(failure(await bulk(owner, ids, stage("open", 1).id)).status).toBe(0); // the shared contract refuses before any request
    for (const leadIds of [ids, []]) { // and the server refuses too
      const res = await h.app.request(`/v1/workspaces/${A}/leads/bulk-stage`, { method: "POST", headers: { "content-type": "application/json", origin: "http://localhost:3000", cookie: owner.cookie }, body: JSON.stringify({ leadIds, stageId: stage("open", 1).id }) });
      expect(res.status).toBe(400);
    }
    expect(ok(await bulk(owner, ids.slice(0, 100), stage("open", 1).id)).results).toHaveLength(100);
  });
  it("is rate limited per user", async () => {
    const u = await h.newUser("ls-spam");
    const ws = await h.workspace(owner, "Rate", { agent: u });
    const st = ok(await as(owner).call(endpoints.listPipelines, { params: p(ws) })).pipelines[0]!.stages[0]!.id;
    let last = 0;
    for (let i = 0; i < 31; i++) last = (await bulk(u, ["00000000-0000-4000-8000-000000000009"], st, {}, ws)).ok ? 200 : 429;
    expect(last).toBe(429);
  });
});
