import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, type Db } from "@crm/db";
import { createMockAdapter, type SendRequest, type SendResult } from "@crm/capi";
import { CAPI_EVENT_NAMES, endpoints, type ContactDetail, type LeadDto, type PipelineDto } from "@crm/contracts";
import { createSecretBox } from "@crm/integrations";
import { CAPI_EVENT_NAMES as PKG_NAMES } from "@crm/capi";
import type { MetaConnectDeps } from "../src/inbox/meta-connect.ts";
import { processCapiQueue } from "../src/capi/worker.ts";
import { bootstrap, failure, ok, type Harness, type TestUser } from "./harness.ts";

// CAPI slice 1 (mock). These tests prove OUR behaviour (permissions, sealing, consent gate, dedupe, retry, tenancy); nothing here talks to Meta.
const DB = process.env.CRM_DB_NAME ?? "crm";
const box = createSecretBox({ k1: Buffer.alloc(32, 9).toString("base64") }, "k1");
let h: Harness, workerDb: Db;
let owner: TestUser, admin: TestUser, agent: TestUser, viewer: TestUser, ownerB: TestUser;
let A = "", B = "";
let pipe: PipelineDto;
const as = (u: TestUser) => h.clientFor(u);
const p = (ws = A) => ({ workspaceId: ws });
const q = async (text: string, params: unknown[] = []) => (await h.admin.query(text, params)).rows;
const TOKEN = "EAAB-secret-token-" + "q".repeat(40);
const TOKEN_B = "EAAB-other-token-" + "z".repeat(40);
let seq = 0;
const dsId = () => `7${Date.now()}${seq++}`;
const stage = (kind: string) => pipe.stages.find((s) => s.kind === kind)!;
const mkDataset = async (u = owner, ws = A, extra: Record<string, unknown> = {}, token = TOKEN) =>
  ok(await as(u).call(endpoints.createCapiDataset, { params: p(ws), body: { datasetId: dsId(), name: "Main", accessToken: token, events: ["Purchase"], ...extra } as never }));
const mkContact = (email = `jane${seq++}@example.com`, name = "Jane Doe", ws = A, u = owner, phone = `+88017${String(Date.now() % 1e5).padStart(5, "0")}${String(seq++).padStart(3, "0")}`) => h.contact(as(u), ws, { name, email, phone });
const winLead = async (c: ContactDetail, value = 5000) => {
  const l = ok(await as(owner).call(endpoints.createLead, { params: p(), body: { title: "Deal", primaryContactId: c.id, allowDuplicate: true, valueMinor: value, currency: "USD" } as never })) as LeadDto;
  ok(await as(owner).call(endpoints.moveLead, { params: { workspaceId: A, leadId: l.id }, body: { expectedVersion: l.version, stageId: stage("won").id } }));
  return l;
};
const eventsOf = (ws: string, ds?: string) => q("SELECT * FROM capi_events WHERE workspace_id=$1 AND ($2::uuid IS NULL OR dataset_id=$2) ORDER BY id", [ws, ds ?? null]);
const run = (script?: (r: SendRequest, n: number) => SendResult | undefined, now?: () => number, extra = {}) => {
  const adapter = createMockAdapter(script);
  // Drains: every win fans out to all active datasets of the workspace, so more than one batch can be due.
  const go = async () => { for (let i = 0; i < 50; i++) if ((await processCapiQueue(workerDb, { adapter, box, now, ...extra })).claimed === 0) return; };
  return { adapter, go };
};
const grant = (c: ContactDetail, status: "granted" | "revoked" = "granted", u = owner, ws = A) => as(u).call(endpoints.setAdConsent, { params: { workspaceId: ws, contactId: c.id }, body: { status, source: "manual" } });

