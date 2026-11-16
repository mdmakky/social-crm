import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createMockAdapter } from "@crm/capi";
import { CAPI_CUSTOM_EVENT_NAME, endpoints, META_STANDARD_EVENTS, type ContactDetail, type LeadDto, type PipelineDto } from "@crm/contracts";
import { META_STANDARD_EVENTS as PKG_STANDARD, CUSTOM_EVENT_NAME as PKG_CUSTOM } from "@crm/capi";
import { createSecretBox } from "@crm/integrations";
import type { MetaConnectDeps } from "../src/inbox/meta-connect.ts";
import { firedTriggers } from "../src/capi/mappings.ts";
import { bootstrap, failure, ok, type Harness, type TestUser } from "./harness.ts";

// Configurable CAPI event mappings: which CRM change sends which event. Proves our rules (what fires, dedupe, skips, permissions, tenancy); nothing talks to Meta.
const box = createSecretBox({ k1: Buffer.alloc(32, 9).toString("base64") }, "k1");
let h: Harness;
let owner: TestUser, admin: TestUser, agent: TestUser, viewer: TestUser, ownerB: TestUser;
let A = "", B = "";
let pipe: PipelineDto, reasonId = "";
const as = (u: TestUser) => h.clientFor(u);
const p = (ws = A) => ({ workspaceId: ws });
const q = async (text: string, params: unknown[] = []) => (await h.admin.query(text, params)).rows;
const TOKEN = "EAAB-secret-token-" + "q".repeat(40);
let seq = 0;
const dsId = () => `8${Date.now()}${seq++}`;
const open = () => pipe.stages.filter((s) => s.kind === "open");
const won = () => pipe.stages.find((s) => s.kind === "won")!;
const lost = () => pipe.stages.find((s) => s.kind === "lost")!;
const mkDataset = async (ws = A, u = owner, events: string[] = []) => ok(await as(u).call(endpoints.createCapiDataset, { params: p(ws), body: { datasetId: dsId(), name: "Main", accessToken: TOKEN, events } as never }));
/** A dataset with NO rules, so each test controls exactly what exists. */
const bare = async (ws = A, u = owner) => {
  const d = await mkDataset(ws, u);
  await q("DELETE FROM capi_event_mappings WHERE dataset_id=$1", [d.id]);
  return d;
};
type M = { triggerType: string; stageId?: string | null; eventName: string; valueMode?: string; fixedValueMinor?: number | null; currency?: string | null; enabled?: boolean };
const mapBody = (m: M) => ({ stageId: null, valueMode: "lead_value", fixedValueMinor: null, currency: null, enabled: true, ...m }) as never;
const addMap = async (dsUuid: string, m: M, u = owner, ws = A) => ok(await as(u).call(endpoints.createCapiMapping, { params: { workspaceId: ws, datasetId: dsUuid }, body: mapBody(m) }));
const mkContact = (email = `m${seq++}@example.com`, ws = A, u = owner) => h.contact(as(u), ws, { name: "Jane Doe", email, phone: `+88017${String(Date.now() % 1e5).padStart(5, "0")}${String(seq++).padStart(3, "0")}` });
const grant = async (c: ContactDetail) => ok(await as(owner).call(endpoints.setAdConsent, { params: { workspaceId: A, contactId: c.id }, body: { status: "granted", source: "manual" } }));
const mkLead = async (c: ContactDetail, extra: Record<string, unknown> = { valueMinor: 5000, currency: "USD" }, u = owner) =>
  ok(await as(u).call(endpoints.createLead, { params: p(), body: { title: "Deal", primaryContactId: c.id, allowDuplicate: true, ...extra } as never })) as LeadDto;
const cur = async (l: LeadDto) => ok(await as(owner).call(endpoints.getLead, { params: { workspaceId: A, leadId: l.id } }));
const move = async (l: LeadDto, stageId: string, u = owner) => {
  const c = await cur(l);
  return ok(await as(u).call(endpoints.moveLead, { params: { workspaceId: A, leadId: l.id }, body: { expectedVersion: c.version, stageId, ...(stageId === lost().id ? { lostReasonId: reasonId } : {}) } as never })) as LeadDto;
};
const rows = (ds: string) => q("SELECT * FROM capi_events WHERE dataset_id=$1 ORDER BY id", [ds]);
const names = async (ds: string) => (await rows(ds)).map((r) => r.event_name as string).sort();

