import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { endpoints, type ContactDetail } from "@crm/contracts";
import { bootstrap, failure, ok, type Harness, type TestUser } from "./harness.ts";

let h: Harness;
let owner: TestUser, admin: TestUser, agent: TestUser, agent2: TestUser, viewer: TestUser, outsider: TestUser, ownerB: TestUser;
let A: string; // workspace with all roles
let B: string; // a different workspace
let alice: ContactDetail; // contact in A
let bob: ContactDetail; // contact in B

const as = (u: TestUser) => h.clientFor(u);
const stagesOf = async (u: TestUser, ws: string) => ok(await as(u).call(endpoints.listLifecycleStages, { params: { workspaceId: ws } }));

beforeAll(async () => {
  h = await bootstrap();
  const u = await Promise.all(["owner", "admin", "agent", "agent2", "viewer", "outsider", "ownerb"].map((l) => h.newUser(l)));
  [owner, admin, agent, agent2, viewer, outsider, ownerB] = u as [TestUser, TestUser, TestUser, TestUser, TestUser, TestUser, TestUser];
  A = await h.workspace(owner, "Contacts A", { admin, agent, agent2, viewer });
  B = await h.workspace(ownerB, "Contacts B");
  alice = await h.contact(as(agent), A, { name: "Alice Anders", email: "alice@a.example", phone: "+1 555 010 0001", company: "Acme" });
  bob = await h.contact(as(ownerB), B, { name: "Bob Brown", email: "bob@b.example", phone: "+1 555 010 0002" });
});
afterAll(async () => h.close());

describe("defaults", () => {
  it("a new workspace gets the five default lifecycle stages in order", async () => {
    const s = await stagesOf(owner, A);
    expect(s.map((x) => x.name)).toEqual(["New", "Engaged", "Qualified", "Customer", "Inactive"]);
    expect(s.map((x) => x.position)).toEqual([0, 1, 2, 3, 4]);
  });
  it("a contact starts in the first stage, has normalized email, an activity entry and a last activity", async () => {
    expect(alice.lifecycleStage.name).toBe("New");
    expect(alice.email).toBe("alice@a.example");
    expect(alice.lastActivityAt).toBeTruthy();
    const act = ok(await as(agent).call(endpoints.listActivity, { params: { workspaceId: A, contactId: alice.id } }));
    expect(act.items.map((i) => i.kind)).toEqual(["contact.created"]);
    expect(act.items[0]!.actorName).toBe("agent");
  });
});

