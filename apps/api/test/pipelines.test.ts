import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { endpoints } from "@crm/contracts";
import { bootstrap, failure, ok, type Harness, type TestUser } from "./harness.ts";

let h: Harness;
let owner!: TestUser, admin!: TestUser, agent!: TestUser, viewer!: TestUser, ownerB!: TestUser;
let A: string, B: string;
const as = (u: TestUser) => h.clientFor(u);
const p = (ws = A) => ({ workspaceId: ws });
const list = async (u = owner, ws = A) => ok(await as(u).call(endpoints.listPipelines, { params: p(ws) }));
const code = (r: Parameters<typeof failure>[0]) => (failure(r) as unknown as { code: string }).code;

beforeAll(async () => {
  h = await bootstrap();
  owner = await h.newUser("pl-owner"); admin = await h.newUser("pl-admin"); agent = await h.newUser("pl-agent"); viewer = await h.newUser("pl-viewer"); ownerB = await h.newUser("pl-ownerb");
  A = await h.workspace(owner, "Pipelines A", { admin, agent, viewer });
  B = await h.workspace(ownerB, "Pipelines B");
});
afterAll(async () => { await h.close(); });

describe("defaults", () => {
  it("new workspace gets one default Sales pipeline with 5 open stages, Won (100), Lost (0) and 6 lost reasons", async () => {
    const r = await list();
    expect(r.pipelines).toHaveLength(1);
    const pl = r.pipelines[0]!;
    expect(pl).toMatchObject({ name: "Sales", kind: "sales", isDefault: true, defaultCurrency: "USD" });
    expect(pl.stages.map((s) => [s.name, s.kind, s.defaultProbability])).toEqual([["New", "open", 10], ["Contacted", "open", 20], ["Qualified", "open", 40], ["Proposal", "open", 60], ["Negotiation", "open", 80], ["Won", "won", 100], ["Lost", "lost", 0]]);
    expect(r.lostReasons).toHaveLength(6);
  });
  it("every role reads; other workspaces see only their own", async () => {
    for (const u of [admin, agent, viewer]) expect((await list(u)).pipelines).toHaveLength(1);
    expect((await list(ownerB, B)).pipelines).toHaveLength(1);
    expect((await list(ownerB, B)).pipelines[0]!.id).not.toBe((await list()).pipelines[0]!.id);
    expect(failure(await as(ownerB).call(endpoints.listPipelines, { params: p(A) })).status).toBe(404);
  });
});

describe("permissions", () => {
  it("agents and viewers cannot configure", async () => {
    const pl = (await list()).pipelines[0]!;
    for (const u of [agent, viewer]) {
      expect(failure(await as(u).call(endpoints.createPipeline, { params: p(), body: { name: "X", kind: "lead" } })).status).toBe(403);
      expect(failure(await as(u).call(endpoints.createPipelineStage, { params: { ...p(), pipelineId: pl.id }, body: { name: "X", defaultProbability: 50 } })).status).toBe(403);
      expect(failure(await as(u).call(endpoints.createLostReason, { params: p(), body: { name: "X" } })).status).toBe(403);
    }
  });
});

describe("pipelines", () => {
  it("creates a lead pipeline, enforces unique names, switches the default, archives", async () => {
    const lp = ok(await as(admin).call(endpoints.createPipeline, { params: p(), body: { name: "Inbound", kind: "lead", defaultCurrency: "EUR" } }));
    expect(lp.stages.map((s) => s.kind)).toEqual(["open", "open", "won", "lost"]);
    expect(lp.isDefault).toBe(false);
    expect(code(await as(admin).call(endpoints.createPipeline, { params: p(), body: { name: "inbound", kind: "lead" } }))).toBe("name_taken");
    const sales = (await list()).pipelines.find((x) => x.name === "Sales")!;
    expect(code(await as(admin).call(endpoints.archivePipeline, { params: { ...p(), pipelineId: sales.id }, body: { expectedVersion: sales.version } }))).toBe("pipeline_is_default");
    const made = ok(await as(admin).call(endpoints.updatePipeline, { params: { ...p(), pipelineId: lp.id }, body: { isDefault: true, expectedVersion: lp.version } }));
    expect(made.isDefault).toBe(true);
    const all = (await list()).pipelines;
    expect(all.filter((x) => x.isDefault)).toHaveLength(1);
    const s2 = all.find((x) => x.name === "Sales")!;
    expect(failure(await as(admin).call(endpoints.updatePipeline, { params: { ...p(), pipelineId: s2.id }, body: { name: "Sales 2", expectedVersion: s2.version + 5 } })).status).toBe(409);
    const archived = ok(await as(admin).call(endpoints.archivePipeline, { params: { ...p(), pipelineId: s2.id }, body: { expectedVersion: s2.version } }));
    expect(archived.archived).toBe(true);
    // restore the original state for the rest of the file
    const back = ok(await as(admin).call(endpoints.createPipeline, { params: p(), body: { name: "Sales Again", kind: "sales", isDefault: true } }));
    expect(back.isDefault).toBe(true);
  });
});