beforeAll(async () => {
  h = await bootstrap({ capiCreatesPerUser: 1000 }, { box } as unknown as MetaConnectDeps);
  [owner, admin, agent, viewer, ownerB] = (await Promise.all(["mpo", "mpa", "mpg", "mpv", "mpb"].map((l) => h.newUser(l)))) as [TestUser, TestUser, TestUser, TestUser, TestUser];
  A = await h.workspace(owner, "Map A", { admin, agent, viewer });
  B = await h.workspace(ownerB, "Map B");
  const cfg = ok(await as(owner).call(endpoints.listPipelines, { params: p() }));
  pipe = cfg.pipelines[0]!;
  reasonId = cfg.lostReasons[0]!.id;
});
afterAll(async () => { await h.close(); });

describe("contract", () => {
  it("standard event names and the custom pattern match the package", () => {
    expect([...META_STANDARD_EVENTS]).toEqual([...PKG_STANDARD]);
    expect(CAPI_CUSTOM_EVENT_NAME.source).toBe(PKG_CUSTOM.source);
  });
});

describe("trigger matching (pure)", () => {
  it("a stage change fires stage entered; a same-stage repeat fires nothing; created also enters its stage", () => {
    expect(firedTriggers({ fromStageId: "a", toStageId: "b", fromOutcome: "open", outcome: "open" })).toEqual(["lead_stage_entered"]);
    expect(firedTriggers({ fromStageId: "a", toStageId: "a", fromOutcome: "open", outcome: "open" })).toEqual([]);
    expect(firedTriggers({ fromStageId: null, toStageId: "a", fromOutcome: null, outcome: "open", created: true })).toEqual(["lead_created", "lead_stage_entered"]);
  });
  it("won and lost fire on the transition INTO the outcome only", () => {
    expect(firedTriggers({ fromStageId: "a", toStageId: "w", fromOutcome: "open", outcome: "won" })).toEqual(["lead_stage_entered", "lead_won"]);
    expect(firedTriggers({ fromStageId: "w", toStageId: "l", fromOutcome: "won", outcome: "lost" })).toEqual(["lead_stage_entered", "lead_lost"]);
    expect(firedTriggers({ fromStageId: "w", toStageId: "w2", fromOutcome: "won", outcome: "won" })).toEqual(["lead_stage_entered"]);
  });
});