describe("tenant isolation on every contact operation", () => {
  const notFound = async (p: Promise<{ ok: boolean }>) => {
    const r = (await p) as { ok: false; error: { status: number } };
    expect(r.ok).toBe(false);
    expect(r.error.status).toBe(404);
  };
  it("another workspace's owner cannot read, change, delete, tag, note, task or view A's contact (404, never 403)", async () => {
    const c = as(ownerB);
    const p = { workspaceId: A, contactId: alice.id };
    await notFound(c.call(endpoints.getContact, { params: p }));
    await notFound(c.call(endpoints.updateContact, { params: p, body: { expectedVersion: 1, name: "Hacked" } }));
    await notFound(c.call(endpoints.deleteContact, { params: p }));
    await notFound(c.call(endpoints.addContactTag, { params: p, body: { name: "x" } }));
    await notFound(c.call(endpoints.listNotes, { params: p }));
    await notFound(c.call(endpoints.createNote, { params: p, body: { body: "x" } }));
    await notFound(c.call(endpoints.listActivity, { params: p }));
    await notFound(c.call(endpoints.listContactTasks, { params: p }));
    await notFound(c.call(endpoints.createTask, { params: p, body: { title: "x" } }));
    await notFound(c.call(endpoints.listContacts, { params: { workspaceId: A } }));
    await notFound(c.call(endpoints.exportContacts, { params: { workspaceId: A } }));
    await notFound(c.call(endpoints.listLifecycleStages, { params: { workspaceId: A } }));
    await notFound(c.call(endpoints.listTags, { params: { workspaceId: A } }));
    await notFound(c.call(endpoints.listViews, { params: { workspaceId: A } }));
    await notFound(c.call(endpoints.uploadImport, { params: { workspaceId: A }, body: { filename: "x.csv", csv: "name\nx" } }));
  });
  it("a non-member gets the same", async () => {
    await notFound(as(outsider).call(endpoints.getContact, { params: { workspaceId: A, contactId: alice.id } }));
  });
  it("using A's contact id inside B's workspace finds nothing", async () => {
    await notFound(as(ownerB).call(endpoints.getContact, { params: { workspaceId: B, contactId: alice.id } }));
    await notFound(as(ownerB).call(endpoints.updateContact, { params: { workspaceId: B, contactId: alice.id }, body: { expectedVersion: 1, name: "x" } }));
    await notFound(as(ownerB).call(endpoints.createNote, { params: { workspaceId: B, contactId: alice.id }, body: { body: "x" } }));
  });
  it("A's stage, tag and owner cannot be used in B", async () => {
    const stageA = (await stagesOf(owner, A))[1]!.id;
    const tagA = ok(await as(owner).call(endpoints.createTag, { params: { workspaceId: A }, body: { name: "a-only" } }));
    expect(failure(await as(ownerB).call(endpoints.createContact, { params: { workspaceId: B }, body: { name: "X", lifecycleStageId: stageA } })).code).toBe("invalid_stage");
    expect(failure(await as(ownerB).call(endpoints.createContact, { params: { workspaceId: B }, body: { name: "X", tagIds: [tagA.id] } })).code).toBe("invalid_tag");
    expect(failure(await as(ownerB).call(endpoints.createContact, { params: { workspaceId: B }, body: { name: "X", ownerUserId: owner.id } })).code).toBe("invalid_owner");
    expect(failure(await as(ownerB).call(endpoints.addContactTag, { params: { workspaceId: B, contactId: bob.id }, body: { tagId: tagA.id } })).status).toBe(404);
  });
  it("lists, stage counts, tag lists and filters never include another workspace's rows", async () => {
    const listB = ok(await as(ownerB).call(endpoints.listContacts, { params: { workspaceId: B } }));
    expect(listB.items.map((c) => c.id)).toEqual([bob.id]);
    expect(listB.total).toBe(1);
    expect((await as(ownerB).call(endpoints.listTags, { params: { workspaceId: B } })).ok && ok(await as(ownerB).call(endpoints.listTags, { params: { workspaceId: B } })).map((t) => t.name)).not.toContain("a-only");
    const filtered = ok(await as(ownerB).call(endpoints.listContacts, { params: { workspaceId: B }, query: { ownerId: owner.id, search: "alice" } }));
    expect(filtered.items).toEqual([]);
  });
  it("saved views are private to their owner and a workspace", async () => {
    const config = { columns: ["contact", "tags"] as ("contact" | "tags")[], filters: {}, sort: "name" as const, dir: "asc" as const };
    const mine = ok(await as(agent).call(endpoints.createView, { params: { workspaceId: A }, body: { name: "Agent's view", config } }));
    expect(ok(await as(agent2).call(endpoints.listViews, { params: { workspaceId: A } })).map((v) => v.name)).not.toContain("Agent's view");
    expect(failure(await as(agent2).call(endpoints.updateView, { params: { workspaceId: A, viewId: mine.id }, body: { name: "Stolen" } })).status).toBe(404);
    expect(failure(await as(agent2).call(endpoints.deleteView, { params: { workspaceId: A, viewId: mine.id } })).status).toBe(404);
    expect(failure(await as(ownerB).call(endpoints.deleteView, { params: { workspaceId: B, viewId: mine.id } })).status).toBe(404);
  });
});

