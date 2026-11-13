import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { endpoints } from "@crm/contracts";
import { bootstrap, failure, ok, ORIGIN, type Harness, type TestUser } from "./harness.ts";

// Batch 3 remediation: app.onError, body limits, NUL, cursors, dates, soft-delete guards, races, role boundaries.
let h: Harness;
let owner: TestUser, admin: TestUser, agent: TestUser, viewer: TestUser, outsider: TestUser;
let W: string;
const o = () => h.clientFor(owner);
const as = (u: TestUser) => h.clientFor(u);
const p = () => ({ workspaceId: W });
const raw = (path: string, init: RequestInit & { cookie?: string } = {}) => h.app.request(path, { ...init, headers: { origin: ORIGIN, cookie: init.cookie ?? owner.cookie, ...(init.headers ?? {}) } });

beforeAll(async () => {
  h = await bootstrap();
  // a route that throws like a failing query would; registered before the first request so the router is still open
  h.app.get("/boom", () => { throw Object.assign(new Error('Failed query: insert into "contacts" params: Zed,secret-pii@example.com'), { cause: { code: "23505", constraint: "some_unique" } }); });
  owner = await h.newUser("hx-owner"); admin = await h.newUser("hx-admin"); agent = await h.newUser("hx-agent"); viewer = await h.newUser("hx-viewer"); outsider = await h.newUser("hx-out");
  W = await h.workspace(owner, "Hardening Co", { admin, agent, viewer });
});
afterAll(async () => h.close());

describe("app.onError", () => {
  it("returns a generic JSON 500 with a request id and logs no SQL, parameters or message", async () => {
    const logged: string[] = [];
    const orig = console.error;
    console.error = (...a: unknown[]) => { logged.push(a.map(String).join(" ")); };
    let res: Response;
    try { res = await h.app.request("/boom"); } finally { console.error = orig; }
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toMatchObject({ code: "internal_error" });
    expect(body.error.requestId).toBeTruthy();
    expect(JSON.stringify(body)).not.toMatch(/secret|insert|Failed query/);
    const log = logged.join("\n");
    expect(log).toContain("unhandled error");
    expect(log).toContain("23505");
    expect(log).not.toMatch(/secret-pii|Failed query|params/);
  });
  it("unknown routes are a JSON 404", async () => {
    const res = await h.app.request("/nope");
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe("not_found");
  });
});