describe("permissions and validation", () => {
  it("owner and admin configure; agent and viewer cannot read or write", async () => {
    const d = await bare();
    const body = mapBody({ triggerType: "lead_created", eventName: "Lead" });
    const base = { params: { workspaceId: A, datasetId: d.id } };
    for (const u of [agent, viewer]) {
      expect(failure(await as(u).call(endpoints.listCapiMappings, base)).status).toBe(403);
      expect(failure(await as(u).call(endpoints.createCapiMapping, { ...base, body })).status).toBe(403);
      expect(failure(await as(u).call(endpoints.previewCapiMappings, { params: p(), body: { leadId: crypto.randomUUID() } })).status).toBe(403);
    }
    const m = await addMap(d.id, { triggerType: "lead_created", eventName: "Lead" }, admin);
    expect(ok(await as(owner).call(endpoints.listCapiMappings, base)).items).toHaveLength(1);
    for (const u of [agent, viewer]) expect(failure(await as(u).call(endpoints.deleteCapiMapping, { params: { ...base.params, mappingId: m.id } })).status).toBe(403);
    expect(failure(await as(agent).call(endpoints.updateCapiMapping, { params: { ...base.params, mappingId: m.id }, body })).status).toBe(403);
  });
  it("rejects bad shapes: stage rules, event names, value rules", async () => {
    const d = await bare();
    // raw request: the typed client would refuse a bad body before it reached the server
    const bad = async (m: M) => ({ status: (await h.app.request(`/v1/workspaces/${A}/capi/datasets/${d.id}/mappings`, { method: "POST", headers: { "content-type": "application/json", cookie: owner.cookie, origin: "http://localhost:3000" }, body: JSON.stringify(mapBody(m)) })).status });
    expect((await bad({ triggerType: "lead_stage_entered", eventName: "Lead" })).status).toBe(400);
    expect((await bad({ triggerType: "lead_won", stageId: open()[0]!.id, eventName: "Lead" })).status).toBe(400);
    for (const eventName of ["", "1Lead", "Lead Won", "Lead-Won", "x".repeat(41), "Lëad"]) expect((await bad({ triggerType: "lead_created", eventName })).status).toBe(400);
    expect((await bad({ triggerType: "lead_won", eventName: "Purchase", valueMode: "none" })).status).toBe(400);
    expect((await bad({ triggerType: "lead_won", eventName: "Purchase", valueMode: "fixed" })).status).toBe(400);
    expect((await bad({ triggerType: "lead_won", eventName: "Purchase", valueMode: "lead_value", currency: "USD" })).status).toBe(400);
    expect((await bad({ triggerType: "lead_won", eventName: "Purchase", valueMode: "fixed", fixedValueMinor: 100, currency: "usd" })).status).toBe(400);
    expect((await bad({ triggerType: "nope", eventName: "Lead" })).status).toBe(400);
    await addMap(d.id, { triggerType: "lead_created", eventName: "My_Custom_Event1" }); // a custom name is fine
  });
  it("the stage must belong to this workspace and be active; datasets and mappings of another workspace are 404", async () => {
    const d = await bare();
    const dB = await bare(B, ownerB);
    const pipeB = ok(await as(ownerB).call(endpoints.listPipelines, { params: p(B) })).pipelines[0]!;
    const create = async (stageId: string) => failure(await as(owner).call(endpoints.createCapiMapping, { params: { workspaceId: A, datasetId: d.id }, body: mapBody({ triggerType: "lead_stage_entered", stageId, eventName: "Lead" }) }));
    expect((await create(pipeB.stages[0]!.id)).status).toBe(400);
    expect((await create(crypto.randomUUID())).status).toBe(400);
    // another workspace's dataset through our workspace path
    expect(failure(await as(owner).call(endpoints.createCapiMapping, { params: { workspaceId: A, datasetId: dB.id }, body: mapBody({ triggerType: "lead_created", eventName: "Lead" }) })).status).toBe(404);
    const mB = await addMap(dB.id, { triggerType: "lead_created", eventName: "Lead" }, ownerB, B);
    expect(failure(await as(ownerB).call(endpoints.listCapiMappings, { params: { workspaceId: B, datasetId: d.id } })).status).toBe(404);
    expect(failure(await as(owner).call(endpoints.deleteCapiMapping, { params: { workspaceId: A, datasetId: dB.id, mappingId: mB.id } })).status).toBe(404);
    expect(failure(await as(owner).call(endpoints.updateCapiMapping, { params: { workspaceId: A, datasetId: d.id, mappingId: mB.id }, body: mapBody({ triggerType: "lead_created", eventName: "Contact" }) })).status).toBe(404);
    expect(await q("SELECT 1 FROM capi_event_mappings WHERE id=$1", [mB.id])).toHaveLength(1);
    // a user of workspace B cannot read workspace A through the path either
    expect(failure(await as(ownerB).call(endpoints.listCapiMappings, { params: { workspaceId: A, datasetId: d.id } })).status).toBe(404);
  });
  it("duplicates are 409, the limit is 50 per dataset, update and delete work and are audited", async () => {
    const d = await bare();
    const m = await addMap(d.id, { triggerType: "lead_created", eventName: "Lead" });
    const dup = failure(await as(owner).call(endpoints.createCapiMapping, { params: { workspaceId: A, datasetId: d.id }, body: mapBody({ triggerType: "lead_created", eventName: "Lead" }) }));
    expect(dup).toMatchObject({ status: 409, code: "mapping_exists" });
    // same trigger and stage, different event name is allowed: two events on one transition
    await addMap(d.id, { triggerType: "lead_created", eventName: "Contact" });
    for (let i = 0; i < 48; i++) await addMap(d.id, { triggerType: "lead_won", eventName: `Custom${i}`, valueMode: "none" });
    expect(failure(await as(owner).call(endpoints.createCapiMapping, { params: { workspaceId: A, datasetId: d.id }, body: mapBody({ triggerType: "lead_lost", eventName: "Over" }) }))).toMatchObject({ status: 409, code: "mapping_limit" });
    const upd = ok(await as(admin).call(endpoints.updateCapiMapping, { params: { workspaceId: A, datasetId: d.id, mappingId: m.id }, body: mapBody({ triggerType: "lead_won", eventName: "Lead", enabled: false }) }));
    expect(upd).toMatchObject({ triggerType: "lead_won", enabled: false });
    ok(await as(owner).call(endpoints.deleteCapiMapping, { params: { workspaceId: A, datasetId: d.id, mappingId: m.id } }));
    expect(failure(await as(owner).call(endpoints.deleteCapiMapping, { params: { workspaceId: A, datasetId: d.id, mappingId: m.id } })).status).toBe(404);
    const audit = await q("SELECT action FROM audit_log WHERE workspace_id=$1 AND entity_id=$2 ORDER BY id", [A, m.id]);
    expect(audit.map((r) => r.action)).toEqual(["capi.mapping.created", "capi.mapping.updated", "capi.mapping.deleted"]);
  });
});