describe("permission boundaries", () => {
  it("everyone in the workspace can read contacts", async () => {
    for (const u of [owner, admin, agent, viewer]) expect(ok(await as(u).call(endpoints.getContact, { params: { workspaceId: A, contactId: alice.id } })).id).toBe(alice.id);
  });
  it("viewers cannot create, edit, tag, note, task or delete", async () => {
    const p = { workspaceId: A, contactId: alice.id };
    const c = as(viewer);
    expect(failure(await c.call(endpoints.createContact, { params: { workspaceId: A }, body: { name: "V" } })).status).toBe(403);
    expect(failure(await c.call(endpoints.updateContact, { params: p, body: { expectedVersion: 1, name: "V" } })).status).toBe(403);
    expect(failure(await c.call(endpoints.addContactTag, { params: p, body: { name: "v" } })).status).toBe(403);
    expect(failure(await c.call(endpoints.createNote, { params: p, body: { body: "v" } })).status).toBe(403);
    expect(failure(await c.call(endpoints.createTask, { params: p, body: { title: "v" } })).status).toBe(403);
    expect(failure(await c.call(endpoints.deleteContact, { params: p })).status).toBe(403);
  });
  it("agents can edit but not delete, import, export or configure", async () => {
    const c = as(agent);
    expect(ok(await c.call(endpoints.updateContact, { params: { workspaceId: A, contactId: alice.id }, body: { expectedVersion: alice.version, company: "Acme Inc" } })).company).toBe("Acme Inc");
    alice = ok(await c.call(endpoints.getContact, { params: { workspaceId: A, contactId: alice.id } }));
    expect(failure(await c.call(endpoints.deleteContact, { params: { workspaceId: A, contactId: alice.id } })).status).toBe(403);
    expect(failure(await c.call(endpoints.exportContacts, { params: { workspaceId: A } })).status).toBe(403);
    expect(failure(await c.call(endpoints.uploadImport, { params: { workspaceId: A }, body: { filename: "x.csv", csv: "name\nx" } })).status).toBe(403);
    expect(failure(await c.call(endpoints.createLifecycleStage, { params: { workspaceId: A }, body: { name: "Agent stage" } })).status).toBe(403);
    expect(failure(await c.call(endpoints.createCustomField, { params: { workspaceId: A }, body: { key: "agent_field", label: "X", type: "text" } })).status).toBe(403);
    const tag = ok(await c.call(endpoints.createTag, { params: { workspaceId: A }, body: { name: "agent-made" } })); // agents may create tags
    expect(failure(await c.call(endpoints.updateTag, { params: { workspaceId: A, tagId: tag.id }, body: { name: "renamed" } })).status).toBe(403);
    expect(failure(await c.call(endpoints.deleteTag, { params: { workspaceId: A, tagId: tag.id } })).status).toBe(403);
  });
  it("admins and owners can export, import, configure and delete", async () => {
    for (const u of [admin, owner]) {
      expect(ok(await as(u).call(endpoints.exportContacts, { params: { workspaceId: A } }))).toContain("Name,Email");
      expect(ok(await as(u).call(endpoints.uploadImport, { params: { workspaceId: A }, body: { filename: "x.csv", csv: "name\nx" } })).id).toBeTruthy();
    }
    const temp = await h.contact(as(admin), A, { name: "Temp Delete" });
    expect((await as(admin).call(endpoints.deleteContact, { params: { workspaceId: A, contactId: temp.id } })).ok).toBe(true);
  });
  it("notes: an agent edits and deletes their own but not another agent's; an admin can moderate", async () => {
    const p = { workspaceId: A, contactId: alice.id };
    const n = ok(await as(agent).call(endpoints.createNote, { params: p, body: { body: "Called, will follow up." } }));
    expect(ok(await as(agent).call(endpoints.updateNote, { params: { ...p, noteId: n.id }, body: { body: "Called, follow up Friday." } })).body).toContain("Friday");
    expect(failure(await as(agent2).call(endpoints.updateNote, { params: { ...p, noteId: n.id }, body: { body: "tamper" } })).status).toBe(403);
    expect(failure(await as(agent2).call(endpoints.deleteNote, { params: { ...p, noteId: n.id } })).status).toBe(403);
    expect(ok(await as(admin).call(endpoints.updateNote, { params: { ...p, noteId: n.id }, body: { body: "Moderated" } })).body).toBe("Moderated");
    expect((await as(agent).call(endpoints.deleteNote, { params: { ...p, noteId: n.id } })).ok).toBe(true);
    expect(ok(await as(agent).call(endpoints.listNotes, { params: p }))).toEqual([]);
  });
  it("tasks: agents manage tasks they created or are assigned; not others'", async () => {
    const p = { workspaceId: A, contactId: alice.id };
    const t = ok(await as(agent).call(endpoints.createTask, { params: p, body: { title: "Send quote", dueAt: "2026-12-01T09:00:00Z" } }));
    expect(t.assignee?.name).toBe("agent");
    expect(failure(await as(agent2).call(endpoints.updateTask, { params: { workspaceId: A, taskId: t.id }, body: { status: "done" } })).status).toBe(403);
    expect(ok(await as(agent).call(endpoints.updateTask, { params: { workspaceId: A, taskId: t.id }, body: { status: "done" } })).completedAt).toBeTruthy();
    expect(ok(await as(admin).call(endpoints.updateTask, { params: { workspaceId: A, taskId: t.id }, body: { status: "open" } })).completedAt).toBeNull();
    expect(failure(await as(viewer).call(endpoints.updateTask, { params: { workspaceId: A, taskId: t.id }, body: { status: "done" } })).status).toBe(403);
  });
  it("shared saved views need an admin; any member can keep personal views", async () => {
    const config = { columns: ["contact"] as "contact"[], filters: {}, sort: "created" as const, dir: "desc" as const };
    expect(failure(await as(agent).call(endpoints.createView, { params: { workspaceId: A }, body: { name: "Team view", shared: true, config } })).status).toBe(403);
    const shared = ok(await as(admin).call(endpoints.createView, { params: { workspaceId: A }, body: { name: "Team view", shared: true, config } }));
    expect(shared.shared).toBe(true);
    expect(ok(await as(viewer).call(endpoints.listViews, { params: { workspaceId: A } })).map((v) => v.name)).toContain("Team view");
    expect(failure(await as(agent).call(endpoints.updateView, { params: { workspaceId: A, viewId: shared.id }, body: { name: "Hijacked" } })).status).toBe(404);
    expect(ok(await as(viewer).call(endpoints.createView, { params: { workspaceId: A }, body: { name: "Viewer pref", config } })).mine).toBe(true);
  });
});

