import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { endpoints, type ContactDetail, type LeadDto, type PipelineDto } from "@crm/contracts";
import { createSecretBox } from "@crm/integrations";
import type { MetaConnectDeps } from "../src/inbox/meta-connect.ts";
import { bootstrap, failure, ok, type Harness, type TestUser } from "./harness.ts";

// "Ask if missing" (ask_for_value), the stage-change preflight, the value that rides on a move, and the bulk skip count. Nothing talks to Meta: events are only queued rows.
const box = createSecretBox({ k1: Buffer.alloc(32, 9).toString("base64") }, "k1");
let h: Harness;
let owner: TestUser, admin: TestUser, agent: TestUser, viewer: TestUser, ownerB: TestUser;
let A = "", B = "";
let pipe: PipelineDto;
const as = (u: TestUser) => h.clientFor(u);
const p = (ws = A) => ({ workspaceId: ws });
const q = async (text: string, params: unknown[] = []) => (await h.admin.query(text, params)).rows;
const TOKEN = "EAAB-secret-token-" + "q".repeat(40);
let seq = 0;
const dsId = () => `9${Date.now()}${seq++}`;
const open = () => pipe.stages.filter((s) => s.kind === "open");
const won = () => pipe.stages.find((s) => s.kind === "won")!;
const lost = () => pipe.stages.find((s) => s.kind === "lost")!;
const bare = async (ws = A, u = owner) => {
  const d = ok(await as(u).call(endpoints.createCapiDataset, { params: p(ws), body: { datasetId: dsId(), name: "Main", accessToken: TOKEN, events: [] } as never }));
  await q("DELETE FROM capi_event_mappings WHERE workspace_id=$1", [ws]); // tests run one after another: start each from no rules at all
  return d;
};
type M = { triggerType: string; stageId?: string | null; eventName: string; valueMode?: string; fixedValueMinor?: number | null; currency?: string | null; enabled?: boolean; askForValue?: boolean };
const mapBody = (m: M) => ({ stageId: null, valueMode: "lead_value", fixedValueMinor: null, currency: null, enabled: true, askForValue: false, ...m }) as never;
const addMap = async (ds: string, m: M, ws = A) => ok(await as(ws === B ? ownerB : owner).call(endpoints.createCapiMapping, { params: { workspaceId: ws, datasetId: ds }, body: mapBody(m) }));
let phoneSeq = 0;
const mkContact = (ws = A, u = owner) => h.contact(as(u), ws, { name: "Jane Doe", email: `sc${seq++}@example.com`, phone: `+88018${String(Date.now() % 1e5).padStart(5, "0")}${String(phoneSeq++).padStart(3, "0")}` });
const grantConsent = async (c: ContactDetail) => ok(await as(owner).call(endpoints.setAdConsent, { params: { workspaceId: A, contactId: c.id }, body: { status: "granted", source: "manual" } }));
const mkLead = async (c: ContactDetail, extra: Record<string, unknown> = {}) =>
  ok(await as(owner).call(endpoints.createLead, { params: p(), body: { title: "Deal", primaryContactId: c.id, allowDuplicate: true, ...extra } as never })) as LeadDto;
const check = (u: TestUser, c: { id: string }, stageId: string, ws = A) => as(u).call(endpoints.checkStageChange, { params: { workspaceId: ws, contactId: c.id }, query: { stageId } });
const moveBody = (l: LeadDto, stageId: string, extra: Record<string, unknown> = {}) => ({ expectedVersion: l.version, stageId, ...extra }) as never;
const events = (ds: string) => q("SELECT * FROM capi_events WHERE dataset_id=$1 ORDER BY id", [ds]);

beforeAll(async () => {
  h = await bootstrap({ capiCreatesPerUser: 1000 }, { box } as unknown as MetaConnectDeps);
  [owner, admin, agent, viewer, ownerB] = (await Promise.all(["sco", "sca", "scg", "scv", "scb"].map((l) => h.newUser(l)))) as [TestUser, TestUser, TestUser, TestUser, TestUser];
  A = await h.workspace(owner, "Check A", { admin, agent, viewer });
  B = await h.workspace(ownerB, "Check B");
  const cfg = ok(await as(owner).call(endpoints.listPipelines, { params: p() }));
  pipe = cfg.pipelines[0]!;
});
afterAll(async () => { await h.close(); });