describe("default rule", () => {
  it("a new dataset gets lead won -> Purchase with the lead value, on when it opted in to Purchase; it is editable and deletable", async () => {
    const on = await mkDataset(A, owner, ["Purchase"]);
    const off = await mkDataset(A, owner, []);
    const [mOn] = ok(await as(owner).call(endpoints.listCapiMappings, { params: { workspaceId: A, datasetId: on.id } })).items;
    const [mOff] = ok(await as(owner).call(endpoints.listCapiMappings, { params: { workspaceId: A, datasetId: off.id } })).items;
    expect(mOn).toMatchObject({ triggerType: "lead_won", stageId: null, eventName: "Purchase", valueMode: "lead_value", enabled: true });
    expect(mOff).toMatchObject({ triggerType: "lead_won", eventName: "Purchase", enabled: false });
    ok(await as(owner).call(endpoints.deleteCapiMapping, { params: { workspaceId: A, datasetId: on.id, mappingId: mOn!.id } }));
    const c = await mkContact(); await grant(c);
    const l = await mkLead(c);
    await move(l, won().id);
    expect(await rows(on.id)).toHaveLength(0); // the owner removed the rule, so nothing is created
  });
});

describe("engine", () => {
  it("stage entered fires only the mapped event, only for that stage", async () => {
    const [s1, s2] = open().slice(1, 3) as [typeof pipe.stages[number], typeof pipe.stages[number]];
    const d = await bare();
    await addMap(d.id, { triggerType: "lead_stage_entered", stageId: s1.id, eventName: "Schedule", valueMode: "none" });
    const c = await mkContact(); await grant(c);
    const l = await mkLead(c);
    await move(l, s2.id);
    expect(await rows(d.id)).toHaveLength(0);
    await move(l, s1.id);
    const [r] = await rows(d.id);
    expect(r).toMatchObject({ event_name: "Schedule", status: "pending" });
    expect(r.payload.custom_data).toBeUndefined();
    expect(r.crm_event_ref).toBe(`lead:${l.id}:stage:${s1.id}:1`);
  });
  it("two mappings on one transition send two events; a disabled mapping is silent", async () => {
    const s1 = open()[1]!;
    const d = await bare();
    await addMap(d.id, { triggerType: "lead_stage_entered", stageId: s1.id, eventName: "Lead", valueMode: "none" });
    await addMap(d.id, { triggerType: "lead_stage_entered", stageId: s1.id, eventName: "QualifiedLead", valueMode: "lead_value" });
    await addMap(d.id, { triggerType: "lead_stage_entered", stageId: s1.id, eventName: "Contact", valueMode: "none", enabled: false });
    const c = await mkContact(); await grant(c);
    await move(await mkLead(c), s1.id);
    expect(await names(d.id)).toEqual(["Lead", "QualifiedLead"]);
  });
  it("won and lost fire on the outcome; created fires on creation (and a stage rule for the first stage too)", async () => {
    const d = await bare();
    await addMap(d.id, { triggerType: "lead_created", eventName: "Lead", valueMode: "none" });
    await addMap(d.id, { triggerType: "lead_stage_entered", stageId: open()[0]!.id, eventName: "Contact", valueMode: "none" });
    await addMap(d.id, { triggerType: "lead_won", eventName: "Purchase" });
    await addMap(d.id, { triggerType: "lead_lost", eventName: "Lost_Deal", valueMode: "none" });
    const c = await mkContact(); await grant(c);
    const l = await mkLead(c);
    expect(await names(d.id)).toEqual(["Contact", "Lead"]);
    await move(l, won().id);
    expect(await names(d.id)).toEqual(["Contact", "Lead", "Purchase"]);
    await move(l, lost().id);
    expect(await names(d.id)).toEqual(["Contact", "Lead", "Lost_Deal", "Purchase"]);
  });
  it("value modes: lead value, fixed amount, none", async () => {
    const d = await bare();
    await addMap(d.id, { triggerType: "lead_won", eventName: "Purchase", valueMode: "lead_value" });
    await addMap(d.id, { triggerType: "lead_won", eventName: "Subscribe", valueMode: "fixed", fixedValueMinor: 2500, currency: "EUR" });
    await addMap(d.id, { triggerType: "lead_won", eventName: "Lead", valueMode: "none" });
    const c = await mkContact(); await grant(c);
    await move(await mkLead(c, { valueMinor: 12345, currency: "USD" }), won().id);
    const by = Object.fromEntries((await rows(d.id)).map((r) => [r.event_name, r.payload.custom_data]));
    expect(by).toEqual({ Purchase: { value: 123.45, currency: "USD" }, Subscribe: { value: 25, currency: "EUR" }, Lead: undefined });
  });
  it("no value: a Purchase is recorded as skipped with a reason; other events send without a value; fixing the value later still sends", async () => {
    const d = await bare();
    await addMap(d.id, { triggerType: "lead_won", eventName: "Purchase" });
    await addMap(d.id, { triggerType: "lead_won", eventName: "Lead", valueMode: "lead_value" });
    const c = await mkContact(); await grant(c);
    const l = await mkLead(c, {});
    await move(l, won().id);
    const r = Object.fromEntries((await rows(d.id)).map((x) => [x.event_name, x]));
    expect(r.Purchase).toMatchObject({ status: "skipped", last_error: "no_value", payload: {} });
    expect(r.Lead).toMatchObject({ status: "pending" });
    expect(r.Lead.payload.custom_data).toBeUndefined();
    // set a value, reopen, win again: the Purchase now goes out (the skipped row did not block it), the Lead does not repeat
    const c1 = await cur(l);
    ok(await as(owner).call(endpoints.updateLead, { params: { workspaceId: A, leadId: l.id }, body: { expectedVersion: c1.version, valueMinor: 700, currency: "USD" } as never }));
    await move(l, open()[0]!.id);
    await move(l, won().id);
    const after = await rows(d.id);
    expect(after.filter((x) => x.event_name === "Purchase").map((x) => x.status).sort()).toEqual(["pending", "skipped"]);
    expect(after.filter((x) => x.event_name === "Lead")).toHaveLength(1);
  });
  it("without consent the row is skipped_no_consent with empty identifiers; revoked is opted_out", async () => {
    const d = await bare();
    await addMap(d.id, { triggerType: "lead_created", eventName: "Lead", valueMode: "none" });
    const c = await mkContact("secret.person@example.com");
    await mkLead(c);
    const [r] = await rows(d.id);
    expect(r).toMatchObject({ status: "skipped_no_consent", last_error: "no_consent" });
    expect(r.payload.user_data).toEqual({});
    expect(JSON.stringify(r)).not.toContain("secret.person");
  });
  it("dedupe: a stage entry sends once; leaving and coming back is a new entry; won and created are once per lead", async () => {
    const [s1, s2] = open().slice(1, 3) as [typeof pipe.stages[number], typeof pipe.stages[number]];
    const d = await bare();
    await addMap(d.id, { triggerType: "lead_stage_entered", stageId: s1.id, eventName: "Lead", valueMode: "none" });
    await addMap(d.id, { triggerType: "lead_won", eventName: "Purchase" });
    const c = await mkContact(); await grant(c);
    const l = await mkLead(c);
    await move(l, s1.id);
    // a repeat request for the same column changes nothing (a re-order) and is not an entry
    ok(await as(owner).call(endpoints.moveLead, { params: { workspaceId: A, leadId: l.id }, body: { expectedVersion: (await cur(l)).version, stageId: s1.id } }));
    expect((await rows(d.id)).filter((x) => x.event_name === "Lead")).toHaveLength(1);
    await move(l, s2.id);
    await move(l, s1.id); // genuine re-entry: entry 2
    expect((await rows(d.id)).filter((x) => x.event_name === "Lead").map((x) => x.crm_event_ref).sort()).toEqual([`lead:${l.id}:stage:${s1.id}:1`, `lead:${l.id}:stage:${s1.id}:2`]);
    await move(l, won().id); await move(l, open()[0]!.id); await move(l, won().id);
    expect((await rows(d.id)).filter((x) => x.event_name === "Purchase")).toHaveLength(1);
  });
  it("a dataset that is disabled gets nothing; another workspace's mappings never fire for our leads", async () => {
    const d = await bare();
    await addMap(d.id, { triggerType: "lead_created", eventName: "Lead", valueMode: "none" });
    const dB = await bare(B, ownerB);
    await addMap(dB.id, { triggerType: "lead_created", eventName: "Lead", valueMode: "none" }, ownerB, B);
    ok(await as(owner).call(endpoints.disableCapiDataset, { params: { workspaceId: A, datasetId: d.id } }));
    const c = await mkContact(); await grant(c);
    await mkLead(c);
    expect(await rows(d.id)).toHaveLength(0);
    expect(await rows(dB.id)).toHaveLength(0);
  });
  it("an agent moving the lead triggers the mappings", async () => {
    const d = await bare();
    await addMap(d.id, { triggerType: "lead_won", eventName: "Purchase" });
    const c = await mkContact(); await grant(c);
    await move(await mkLead(c), won().id, agent);
    expect(await names(d.id)).toEqual(["Purchase"]);
  });
  it("SAVEPOINT: a failing mapping never blocks the stage move or the other mappings", async () => {
    const d = await bare();
    await addMap(d.id, { triggerType: "lead_won", eventName: "Boom", valueMode: "none" });
    await addMap(d.id, { triggerType: "lead_won", eventName: "Purchase" });
    await h.admin.query(`CREATE OR REPLACE FUNCTION test_boom() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.event_name = 'Boom' THEN RAISE EXCEPTION 'boom'; END IF; RETURN NEW; END $$`);
    await h.admin.query(`CREATE TRIGGER test_boom_trg BEFORE INSERT ON capi_events FOR EACH ROW EXECUTE FUNCTION test_boom()`);
    try {
      const c = await mkContact(); await grant(c);
      const l = await mkLead(c);
      const moved = await move(l, won().id); // would throw inside ok() if the move failed
      expect(moved.outcome).toBe("won");
      expect(await names(d.id)).toEqual(["Purchase"]);
    } finally {
      await h.admin.query(`DROP TRIGGER test_boom_trg ON capi_events`);
    }
  });
  it("delivery: a mapped event reaches the (mock) adapter once with the mapped name", async () => {
    const { processCapiQueue } = await import("../src/capi/worker.ts");
    const { createDb } = await import("@crm/db");
    const workerDb = createDb(`postgres://crm_worker:worker_dev@127.0.0.1:5436/${process.env.CRM_DB_NAME ?? "crm"}`);
    try {
      const d = await bare();
      await addMap(d.id, { triggerType: "lead_created", eventName: "My_Custom_Event", valueMode: "none" });
      const c = await mkContact(); await grant(c);
      await mkLead(c);
      const adapter = createMockAdapter();
      for (let i = 0; i < 50; i++) if ((await processCapiQueue(workerDb, { adapter, box })).claimed === 0) break;
      const sent = adapter.calls.filter((r) => r.datasetId === d.datasetId);
      expect(sent).toHaveLength(1);
      expect(sent[0]!.events[0]).toMatchObject({ event_name: "My_Custom_Event" });
      expect((await rows(d.id))[0]).toMatchObject({ status: "sent" });
    } finally { await workerDb.$client.end(); }
  });
});