beforeAll(async () => {
  workerDb = createDb(`postgres://crm_worker:worker_dev@127.0.0.1:5436/${DB}`);
  h = await bootstrap({ capiCreatesPerUser: 1000 }, { box } as unknown as MetaConnectDeps);
  [owner, admin, agent, viewer, ownerB] = (await Promise.all(["cpo", "cpa", "cpg", "cpv", "cpb"].map((l) => h.newUser(l)))) as [TestUser, TestUser, TestUser, TestUser, TestUser];
  A = await h.workspace(owner, "CAPI A", { admin, agent, viewer });
  B = await h.workspace(ownerB, "CAPI B");
  pipe = ok(await as(owner).call(endpoints.listPipelines, { params: p() })).pipelines[0]!;
});
afterAll(async () => { await workerDb.$client.end(); await h.close(); });

describe("contract", () => {
  it("event names match the package", () => expect([...CAPI_EVENT_NAMES]).toEqual([...PKG_NAMES]));
});

describe("permissions", () => {
  it("owner and admin configure and read; agent and viewer cannot", async () => {
    await mkDataset(owner);
    await mkDataset(admin);
    for (const u of [agent, viewer]) {
      expect(failure(await as(u).call(endpoints.listCapiDatasets, { params: p() })).status).toBe(403);
      expect(failure(await as(u).call(endpoints.createCapiDataset, { params: p(), body: { datasetId: dsId(), name: "x", accessToken: TOKEN, events: [] } })).status).toBe(403);
      expect(failure(await as(u).call(endpoints.listCapiEvents, { params: p(), query: {} })).status).toBe(403);
    }
    expect(ok(await as(admin).call(endpoints.listCapiDatasets, { params: p() })).items.length).toBeGreaterThanOrEqual(2);
  });
  it("consent history is append-only, newest first, with who and source", async () => {
    const c = await mkContact();
    const get = async () => ok(await as(owner).call(endpoints.getAdConsent, { params: { workspaceId: A, contactId: c.id } }));
    expect(await get()).toMatchObject({ status: "none", history: [] });
    ok(await grant(c, "granted", agent));
    ok(await grant(c, "revoked", owner));
    const g = await get();
    expect(g).toMatchObject({ status: "revoked", source: "manual" });
    expect(g.history.map((h) => h.status)).toEqual(["revoked", "granted"]);
    expect(g.history[0]!.recordedBy).toBeTruthy();
    expect(g.history[0]!.recordedBy).not.toBe(g.history[1]!.recordedBy);
  });
  it("consent: agents may record it, viewers may not; unknown contacts are 404", async () => {
    const c = await mkContact();
    ok(await grant(c, "granted", agent));
    expect(failure(await grant(c, "granted", viewer)).status).toBe(403);
    expect(failure(await as(viewer).call(endpoints.getAdConsent, { params: { workspaceId: A, contactId: c.id } })).status).toBe(403);
    expect(failure(await as(owner).call(endpoints.setAdConsent, { params: { workspaceId: A, contactId: "0197a1b2-0000-7000-8000-000000000000" }, body: { status: "granted", source: "manual" } })).status).toBe(404);
  });
});