describe("ask_for_value on a rule", () => {
  it("defaults to false, round-trips, and is refused unless the value comes from the lead", async () => {
    const d = await bare();
    const m = await addMap(d.id, { triggerType: "lead_won", eventName: "Purchase" });
    expect(m.askForValue).toBe(false);
    const on = ok(await as(owner).call(endpoints.updateCapiMapping, { params: { workspaceId: A, datasetId: d.id, mappingId: m.id }, body: mapBody({ triggerType: "lead_won", eventName: "Purchase", askForValue: true }) }));
    expect(on.askForValue).toBe(true);
    expect(ok(await as(owner).call(endpoints.listCapiMappings, { params: { workspaceId: A, datasetId: d.id } })).items[0]!.askForValue).toBe(true);
    for (const bad of [{ valueMode: "none" }, { valueMode: "fixed", fixedValueMinor: 100, currency: "USD" }]) {
      const e = failure(await as(owner).call(endpoints.createCapiMapping, { params: { workspaceId: A, datasetId: d.id }, body: mapBody({ triggerType: "lead_lost", eventName: "Lead", askForValue: true, ...bad }) }));
      expect([0, 400]).toContain(e.status); // 0: the shared client refuses the body before sending
    }
    // the database repeats the rule
    await expect(q("UPDATE capi_event_mappings SET value_mode='none', ask_for_value=true WHERE id=$1", [m.id])).rejects.toThrow();
  });
  it("the preview names the flag", async () => {
    const d = await bare();
    await addMap(d.id, { triggerType: "lead_won", eventName: "Purchase", askForValue: true });
    const c = await mkContact(); const l = await mkLead(c);
    const pv = ok(await as(owner).call(endpoints.previewCapiMappings, { params: p(), body: { leadId: l.id } }));
    expect(pv.items.find((i) => i.datasetId === d.id)!.askForValue).toBe(true);
  });
});

describe("stage-change preflight", () => {
  it("needs a value when an ask rule fires and the lead has none; says what fires and the currency", async () => {
    const d = await bare();
    await addMap(d.id, { triggerType: "lead_won", eventName: "Purchase", askForValue: true });
    const c = await mkContact(); await mkLead(c);
    const r = ok(await check(owner, c, won().id));
    expect(r).toMatchObject({ needsValue: true, canSetValue: true, stageKind: "won", value: null, valueHidden: false, consent: "none" });
    expect(r.fires.filter((f) => f.eventName === "Purchase" && f.ask)).toHaveLength(1);
    expect(r.currency).toMatch(/^[A-Z]{3}$/);
  });
  it("does not ask when the lead already has a value (and returns it to a caller who may see it)", async () => {
    const d = await bare();
    await addMap(d.id, { triggerType: "lead_won", eventName: "Purchase", askForValue: true });
    const c = await mkContact(); await mkLead(c, { valueMinor: 7000, currency: "EUR" });
    const r = ok(await check(owner, c, won().id));
    expect(r.needsValue).toBe(false);
    expect(r.value).toEqual({ valueMinor: 7000, currency: "EUR" });
    expect(r.currency).toBe("EUR");
  });
  it("skip mode (ask false) fires but never asks; no matching rule fires nothing; a disabled rule or a disabled dataset is ignored", async () => {
    const d = await bare();
    await addMap(d.id, { triggerType: "lead_won", eventName: "Purchase", askForValue: false });
    await addMap(d.id, { triggerType: "lead_stage_entered", stageId: open()[1]!.id, eventName: "Schedule", askForValue: true, enabled: false });
    const c = await mkContact(); await mkLead(c);
    const w = ok(await check(owner, c, won().id));
    expect(w.needsValue).toBe(false);
    expect(w.fires.some((f) => f.eventName === "Purchase" && !f.ask)).toBe(true);
    expect(ok(await check(owner, c, open()[1]!.id)).fires.filter((f) => f.eventName === "Schedule")).toHaveLength(0);
    expect(ok(await check(owner, c, lost().id)).fires.filter((f) => f.eventName === "Purchase")).toHaveLength(0);
    ok(await as(owner).call(endpoints.disableCapiDataset, { params: { workspaceId: A, datasetId: d.id } }));
    expect(ok(await check(owner, c, won().id)).fires.some((f) => f.eventName === "Purchase")).toBe(false);
  });
  it("a stage rule fires on its stage only; a contact with no lead is checked as creation (and won goes through the first stage)", async () => {
    const d = await bare();
    await addMap(d.id, { triggerType: "lead_stage_entered", stageId: open()[1]!.id, eventName: "Schedule", askForValue: true });
    await addMap(d.id, { triggerType: "lead_created", eventName: "Lead", askForValue: true });
    const c = await mkContact(); // no lead yet
    const r = ok(await check(owner, c, open()[1]!.id));
    expect(r.fires.filter((f) => f.eventName === "Schedule" || f.eventName === "Lead").map((f) => f.eventName).sort()).toEqual(["Lead", "Schedule"]);
    expect(r.needsValue).toBe(true);
    const w = ok(await check(owner, c, won().id));
    expect(w.fires.some((f) => f.eventName === "Lead")).toBe(true); // created on the way
    expect(w.fires.some((f) => f.eventName === "Schedule")).toBe(false);
  });
  it("reports ad consent as it is", async () => {
    const d = await bare();
    await addMap(d.id, { triggerType: "lead_won", eventName: "Purchase", askForValue: true });
    const c = await mkContact(); await mkLead(c);
    expect(ok(await check(owner, c, won().id)).consent).toBe("none");
    await grantConsent(c);
    expect(ok(await check(owner, c, won().id)).consent).toBe("granted");
    ok(await as(owner).call(endpoints.setAdConsent, { params: { workspaceId: A, contactId: c.id }, body: { status: "revoked", source: "manual" } }));
    expect(ok(await check(owner, c, won().id)).consent).toBe("revoked");
  });
  it("an agent without value access cannot set it and is never shown it; with an edit grant they can; viewers and strangers are refused", async () => {
    const d = await bare();
    await addMap(d.id, { triggerType: "lead_won", eventName: "Purchase", askForValue: true });
    const c1 = await mkContact(); await mkLead(c1); // no value
    const c2 = await mkContact(); const l2 = await mkLead(c2, { valueMinor: 123456, currency: "USD" });
    const noGrant = ok(await check(agent, c1, won().id));
    expect(noGrant).toMatchObject({ needsValue: true, canSetValue: false, value: null });
    const hidden = await check(agent, c2, won().id);
    const body = JSON.stringify(ok(hidden));
    expect(ok(hidden)).toMatchObject({ value: null, valueHidden: true, canSetValue: false, needsValue: false });
    expect(body).not.toContain("123456");
    ok(await as(owner).call(endpoints.setLeadValueGrant, { params: { workspaceId: A, leadId: l2.id, userId: agent.id }, body: { canEdit: true } }));
    expect(ok(await check(agent, c2, won().id))).toMatchObject({ canSetValue: true, valueHidden: false, value: { valueMinor: 123456, currency: "USD" } });
    expect(failure(await check(viewer, c1, won().id)).status).toBe(403);
  });
  it("is scoped to the workspace: another workspace's contact is not found and its rules never show", async () => {
    const dB = await bare(B, ownerB);
    const mB = await addMap(dB.id, { triggerType: "lead_won", eventName: "Purchase", askForValue: true }, B);
    const c = await mkContact(); await mkLead(c);
    const cB = await mkContact(B, ownerB);
    expect(failure(await check(owner, cB, won().id)).status).toBe(404);
    expect(ok(await check(owner, c, won().id)).fires.some((f) => f.mappingId === mB.id)).toBe(false);
    const bPipe = ok(await as(ownerB).call(endpoints.listPipelines, { params: p(B) })).pipelines[0]!;
    expect(failure(await check(owner, c, bPipe.stages.find((s) => s.kind === "won")!.id)).status).toBe(400); // a stage of another workspace
  });
});