describe("create and update", () => {
  const c = () => as(agent);
  it("validates input with specific messages", async () => {
    const p = { workspaceId: A };
    expect(failure(await c().call(endpoints.createContact, { params: p, body: { name: "" } })).kind).toBe("invalid_request");
    expect(failure(await c().call(endpoints.createContact, { params: p, body: { name: "X", email: "nope" } })).message).toMatch(/valid email/);
    expect(failure(await c().call(endpoints.createContact, { params: p, body: { name: "X", phone: "12" } })).message).toMatch(/phone/);
  });
  it("detects duplicates by normalized email or phone and returns the candidates", async () => {
    const e = failure(await c().call(endpoints.createContact, { params: { workspaceId: A }, body: { name: "Alice Again", email: " ALICE@a.example " } }));
    expect(e).toMatchObject({ status: 409, code: "duplicate_contact" });
    expect((e.details as { candidates: { id: string; matchedOn: string[] }[] }).candidates[0]).toMatchObject({ id: alice.id, matchedOn: ["email"] });
    const byPhone = failure(await c().call(endpoints.createContact, { params: { workspaceId: A }, body: { name: "Phone Dup", phone: "+1 (555) 010-0001" } }));
    expect((byPhone.details as { candidates: { matchedOn: string[] }[] }).candidates[0]!.matchedOn).toEqual(["phone"]);
  });
  it("allows a deliberate duplicate", async () => {
    const d = ok(await c().call(endpoints.createContact, { params: { workspaceId: A }, body: { name: "Alice Twin", email: "alice@a.example", allowDuplicate: true } }));
    expect(d.id).not.toBe(alice.id);
  });
  it("duplicates are not detected across workspaces", async () => {
    expect((await as(ownerB).call(endpoints.createContact, { params: { workspaceId: B }, body: { name: "Same email", email: "alice@a.example" } })).ok).toBe(true);
  });
  it("assigns an owner who must be a member, and records the change", async () => {
    const withOwner = ok(await c().call(endpoints.updateContact, { params: { workspaceId: A, contactId: alice.id }, body: { expectedVersion: alice.version, ownerUserId: agent.id } }));
    expect(withOwner.owner).toEqual({ id: agent.id, name: "agent" });
    expect(failure(await c().call(endpoints.updateContact, { params: { workspaceId: A, contactId: alice.id }, body: { expectedVersion: withOwner.version, ownerUserId: outsider.id } })).code).toBe("invalid_owner");
    const act = ok(await c().call(endpoints.listActivity, { params: { workspaceId: A, contactId: alice.id } }));
    expect(act.items.find((i) => i.kind === "contact.owner_changed")?.data).toEqual({ from: null, to: "agent" });
    alice = withOwner;
  });
  it("changes lifecycle stage independently and records it", async () => {
    const stages = await stagesOf(owner, A);
    const q = ok(await c().call(endpoints.updateContact, { params: { workspaceId: A, contactId: alice.id }, body: { expectedVersion: alice.version, lifecycleStageId: stages[2]!.id } }));
    expect(q.lifecycleStage.name).toBe("Qualified");
    const act = ok(await c().call(endpoints.listActivity, { params: { workspaceId: A, contactId: alice.id } }));
    expect(act.items.find((i) => i.kind === "contact.lifecycle_changed")?.data).toEqual({ from: "New", to: "Qualified" });
    alice = q;
  });
  it("uses optimistic concurrency: a stale version is refused with the current record attached", async () => {
    const stale = alice.version - 1;
    const e = failure(await c().call(endpoints.updateContact, { params: { workspaceId: A, contactId: alice.id }, body: { expectedVersion: stale, name: "Stale write" } }));
    expect(e).toMatchObject({ status: 409, code: "version_conflict" });
    expect((e.details as { current: ContactDetail }).current.version).toBe(alice.version);
    expect(ok(await c().call(endpoints.getContact, { params: { workspaceId: A, contactId: alice.id } })).name).toBe("Alice Anders");
  });
  it("two simultaneous edits with the same version: exactly one wins", async () => {
    const p = { workspaceId: A, contactId: alice.id };
    const [r1, r2] = await Promise.all([as(agent).call(endpoints.updateContact, { params: p, body: { expectedVersion: alice.version, company: "Race One" } }), as(admin).call(endpoints.updateContact, { params: p, body: { expectedVersion: alice.version, company: "Race Two" } })]);
    expect([r1.ok, r2.ok].filter(Boolean)).toHaveLength(1);
    alice = ok(await c().call(endpoints.getContact, { params: p }));
  });
  it("a no-op update does not bump the version or add activity", async () => {
    const before = alice.version;
    const r = ok(await c().call(endpoints.updateContact, { params: { workspaceId: A, contactId: alice.id }, body: { expectedVersion: before, name: alice.name } }));
    expect(r.version).toBe(before);
  });
  it("soft delete hides the contact everywhere and is audited", async () => {
    const tmp = await h.contact(as(admin), A, { name: "To Delete", email: "gone@a.example" });
    expect((await as(admin).call(endpoints.deleteContact, { params: { workspaceId: A, contactId: tmp.id } })).ok).toBe(true);
    expect(failure(await as(admin).call(endpoints.getContact, { params: { workspaceId: A, contactId: tmp.id } })).status).toBe(404);
    expect(ok(await as(admin).call(endpoints.listContacts, { params: { workspaceId: A }, query: { search: "to delete" } })).items).toEqual([]);
    // a deleted contact no longer counts as a duplicate
    expect((await as(admin).call(endpoints.createContact, { params: { workspaceId: A }, body: { name: "Reborn", email: "gone@a.example" } })).ok).toBe(true);
    const audit = ok(await as(owner).call(endpoints.auditLog, { params: { workspaceId: A }, query: { limit: 20 } }));
    expect(audit.items.some((i) => i.action === "contact.deleted" && (i.summary as { name?: string }).name === "To Delete")).toBe(true);
  });
});

describe("mobile compatibility (bearer auth through the shared client)", () => {
  it("lists, reads, updates and reports conflicts the same way as cookie auth", async () => {
    const m = h.clientFor(agent, "bearer");
    const list = ok(await m.call(endpoints.listContacts, { params: { workspaceId: A }, query: { limit: 5 } }));
    expect(list.items.length).toBeGreaterThan(0);
    const one = ok(await m.call(endpoints.getContact, { params: { workspaceId: A, contactId: alice.id } }));
    const conflict = failure(await m.call(endpoints.updateContact, { params: { workspaceId: A, contactId: alice.id }, body: { expectedVersion: one.version - 1, name: "x" } }));
    expect(conflict.code).toBe("version_conflict");
    expect(conflict.details).toBeTruthy();
    expect(failure(await h.clientFor({ ...agent, token: "" }, "bearer").call(endpoints.listContacts, { params: { workspaceId: A } })).status).toBe(401);
  });
});