describe("dataset token", () => {
  it("is validated, sealed, and never echoed, listed, audited or readable by the app role", async () => {
    const bad = (body: Record<string, unknown>) => as(owner).call(endpoints.createCapiDataset, { params: p(), body: { datasetId: dsId(), name: "x", accessToken: TOKEN, ...body } as never });
    expect(failure(await bad({ datasetId: "abc" })).status).toBe(0); // contract refuses before any request
    const d = await mkDataset();
    expect(d).toMatchObject({ mode: "mock", status: "active", tokenLast4: TOKEN.slice(-4) });
    const listed = JSON.stringify(ok(await as(owner).call(endpoints.listCapiDatasets, { params: p() })));
    expect(JSON.stringify(d) + listed).not.toContain(TOKEN);
    expect(JSON.stringify(d) + listed).not.toMatch(/accessToken|ciphertext/);
    const [sec] = await q("SELECT ciphertext, nonce FROM capi_dataset_secrets WHERE dataset_id=$1", [d.id]);
    expect(Buffer.from(sec.ciphertext).includes(Buffer.from(TOKEN))).toBe(false); // sealed, not plain
    const audit = JSON.stringify(await q("SELECT summary, action FROM audit_log WHERE workspace_id=$1", [A]));
    expect(audit).toContain("capi.dataset.created");
    expect(audit).not.toContain(TOKEN);
    const all = JSON.stringify(await q("SELECT row_to_json(t) FROM capi_datasets t WHERE id=$1", [d.id]));
    expect(all).not.toContain(TOKEN);
  });
  it("a duplicate dataset id in the same workspace is 409; the same id in another workspace is allowed", async () => {
    const id = dsId();
    await mkDataset(owner, A, { datasetId: id });
    expect(failure(await as(owner).call(endpoints.createCapiDataset, { params: p(), body: { datasetId: id, name: "x", accessToken: TOKEN, events: [] } })).status).toBe(409);
    await mkDataset(ownerB, B, { datasetId: id }, TOKEN_B);
  });
  it("dataset creation is rate limited per user", async () => {
    const h3 = await bootstrap({}, { box } as unknown as MetaConnectDeps);
    const u = await h3.newUser("cpr");
    const ws = await h3.workspace(u, "Rate");
    const go = () => h3.clientFor(u).call(endpoints.createCapiDataset, { params: { workspaceId: ws }, body: { datasetId: dsId(), name: "x", accessToken: TOKEN, events: [] } });
    for (let i = 0; i < 10; i++) ok(await go());
    expect(failure(await go()).status).toBe(429);
    await h3.close();
  });
  it("without secret storage configured the route is 503 (never stores plain)", async () => {
    const h2 = await bootstrap({}, undefined);
    const u = await h2.newUser("cpn");
    const ws = await h2.workspace(u, "No box");
    expect(failure(await h2.clientFor(u).call(endpoints.createCapiDataset, { params: { workspaceId: ws }, body: { datasetId: dsId(), name: "x", accessToken: TOKEN, events: [] } })).status).toBe(503);
    await h2.close();
  });
});

describe("tenant isolation", () => {
  it("another workspace sees no datasets or events and cannot disable ours", async () => {
    const d = await mkDataset();
    const c = await mkContact();
    ok(await grant(c));
    await winLead(c);
    expect((await eventsOf(A, d.id)).length).toBe(1);
    expect(ok(await as(ownerB).call(endpoints.listCapiDatasets, { params: p(B) })).items.some((x) => x.id === d.id)).toBe(false);
    expect(ok(await as(ownerB).call(endpoints.listCapiEvents, { params: p(B), query: { datasetId: d.id } })).items).toEqual([]);
    expect(failure(await as(ownerB).call(endpoints.disableCapiDataset, { params: { workspaceId: B, datasetId: d.id } })).status).toBe(404);
    expect(failure(await as(ownerB).call(endpoints.listCapiEvents, { params: p(A), query: {} })).status).toBe(404); // not a member of A: the workspace does not exist for them
  });
  it("the worker uses each workspace's own dataset token, never another's", async () => {
    const dA = await mkDataset(owner, A, { events: ["Purchase"] }, TOKEN);
    const dB = await mkDataset(ownerB, B, { events: ["Purchase"] }, TOKEN_B);
    const cA = await mkContact(); ok(await grant(cA));
    const cB = await mkContact(undefined, "Bea B", B, ownerB); ok(await grant(cB, "granted", ownerB, B));
    await winLead(cA);
    const pipeB = ok(await as(ownerB).call(endpoints.listPipelines, { params: p(B) })).pipelines[0]!;
    const lb = ok(await as(ownerB).call(endpoints.createLead, { params: p(B), body: { title: "B", primaryContactId: cB.id, valueMinor: 100, currency: "EUR" } as never })) as LeadDto;
    ok(await as(ownerB).call(endpoints.moveLead, { params: { workspaceId: B, leadId: lb.id }, body: { expectedVersion: lb.version, stageId: pipeB.stages.find((s) => s.kind === "won")!.id } }));
    const w = run();
    await w.go();
    const bydataset = new Map(w.adapter.calls.map((r) => [r.datasetId, r]));
    expect(bydataset.get(dA.datasetId)?.accessToken).toBe(TOKEN);
    expect(bydataset.get(dB.datasetId)?.accessToken).toBe(TOKEN_B);
    expect(w.adapter.calls.filter((r) => r.datasetId === dA.datasetId).every((r) => r.accessToken === TOKEN)).toBe(true);
  });
});