describe("a move with a value", () => {
  it("saves the value and queues the event WITH it, in one request; one audit entry; the lead shows the value", async () => {
    const d = await bare();
    await addMap(d.id, { triggerType: "lead_won", eventName: "Purchase", askForValue: true });
    const c = await mkContact(); await grantConsent(c); const l = await mkLead(c);
    const out = ok(await as(owner).call(endpoints.moveLead, { params: { workspaceId: A, leadId: l.id }, body: moveBody(l, won().id, { valueMinor: 123456, currency: "USD" }) })) as LeadDto;
    expect(out).toMatchObject({ valueMinor: 123456, currency: "USD", outcome: "won" });
    const ev = await events(d.id);
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ event_name: "Purchase", status: "pending" });
    expect(ev[0].payload.custom_data).toEqual({ value: 1234.56, currency: "USD" });
    const audits = await q("SELECT action, summary FROM audit_log WHERE entity_id=$1 ORDER BY id", [l.id]);
    expect(audits.filter((a) => a.action === "lead.won")).toHaveLength(1);
    expect(audits.some((a) => a.action === "lead.updated")).toBe(false);
    expect(JSON.stringify(audits)).not.toContain("123456");
  });
  it("without a value the event is recorded as skipped (no_value) exactly as before", async () => {
    const d = await bare();
    await addMap(d.id, { triggerType: "lead_won", eventName: "Purchase", askForValue: true });
    const c = await mkContact(); await grantConsent(c); const l = await mkLead(c);
    ok(await as(owner).call(endpoints.moveLead, { params: { workspaceId: A, leadId: l.id }, body: moveBody(l, won().id) }));
    expect((await events(d.id))[0]).toMatchObject({ status: "skipped", last_error: "no_value" });
  });
  it("a stale version is a conflict and nothing is written; a bad value is refused; value and currency go together", async () => {
    const d = await bare();
    await addMap(d.id, { triggerType: "lead_won", eventName: "Purchase", askForValue: true });
    const c = await mkContact(); await grantConsent(c); const l = await mkLead(c);
    const stale = failure(await as(owner).call(endpoints.moveLead, { params: { workspaceId: A, leadId: l.id }, body: { expectedVersion: l.version + 5, stageId: won().id, valueMinor: 5000, currency: "USD" } as never }));
    expect(stale.status).toBe(409);
    for (const bad of [{ valueMinor: 0, currency: "USD" }, { valueMinor: -5, currency: "USD" }, { valueMinor: 1.5, currency: "USD" }, { valueMinor: 9_000_000_000_001, currency: "USD" }, { valueMinor: 5000 }, { currency: "USD" }])
      expect([0, 400]).toContain(failure(await as(owner).call(endpoints.moveLead, { params: { workspaceId: A, leadId: l.id }, body: moveBody(l, won().id, bad) })).status);
    const now = ok(await as(owner).call(endpoints.getLead, { params: { workspaceId: A, leadId: l.id } }));
    expect(now).toMatchObject({ outcome: "open", valueMinor: null, version: l.version });
    expect(await events(d.id)).toHaveLength(0);
  });
  it("an agent without edit access cannot set the value through a move: 403, lead unchanged, nothing queued", async () => {
    const d = await bare();
    await addMap(d.id, { triggerType: "lead_won", eventName: "Purchase", askForValue: true });
    const c = await mkContact(); await grantConsent(c); const l = await mkLead(c);
    const e = failure(await as(agent).call(endpoints.moveLead, { params: { workspaceId: A, leadId: l.id }, body: moveBody(l, won().id, { valueMinor: 5000, currency: "USD" }) }));
    expect(e.status).toBe(403);
    expect(ok(await as(owner).call(endpoints.getLead, { params: { workspaceId: A, leadId: l.id } }))).toMatchObject({ outcome: "open", valueMinor: null });
    expect(await events(d.id)).toHaveLength(0);
    // Move without value is still allowed for the same agent
    ok(await as(agent).call(endpoints.moveLead, { params: { workspaceId: A, leadId: l.id }, body: moveBody(l, won().id) }));
  });
  it("PUT contact lead: stage and value in one request (existing lead and a contact without a lead)", async () => {
    const d = await bare();
    await addMap(d.id, { triggerType: "lead_won", eventName: "Purchase", askForValue: true });
    const c = await mkContact(); await grantConsent(c); const l = await mkLead(c);
    const r1 = ok(await as(owner).call(endpoints.putContactLead, { params: { workspaceId: A, contactId: c.id }, body: { expectedVersion: l.version, stageId: won().id, valueMinor: 2500, currency: "USD" } }));
    expect(r1.lead).toMatchObject({ valueMinor: 2500, stageId: won().id });
    const c2 = await mkContact(); await grantConsent(c2);
    ok(await as(owner).call(endpoints.putContactLead, { params: { workspaceId: A, contactId: c2.id }, body: { stageId: won().id, valueMinor: 900, currency: "USD" } }));
    const ev = await events(d.id);
    expect(ev.map((e) => e.payload.custom_data)).toEqual([{ value: 25, currency: "USD" }, { value: 9, currency: "USD" }]);
    const audits = await q("SELECT action FROM audit_log WHERE entity_id=$1", [l.id]);
    expect(audits.filter((a) => a.action === "lead.updated")).toHaveLength(0);
  });
});

describe("bulk stage change", () => {
  it("never asks: moves everyone, records the event as skipped, and counts the leads that needed a value", async () => {
    const d = await bare();
    await addMap(d.id, { triggerType: "lead_won", eventName: "Purchase", askForValue: true });
    const noV = await mkContact(); await grantConsent(noV); await mkLead(noV);
    const hasV = await mkContact(); await grantConsent(hasV); await mkLead(hasV, { valueMinor: 4000, currency: "USD" });
    const r = ok(await as(owner).call(endpoints.bulkContactStage, { params: p(), body: { contactIds: [noV.id, hasV.id], stageId: won().id } }));
    expect(r.results.map((x) => x.ok)).toEqual([true, true]);
    expect(r.results.filter((x) => x.noValue)).toHaveLength(1);
    expect(r.results.find((x) => x.id === noV.id)!.noValue).toBe(true);
    const ev = await events(d.id);
    expect(ev.map((e) => e.status).sort()).toEqual(["pending", "skipped"]);
    expect(ev.find((e) => e.status === "skipped")!.last_error).toBe("no_value");
  });
});