describe("body limits and request ids", () => {
  it("rejects an oversized JSON body on any /v1 route with 413 before reading it", async () => {
    const res = await raw(`/v1/workspaces/${W}/contacts`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "x".repeat(2 * 1024 * 1024) }) });
    expect(res.status).toBe(413);
    expect((await res.json()).error.code).toBe("too_large");
  });
  it("limits auth bodies too", async () => {
    const res = await h.app.request("/api/auth/sign-in/email", { method: "POST", headers: { "content-type": "application/json", origin: ORIGIN }, body: JSON.stringify({ email: "a@b.co", password: "x".repeat(200_000) }) });
    expect(res.status).toBe(413);
  });
  it("keeps a well-formed x-request-id and replaces a hostile one", async () => {
    const good = await raw("/v1/me", { headers: { "x-request-id": "req-abc12345" } });
    expect(good.headers.get("x-request-id")).toBe("req-abc12345");
    const bad = await raw("/v1/me", { headers: { "x-request-id": "x".repeat(5000) } });
    expect(bad.headers.get("x-request-id")).toMatch(/^[0-9a-f-]{36}$/);
    const inj = await raw("/v1/me", { headers: { "x-request-id": "a b\"c" } });
    expect(inj.headers.get("x-request-id")).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe("NUL bytes are a 400, never a 500", () => {
  it("in a JSON body", async () => {
    const e = failure(await o().call(endpoints.createContact, { params: p(), body: { name: "a\u0000b" } }));
    expect(e).toMatchObject({ status: 400, code: "invalid_body" });
  });
  it("in a nested value and in a query string", async () => {
    expect(failure(await o().call(endpoints.createContact, { params: p(), body: { name: "ok", custom: { x: "a\u0000" } as never } })).status).toBe(400);
    expect(failure(await o().call(endpoints.listContacts, { params: p(), query: { search: "a\u0000b" } })).status).toBe(400);
  });
});

describe("list cursors and date filters", () => {
  beforeAll(async () => { for (let i = 0; i < 3; i++) await h.contact(o(), W, { name: `List ${i}`, email: `list${i}@hx.example` }); });
  const cursor = (k: string, sort = "lastActivity") => Buffer.from(JSON.stringify({ k, id: "00000000-0000-7000-8000-000000000000", sort, dir: "desc" })).toString("base64url");
  it.each(["garbage", "", "9999-99-99", "infinity", "-infinity", "2024-01-01"])("a tampered cursor key %j is a 400", async (k) => {
    const e = failure(await o().call(endpoints.listContacts, { params: p(), query: { sort: "lastActivity", dir: "desc", cursor: cursor(k) } }));
    expect(e.status).toBe(400);
  });
  it("a real cursor still pages", async () => {
    const first = ok(await o().call(endpoints.listContacts, { params: p(), query: { limit: 1, search: "hx.example" } }));
    expect(first.nextCursor).toBeTruthy();
    const second = ok(await o().call(endpoints.listContacts, { params: p(), query: { limit: 1, search: "hx.example", cursor: first.nextCursor! } }));
    expect(second.items[0]!.id).not.toBe(first.items[0]!.id);
  });
  it.each(["1", "yesterday", "2024-01-01T00:00:00", "9999-12-31", "+275760-09-13", "1800-01-01", "2024-13-45"])("createdFrom %j is refused with a 400", async (v) => {
    expect(failure(await o().call(endpoints.listContacts, { params: p(), query: { createdFrom: v } })).status).toBe(400);
    expect(failure(await o().call(endpoints.listContacts, { params: p(), query: { createdTo: v } })).status).toBe(400);
  });
  it("accepts a date, and a date-time with an offset", async () => {
    expect(ok(await o().call(endpoints.listContacts, { params: p(), query: { createdFrom: "2020-01-01", createdTo: "2100-01-01" } })).total).toBeGreaterThan(0);
    expect(ok(await o().call(endpoints.listContacts, { params: p(), query: { createdFrom: "2020-01-01T00:00:00.000000+02:00" } })).total).toBeGreaterThan(0);
    expect(ok(await o().call(endpoints.listContacts, { params: p(), query: { createdTo: "2020-01-01T00:00:00Z" } })).total).toBe(0);
  });
});

describe("soft-deleted contacts are read-only history", () => {
  it("notes and tasks of a deleted contact cannot be edited or deleted; tag counts ignore it", async () => {
    const c = await h.contact(o(), W, { name: "To Delete", email: "del@hx.example" });
    const note = ok(await o().call(endpoints.createNote, { params: { ...p(), contactId: c.id }, body: { body: "hello" } }));
    const task = ok(await o().call(endpoints.createTask, { params: { ...p(), contactId: c.id }, body: { title: "t" } }));
    const tag = ok(await o().call(endpoints.createTag, { params: p(), body: { name: "count-me" } }));
    ok(await o().call(endpoints.addContactTag, { params: { ...p(), contactId: c.id }, body: { tagId: tag.id } }));
    expect(ok(await o().call(endpoints.listTags, { params: p() })).find((t) => t.id === tag.id)!.contactCount).toBe(1);
    expect((await o().call(endpoints.deleteContact, { params: { ...p(), contactId: c.id } })).ok).toBe(true);
    expect(failure(await o().call(endpoints.updateNote, { params: { ...p(), contactId: c.id, noteId: note.id }, body: { body: "changed" } })).status).toBe(404);
    expect(failure(await o().call(endpoints.deleteNote, { params: { ...p(), contactId: c.id, noteId: note.id } })).status).toBe(404);
    expect(failure(await o().call(endpoints.updateTask, { params: { ...p(), taskId: task.id }, body: { status: "done" } })).status).toBe(404);
    expect(failure(await o().call(endpoints.deleteTask, { params: { ...p(), taskId: task.id } })).status).toBe(404);
    expect(ok(await o().call(endpoints.listTags, { params: p() })).find((t) => t.id === tag.id)!.contactCount).toBe(0);
  });
});

describe("tag delete leaves a trace on every contact", () => {
  it("records contact.tag_removed (via tag_deleted) and moves last activity", async () => {
    const a = await h.contact(o(), W, { name: "Tagged A", email: "ta@hx.example" });
    const b = await h.contact(o(), W, { name: "Tagged B", email: "tb@hx.example" });
    const tag = ok(await o().call(endpoints.createTag, { params: p(), body: { name: "doomed" } }));
    for (const c of [a, b]) ok(await o().call(endpoints.addContactTag, { params: { ...p(), contactId: c.id }, body: { tagId: tag.id } }));
    const before = ok(await o().call(endpoints.getContact, { params: { ...p(), contactId: a.id } })).lastActivityAt as string;
    await new Promise((r) => setTimeout(r, 15));
    expect((await o().call(endpoints.deleteTag, { params: { ...p(), tagId: tag.id } })).ok).toBe(true);
    for (const c of [a, b]) {
      const items = ok(await o().call(endpoints.listActivity, { params: { ...p(), contactId: c.id } })).items;
      expect(items[0]).toMatchObject({ kind: "contact.tag_removed", data: { tag: "doomed", via: "tag_deleted" } });
    }
    expect(String(ok(await o().call(endpoints.getContact, { params: { ...p(), contactId: a.id } })).lastActivityAt) > before).toBe(true);
  });
});

describe("races", () => {
  it("ten simultaneous creates of the same email produce one contact and nine duplicate warnings", async () => {
    const res = await Promise.all(Array.from({ length: 10 }, () => o().call(endpoints.createContact, { params: p(), body: { name: "Racer", email: "racer@hx.example" } })));
    expect(res.filter((r) => r.ok)).toHaveLength(1);
    expect(res.filter((r) => !r.ok).every((r) => !r.ok && r.error.code === "duplicate_contact")).toBe(true);
    expect(ok(await o().call(endpoints.listContacts, { params: p(), query: { search: "racer@hx.example" } })).total).toBe(1);
  });
  it("parallel add-tag-by-name creates the tag once and never answers 500", async () => {
    const c = await h.contact(o(), W, { name: "Tag Racer", email: "tr@hx.example" });
    const res = await Promise.all(Array.from({ length: 6 }, () => o().call(endpoints.addContactTag, { params: { ...p(), contactId: c.id }, body: { name: "NewRaceTag" } })));
    expect(res.every((r) => r.ok)).toBe(true);
    expect(ok(await o().call(endpoints.listTags, { params: p() })).filter((t) => t.name.toLowerCase() === "newracetag")).toHaveLength(1);
  });
  it("parallel tag creates answer 201 once and 409 for the rest", async () => {
    const res = await Promise.all(Array.from({ length: 5 }, () => o().call(endpoints.createTag, { params: p(), body: { name: "Parallel" } })));
    expect(res.filter((r) => r.ok)).toHaveLength(1);
    expect(res.filter((r) => !r.ok).every((r) => !r.ok && r.error.status === 409)).toBe(true);
  });
  it("archiving the last two active stages at once leaves one active stage", async () => {
    const w = await h.workspace(owner, "Stage Race Co");
    const wp = { workspaceId: w };
    const stages = ok(await o().call(endpoints.listLifecycleStages, { params: wp }));
    for (const s of stages.slice(0, stages.length - 2)) ok(await o().call(endpoints.updateLifecycleStage, { params: { ...wp, stageId: s.id }, body: { archived: true } }));
    const [x, y] = stages.slice(-2);
    const res = await Promise.all([x!, y!].map((s) => o().call(endpoints.updateLifecycleStage, { params: { ...wp, stageId: s.id }, body: { archived: true } })));
    expect(res.filter((r) => r.ok)).toHaveLength(1);
    expect(ok(await o().call(endpoints.listLifecycleStages, { params: wp })).filter((s) => !s.archived)).toHaveLength(1);
  });
  it("restoring an archived stage whose name is taken by an active one is a 409", async () => {
    const w = await h.workspace(owner, "Stage Name Co");
    const wp = { workspaceId: w };
    const first = ok(await o().call(endpoints.createLifecycleStage, { params: wp, body: { name: "Temp" } }));
    ok(await o().call(endpoints.updateLifecycleStage, { params: { ...wp, stageId: first.id }, body: { archived: true } }));
    ok(await o().call(endpoints.createLifecycleStage, { params: wp, body: { name: "Temp" } }));
    expect(failure(await o().call(endpoints.updateLifecycleStage, { params: { ...wp, stageId: first.id }, body: { archived: false } })).code).toBe("name_taken");
  });
  it("two first visits to the stages list seed the defaults once", async () => {
    const w = await h.workspace(owner, "Seed Co");
    await h.admin.query("DELETE FROM lifecycle_stages WHERE workspace_id = $1", [w]);
    await Promise.all([o().call(endpoints.listLifecycleStages, { params: { workspaceId: w } }), o().call(endpoints.listLifecycleStages, { params: { workspaceId: w } })]);
    expect(ok(await o().call(endpoints.listLifecycleStages, { params: { workspaceId: w } }))).toHaveLength(5);
  });
});

describe("PATCH behaviour", () => {
  it("saves a display-only phone change", async () => {
    const c = await h.contact(o(), W, { name: "Phone Fmt", phone: "555 010 7777" });
    const u = ok(await o().call(endpoints.updateContact, { params: { ...p(), contactId: c.id }, body: { expectedVersion: c.version, phone: "(555) 010-7777" } }));
    expect(u.phone).toBe("(555) 010-7777");
  });
  it("custom fields: a stale stored value or a newly required field does not block editing another field", async () => {
    const cw = await h.workspace(owner, "Custom Co"); // own workspace: a required field would constrain every later create
    const cp = { workspaceId: cw };
    const tier = ok(await o().call(endpoints.createCustomField, { params: cp, body: { key: "tier", label: "Tier", type: "select", options: ["gold", "silver"] } }));
    const note = ok(await o().call(endpoints.createCustomField, { params: cp, body: { key: "memo", label: "Memo", type: "text" } }));
    const c = await h.contact(o(), cw, { name: "Custom Edit", custom: { tier: "gold" } });
    ok(await o().call(endpoints.updateCustomField, { params: { ...cp, fieldId: tier.id }, body: { options: ["silver"] } })); // "gold" is now a stale value
    const u = ok(await o().call(endpoints.updateContact, { params: { ...cp, contactId: c.id }, body: { expectedVersion: c.version, custom: { memo: "hello" } } }));
    expect(u.custom).toMatchObject({ memo: "hello", tier: "gold" });
    // making a field required afterwards must not block an unrelated edit either
    const other = await h.contact(o(), cw, { name: "No Memo" }); // exists before memo becomes required
    ok(await o().call(endpoints.updateCustomField, { params: { ...cp, fieldId: note.id }, body: { required: true } }));
    ok(await o().call(endpoints.updateContact, { params: { ...cp, contactId: other.id }, body: { expectedVersion: other.version, custom: { tier: "silver" } } }));
    // but clearing a required field is refused
    const e = failure(await o().call(endpoints.updateContact, { params: { ...cp, contactId: c.id }, body: { expectedVersion: u.version, custom: { memo: null } } }));
    expect(e).toMatchObject({ status: 422, code: "invalid_custom_fields" });
  });
});

describe("roles: owner, admin, agent, viewer, outsider", () => {
  it("viewers can read but never write", async () => {
    const c = await h.contact(o(), W, { name: "Viewer Target", email: "vt@hx.example" });
    const v = as(viewer);
    expect(ok(await v.call(endpoints.getContact, { params: { ...p(), contactId: c.id } })).id).toBe(c.id);
    expect(failure(await v.call(endpoints.createContact, { params: p(), body: { name: "no" } })).status).toBe(403);
    expect(failure(await v.call(endpoints.updateContact, { params: { ...p(), contactId: c.id }, body: { expectedVersion: 1, name: "no" } })).status).toBe(403);
    expect(failure(await v.call(endpoints.deleteContact, { params: { ...p(), contactId: c.id } })).status).toBe(403);
    expect(failure(await v.call(endpoints.createTag, { params: p(), body: { name: "vtag" } })).status).toBe(403);
    expect(failure(await v.call(endpoints.createNote, { params: { ...p(), contactId: c.id }, body: { body: "n" } })).status).toBe(403);
    expect(failure(await v.call(endpoints.exportContacts, { params: p(), query: {} })).status).toBe(403);
  });
  it("agents edit contacts but cannot delete, manage schema, export or import", async () => {
    const c = await h.contact(o(), W, { name: "Agent Target", email: "at@hx.example" });
    const a = as(agent);
    expect(ok(await a.call(endpoints.updateContact, { params: { ...p(), contactId: c.id }, body: { expectedVersion: c.version, company: "AgentCo" } })).company).toBe("AgentCo");
    expect(failure(await a.call(endpoints.deleteContact, { params: { ...p(), contactId: c.id } })).status).toBe(403);
    expect(failure(await a.call(endpoints.createLifecycleStage, { params: p(), body: { name: "Agent Stage" } })).status).toBe(403);
    expect(failure(await a.call(endpoints.createCustomField, { params: p(), body: { key: "ak", label: "AK", type: "text" } })).status).toBe(403);
    expect(failure(await a.call(endpoints.exportContacts, { params: p(), query: {} })).status).toBe(403);
    expect(failure(await a.call(endpoints.uploadImport, { params: p(), body: { filename: "x.csv", csv: "Name\nx" } })).status).toBe(403);
    const tag = ok(await o().call(endpoints.createTag, { params: p(), body: { name: "agent-del" } }));
    expect(failure(await a.call(endpoints.deleteTag, { params: { ...p(), tagId: tag.id } })).status).toBe(403);
  });
  it("admins can delete contacts and manage schema", async () => {
    const c = await h.contact(o(), W, { name: "Admin Target", email: "adt@hx.example" });
    expect((await as(admin).call(endpoints.deleteContact, { params: { ...p(), contactId: c.id } })).ok).toBe(true);
    expect(ok(await as(admin).call(endpoints.createLifecycleStage, { params: p(), body: { name: "Admin Stage" } })).name).toBe("Admin Stage");
  });
  it("an agent cannot edit or delete another agent's task, through the API or the database", async () => {
    const agent2 = await h.newUser("hx-agent2");
    await h.admin.query("INSERT INTO memberships(workspace_id,user_id,role) VALUES ($1,$2,'agent')", [W, agent2.id]);
    const c = await h.contact(o(), W, { name: "Task Owner", email: "to@hx.example" });
    const t = ok(await as(agent).call(endpoints.createTask, { params: { ...p(), contactId: c.id }, body: { title: "mine" } }));
    expect(failure(await as(agent2).call(endpoints.updateTask, { params: { ...p(), taskId: t.id }, body: { title: "stolen" } })).status).toBe(403);
    expect(failure(await as(agent2).call(endpoints.deleteTask, { params: { ...p(), taskId: t.id } })).status).toBe(403);
    expect(ok(await as(agent).call(endpoints.updateTask, { params: { ...p(), taskId: t.id }, body: { title: "still mine" } })).title).toBe("still mine");
  });
  it("an outsider gets 404 everywhere and learns nothing; other tenants' ids are 404 too", async () => {
    const out = as(outsider);
    const c = await h.contact(o(), W, { name: "Hidden", email: "hid@hx.example" });
    expect(failure(await out.call(endpoints.listContacts, { params: p(), query: {} })).status).toBe(404);
    expect(failure(await out.call(endpoints.getContact, { params: { ...p(), contactId: c.id } })).status).toBe(404);
    expect(failure(await out.call(endpoints.createContact, { params: p(), body: { name: "x" } })).status).toBe(404);
    expect(failure(await out.call(endpoints.listTags, { params: p() })).status).toBe(404);
    const wB = await h.workspace(outsider, "Outsider Co");
    expect(failure(await out.call(endpoints.getContact, { params: { workspaceId: wB, contactId: c.id } })).status).toBe(404);
    expect(failure(await out.call(endpoints.updateTask, { params: { workspaceId: wB, taskId: c.id }, body: { title: "x" } })).status).toBe(404);
  });
  it("unauthenticated requests are 401", async () => {
    const res = await h.app.request(`/v1/workspaces/${W}/contacts`, { headers: { origin: ORIGIN } });
    expect(res.status).toBe(401);
  });
  it("the audit log is for owners and admins only, in the API and in the database", async () => {
    expect(ok(await as(admin).call(endpoints.auditLog, { params: p(), query: { limit: 5 } })).items.length).toBeGreaterThan(0);
    expect(failure(await as(agent).call(endpoints.auditLog, { params: p(), query: { limit: 5 } })).status).toBe(403);
    expect(failure(await as(viewer).call(endpoints.auditLog, { params: p(), query: { limit: 5 } })).status).toBe(403);
  });
});