describe("hook: lead won -> Purchase", () => {
  it("without consent the row is skipped_no_consent and carries NO identifiers", async () => {
    const d = await mkDataset();
    const c = await mkContact("noconsent@example.com");
    await winLead(c);
    const [e] = await eventsOf(A, d.id);
    expect(e).toMatchObject({ status: "skipped_no_consent", last_error: "no_consent", event_name: "Purchase" });
    expect(e.payload.user_data).toEqual({});
    expect(JSON.stringify(e)).not.toContain("noconsent");
    const w = run(); await w.go();
    expect(w.adapter.calls.filter((r) => r.datasetId === d.datasetId)).toEqual([]); // never sent
  });
  it("with consent: pending, hashed identifiers only, value in major units; raw PII is nowhere in the row", async () => {
    const d = await mkDataset();
    const c = await mkContact("Consent.Person@Example.com", "Maria Anna Silva", A, owner, "+8801799900011");
    ok(await grant(c));
    await winLead(c, 12345);
    const [e] = await eventsOf(A, d.id);
    expect(e.status).toBe("pending");
    expect(e.payload).toMatchObject({ event_name: "Purchase", action_source: "system_generated", custom_data: { value: 123.45, currency: "USD" } });
    expect(e.payload.user_data.em).toHaveLength(1);
    expect(e.payload.user_data.em[0]).toMatch(/^[0-9a-f]{64}$/);
    expect(e.payload.user_data.fn).toBeDefined();
    const flat = JSON.stringify(e).toLowerCase();
    for (const raw of ["consent.person", "example.com", "8801799900011", "maria", "silva"]) expect(flat).not.toContain(raw);
    expect(e.payload.event_id).toBe(e.event_id);
  });
  it("revoked consent wins over an earlier grant", async () => {
    const d = await mkDataset();
    const c = await mkContact();
    ok(await grant(c)); ok(await grant(c, "revoked"));
    await winLead(c);
    expect((await eventsOf(A, d.id))[0]).toMatchObject({ status: "skipped_no_consent", last_error: "opted_out" });
  });
  it("is deduplicated: win, reopen, win again creates one row per dataset; datasets that did not opt in get none", async () => {
    const d = await mkDataset();
    const other = await mkDataset(owner, A, { events: ["Lead"] });
    const c = await mkContact(); ok(await grant(c));
    const l = await winLead(c);
    let cur = ok(await as(owner).call(endpoints.getLead, { params: { workspaceId: A, leadId: l.id } }));
    cur = ok(await as(owner).call(endpoints.moveLead, { params: { workspaceId: A, leadId: l.id }, body: { expectedVersion: cur.version, stageId: stage("open").id } }));
    ok(await as(owner).call(endpoints.moveLead, { params: { workspaceId: A, leadId: l.id }, body: { expectedVersion: cur.version, stageId: stage("won").id } }));
    const rows = await eventsOf(A, d.id);
    expect(rows).toHaveLength(1);
    expect(await eventsOf(A, other.id)).toHaveLength(0);
    expect(rows[0].event_id).toMatch(/^[0-9a-f]{40}$/);
  });
  it("a disabled dataset gets no new events; a lead without a value makes none; the stage move still succeeds", async () => {
    const d = await mkDataset();
    ok(await as(owner).call(endpoints.disableCapiDataset, { params: { workspaceId: A, datasetId: d.id } }));
    const c = await mkContact(); ok(await grant(c));
    await winLead(c);
    expect(await eventsOf(A, d.id)).toHaveLength(0);
    const d2 = await mkDataset();
    const l = ok(await as(owner).call(endpoints.createLead, { params: p(), body: { title: "no value", primaryContactId: c.id, allowDuplicate: true } as never })) as LeadDto;
    ok(await as(owner).call(endpoints.moveLead, { params: { workspaceId: A, leadId: l.id }, body: { expectedVersion: l.version, stageId: stage("won").id } }));
    expect(await eventsOf(A, d2.id)).toHaveLength(0);
  });
  it("an agent moving the lead can enqueue even though agents cannot read the history", async () => {
    const d = await mkDataset();
    const c = await mkContact(); ok(await grant(c));
    const l = ok(await as(owner).call(endpoints.createLead, { params: p(), body: { title: "agent deal", primaryContactId: c.id, valueMinor: 900, currency: "USD" } as never })) as LeadDto;
    ok(await as(agent).call(endpoints.moveLead, { params: { workspaceId: A, leadId: l.id }, body: { expectedVersion: l.version, stageId: stage("won").id } }));
    expect(await eventsOf(A, d.id)).toHaveLength(1);
  });
});