describe("stages", () => {
  it("adds, renames, reorders and archives open stages; terminal stages stay last and fixed", async () => {
    const pl = ok(await as(owner).call(endpoints.createPipeline, { params: p(), body: { name: "Stage lab", kind: "sales" } }));
    const pp = { ...p(), pipelineId: pl.id };
    const st = ok(await as(owner).call(endpoints.createPipelineStage, { params: pp, body: { name: "Demo", defaultProbability: 50 } }));
    let cur = (await list()).pipelines.find((x) => x.id === pl.id)!;
    expect(cur.stages.map((s) => s.name)).toEqual(["New", "Contacted", "Qualified", "Demo", "Won", "Lost"]);
    const open = cur.stages.filter((s) => s.kind === "open").map((s) => s.id);
    cur = ok(await as(owner).call(endpoints.reorderPipelineStages, { params: pp, body: { stageIds: [...open].reverse() } }));
    expect(cur.stages.map((s) => s.name)).toEqual(["Demo", "Qualified", "Contacted", "New", "Won", "Lost"]);
    expect(failure(await as(owner).call(endpoints.reorderPipelineStages, { params: pp, body: { stageIds: open.slice(1) } })).status).toBe(400);
    expect(ok(await as(owner).call(endpoints.updatePipelineStage, { params: { ...p(), stageId: st.id }, body: { name: "Demo call", defaultProbability: 55 } }))).toMatchObject({ name: "Demo call", defaultProbability: 55 });
    const won = cur.stages.find((s) => s.kind === "won")!;
    expect(failure(await as(owner).call(endpoints.updatePipelineStage, { params: { ...p(), stageId: won.id }, body: { defaultProbability: 90 } })).status).toBe(400);
    expect(code(await as(owner).call(endpoints.archivePipelineStage, { params: { ...p(), stageId: won.id }, body: { moveToStageId: open[0]! } }))).toBe("stage_terminal");
    expect(failure(await as(owner).call(endpoints.archivePipelineStage, { params: { ...p(), stageId: st.id }, body: { moveToStageId: st.id } })).status).toBe(400);
    const arch = ok(await as(owner).call(endpoints.archivePipelineStage, { params: { ...p(), stageId: st.id }, body: { moveToStageId: open[0]! } }));
    expect(arch.archived).toBe(true);
    cur = (await list()).pipelines.find((x) => x.id === pl.id)!;
    const activeOpen = cur.stages.filter((s) => s.kind === "open" && !s.archived);
    expect(activeOpen).toHaveLength(3);
    expect(activeOpen.every((s, i) => i === 0 || s.position > activeOpen[i - 1]!.position)).toBe(true);
    expect(cur.stages.find((s) => s.kind === "won")!.position).toBeGreaterThan(Math.max(...activeOpen.map((s) => s.position)));
  });
  it("probability must be 1..99 for open stages", async () => {
    const pl = (await list()).pipelines[0]!;
    const res = await h.app.request(`/v1/workspaces/${A}/pipelines/${pl.id}/stages`, { method: "POST", headers: { cookie: owner.cookie, origin: "http://localhost:3000", "content-type": "application/json" }, body: JSON.stringify({ name: "Bad", defaultProbability: 100 }) });
    expect(res.status).toBe(400);
  });
});

describe("lost reasons", () => {
  it("creates, renames and archives", async () => {
    const r = ok(await as(owner).call(endpoints.createLostReason, { params: p(), body: { name: "Price" } }));
    expect(ok(await as(owner).call(endpoints.updateLostReason, { params: { ...p(), lostReasonId: r.id }, body: { name: "Too expensive", archived: true } }))).toMatchObject({ name: "Too expensive", archived: true });
    expect(failure(await as(owner).call(endpoints.updateLostReason, { params: { ...p(), lostReasonId: crypto.randomUUID() }, body: { name: "x" } })).status).toBe(404);
  });
});