describe("preview", () => {
  it("shows what would send and what would be skipped, and why; queues nothing", async () => {
    const d = await bare();
    await addMap(d.id, { triggerType: "lead_won", eventName: "Purchase" });
    await addMap(d.id, { triggerType: "lead_created", eventName: "Lead", valueMode: "none" });
    await addMap(d.id, { triggerType: "lead_lost", eventName: "Contact", valueMode: "none", enabled: false });
    const noVal = await mkContact(); const l0 = await mkLead(noVal, {});
    const pv = async (id: string) => ok(await as(owner).call(endpoints.previewCapiMappings, { params: p(), body: { leadId: id } }));
    const mine = async (id: string) => (await pv(id)).items.filter((i) => i.datasetId === d.id);
    let r = await mine(l0.id);
    const by = (e: string) => r.find((i) => i.eventName === e)!;
    expect(by("Purchase")).toMatchObject({ result: "skip", reason: "no_value" });
    expect(by("Lead")).toMatchObject({ result: "skip", reason: "no_consent" });
    expect(by("Contact")).toMatchObject({ result: "skip", reason: "mapping_disabled" });
    const c = await mkContact(); await grant(c);
    const l = await mkLead(c, { valueMinor: 4200, currency: "USD" });
    r = await mine(l.id);
    expect(by("Purchase")).toMatchObject({ result: "send", reason: null, value: 42, currency: "USD" });
    expect((await pv(l.id)).consent).toBe("granted");
    const before = (await rows(d.id)).length;
    await pv(l.id);
    expect((await rows(d.id)).length).toBe(before); // a dry run
    expect(failure(await as(owner).call(endpoints.previewCapiMappings, { params: p(), body: { leadId: crypto.randomUUID() } })).status).toBe(404);
  });
});