describe("worker", () => {
  const pendingFor = async () => {
    const d = await mkDataset();
    const c = await mkContact(); ok(await grant(c));
    await winLead(c);
    return { d, e: (await eventsOf(A, d.id))[0] };
  };
  const mine = (w: ReturnType<typeof run>, d: { datasetId: string }) => w.adapter.calls.filter((r) => r.datasetId === d.datasetId);

  it("sends once with the unsealed token and the payload as stored, marks sent, and never resends", async () => {
    const { d, e } = await pendingFor();
    const w = run(); await w.go();
    expect(mine(w, d)).toHaveLength(1);
    expect(mine(w, d)[0]).toMatchObject({ accessToken: TOKEN, datasetId: d.datasetId, events: [e.payload] });
    const [row] = await eventsOf(A, d.id);
    expect(row).toMatchObject({ status: "sent", attempts: 1, last_error: null });
    expect(row.sent_at).not.toBeNull();
    const again = run(); await again.go(); await again.go();
    expect(mine(again, d)).toHaveLength(0);
  });
  it("retries a transient failure with backoff, keeps the same event_id and event_time, then succeeds", async () => {
    const { d, e } = await pendingFor();
    let t = Date.now();
    let n = 0;
    const w = run((r) => (r.datasetId === d.datasetId && ++n === 1 ? { ok: false, retryable: true, code: "http_503", fbtraceId: "TR1" } : undefined), () => t);
    await w.go();
    let [row] = await eventsOf(A, d.id);
    expect(row).toMatchObject({ status: "pending", attempts: 1, last_error: "http_503", fbtrace_id: "TR1" });
    expect(new Date(row.next_attempt_at).getTime()).toBeGreaterThanOrEqual(t + 2 * 60_000 - 1000);
    await w.go(); // not due yet
    expect(mine(w, d)).toHaveLength(1);
    t += 3 * 60_000;
    await w.go();
    [row] = await eventsOf(A, d.id);
    expect(row).toMatchObject({ status: "sent", attempts: 2, event_id: e.event_id });
    expect(mine(w, d).map((r) => r.events[0]!.event_id)).toEqual([e.event_id, e.event_id]);
    expect(new Date(row.event_time).getTime()).toBe(new Date(e.event_time).getTime());
  });
  it("stops after the maximum attempts (failed, code kept) and does not retry validation or auth errors", async () => {
    const a = await pendingFor();
    let t = Date.now();
    const wa = run((r) => (r.datasetId === a.d.datasetId ? { ok: false, retryable: true, code: "http_500" } : undefined), () => t);
    for (let i = 0; i < 8; i++) { await wa.go(); t += 7 * 3_600_000; }
    expect(mine(wa, a.d)).toHaveLength(6);
    expect((await eventsOf(A, a.d.id))[0]).toMatchObject({ status: "failed", attempts: 6, last_error: "max_attempts:http_500" });
    const b = await pendingFor();
    const wb = run((r) => (r.datasetId === b.d.datasetId ? { ok: false, retryable: false, code: "auth" } : undefined));
    await wb.go(); await wb.go();
    expect(mine(wb, b.d)).toHaveLength(1);
    expect((await eventsOf(A, b.d.id))[0]).toMatchObject({ status: "failed", last_error: "auth" });
  });
  it("consent withdrawn after queueing is honoured at send time: nothing is sent and the identifiers are blanked", async () => {
    const d = await mkDataset();
    const c = await mkContact(); ok(await grant(c));
    await winLead(c);
    expect((await eventsOf(A, d.id))[0].payload.user_data.em).toBeDefined();
    ok(await grant(c, "revoked"));
    const w = run(); await w.go();
    expect(mine(w, d)).toHaveLength(0);
    const [row] = await eventsOf(A, d.id);
    expect(row).toMatchObject({ status: "skipped_no_consent", last_error: "opted_out" });
    expect(row.payload.user_data).toEqual({});
  });
  it("an event older than 7 days fails without a send; a dataset disabled after queueing fails without a send", async () => {
    const a = await pendingFor();
    const w = run(undefined, () => Date.now() + 8 * 24 * 3_600_000);
    await w.go();
    expect(mine(w, a.d)).toHaveLength(0);
    expect((await eventsOf(A, a.d.id))[0]).toMatchObject({ status: "failed", last_error: "event_too_old" });
    const b = await pendingFor();
    ok(await as(owner).call(endpoints.disableCapiDataset, { params: { workspaceId: A, datasetId: b.d.id } }));
    const w2 = run(); await w2.go();
    expect(mine(w2, b.d)).toHaveLength(0);
    expect((await eventsOf(A, b.d.id))[0]).toMatchObject({ status: "failed", last_error: "dataset_inactive" });
  });
  it("a mock dataset is never handed to a live adapter", async () => {
    const { d } = await pendingFor();
    const live = { mode: "live" as const, calls: [] as SendRequest[], async send(r: SendRequest): Promise<SendResult> { this.calls.push(r); return { ok: true, eventsReceived: 1 }; } };
    await processCapiQueue(workerDb, { adapter: live, box });
    expect(live.calls.filter((r) => r.datasetId === d.datasetId)).toHaveLength(0);
    expect((await eventsOf(A, d.id))[0]).toMatchObject({ status: "failed", last_error: "mode_mismatch" });
  });
  it("two workers running together send each event once", async () => {
    const { d } = await pendingFor();
    const w1 = run(); const w2 = run();
    await Promise.all([w1.go(), w2.go()]);
    expect(mine(w1, d).length + mine(w2, d).length).toBe(1);
  });
  it("a corrupted sealed token fails the event without sending", async () => {
    const { d } = await pendingFor();
    await q("UPDATE capi_dataset_secrets SET key_id = 'unknown' WHERE dataset_id=$1", [d.id]);
    const w = run(); await w.go();
    expect(mine(w, d)).toHaveLength(0);
    expect((await eventsOf(A, d.id))[0]).toMatchObject({ status: "failed", last_error: "token_unavailable" });
  });
});

describe("history", () => {
  it("shows status and error code but no identifiers, payload or token; filters and pages", async () => {
    const d = await mkDataset();
    for (let i = 0; i < 3; i++) { const c = await mkContact(); ok(await grant(c)); await winLead(c); }
    const w = run((r) => (r.datasetId === d.datasetId ? { ok: false, retryable: false, code: "http_400" } : undefined)); await w.go();
    const page1 = ok(await as(owner).call(endpoints.listCapiEvents, { params: p(), query: { datasetId: d.id, limit: 2 } }));
    expect(page1.items).toHaveLength(2);
    expect(page1.nextCursor).not.toBeNull();
    const page2 = ok(await as(owner).call(endpoints.listCapiEvents, { params: p(), query: { datasetId: d.id, limit: 2, cursor: page1.nextCursor! } }));
    expect(page2.items).toHaveLength(1);
    expect(page2.nextCursor).toBeNull();
    const all = JSON.stringify([...page1.items, ...page2.items]);
    expect(page1.items[0]).toMatchObject({ status: "failed", lastError: "http_400", eventName: "Purchase" });
    expect(all).not.toMatch(/user_data|payload|"em"|example\.com|EAAB/);
    expect(ok(await as(owner).call(endpoints.listCapiEvents, { params: p(), query: { datasetId: d.id, status: "sent" } })).items).toEqual([]);
  });
});
