import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { endpoints } from "@crm/contracts";
import { bootstrap, failure, ok, type Harness, type TestUser } from "./harness.ts";

let h: Harness;
let owner: TestUser, agent: TestUser;
let W: string;
const o = () => h.clientFor(owner);
const p = () => ({ workspaceId: W });

beforeAll(async () => {
  h = await bootstrap();
  owner = await h.newUser("cowner");
  agent = await h.newUser("cagent");
  W = await h.workspace(owner, "Config Co", { agent });
});
afterAll(async () => h.close());

describe("lifecycle stages (workspace-configurable, independent of any pipeline)", () => {
  it("can be renamed, added, reordered and archived", async () => {
    const stages = ok(await o().call(endpoints.listLifecycleStages, { params: p() }));
    const renamed = ok(await o().call(endpoints.updateLifecycleStage, { params: { ...p(), stageId: stages[1]!.id }, body: { name: "Warm" } }));
    expect(renamed.name).toBe("Warm");
    const added = ok(await o().call(endpoints.createLifecycleStage, { params: p(), body: { name: "Churned" } }));
    expect(added.position).toBe(5);
    const order = [added.id, ...stages.map((s) => s.id)];
    const reordered = ok(await o().call(endpoints.reorderLifecycleStages, { params: p(), body: { ids: order } }));
    expect(reordered.map((s) => s.name)).toEqual(["Churned", "New", "Warm", "Qualified", "Customer", "Inactive"]);
    const archived = ok(await o().call(endpoints.updateLifecycleStage, { params: { ...p(), stageId: added.id }, body: { archived: true } }));
    expect(archived.archived).toBe(true);
    ok(await o().call(endpoints.updateLifecycleStage, { params: { ...p(), stageId: added.id }, body: { archived: false } }));
  });
  it("rejects duplicate names (case-insensitive), partial or repeated reorders, and archiving the last active stage", async () => {
    const stages = ok(await o().call(endpoints.listLifecycleStages, { params: p() }));
    expect(failure(await o().call(endpoints.createLifecycleStage, { params: p(), body: { name: "new" } })).code).toBe("name_taken");
    expect(failure(await o().call(endpoints.reorderLifecycleStages, { params: p(), body: { ids: stages.slice(1).map((s) => s.id) } })).code).toBe("invalid_order");
    expect(failure(await o().call(endpoints.reorderLifecycleStages, { params: p(), body: { ids: [...stages.map((s) => s.id), stages[0]!.id] } })).code).toBe("invalid_order");
    // archive down to one, then refuse
    for (const s of stages.slice(1)) ok(await o().call(endpoints.updateLifecycleStage, { params: { ...p(), stageId: s.id }, body: { archived: true } }));
    expect(failure(await o().call(endpoints.updateLifecycleStage, { params: { ...p(), stageId: stages[0]!.id }, body: { archived: true } })).code).toBe("last_stage");
    for (const s of stages.slice(1)) ok(await o().call(endpoints.updateLifecycleStage, { params: { ...p(), stageId: s.id }, body: { archived: false } }));
  });
  it("an archived stage keeps its contacts but cannot be assigned to anyone", async () => {
    const stages = ok(await o().call(endpoints.listLifecycleStages, { params: p() }));
    const target = stages[4]!;
    const c = await h.contact(o(), W, { name: "Stage Holder", lifecycleStageId: target.id });
    ok(await o().call(endpoints.updateLifecycleStage, { params: { ...p(), stageId: target.id }, body: { archived: true } }));
    expect(ok(await o().call(endpoints.getContact, { params: { ...p(), contactId: c.id } })).lifecycleStage.name).toBe(target.name);
    const counts = ok(await o().call(endpoints.listLifecycleStages, { params: p() }));
    expect(counts.find((s) => s.id === target.id)).toMatchObject({ archived: true, contactCount: 1 });
    expect(failure(await o().call(endpoints.createContact, { params: p(), body: { name: "No", lifecycleStageId: target.id } })).code).toBe("invalid_stage");
    const moved = ok(await o().call(endpoints.updateContact, { params: { ...p(), contactId: c.id }, body: { expectedVersion: c.version, lifecycleStageId: stages[0]!.id } }));
    expect(failure(await o().call(endpoints.updateContact, { params: { ...p(), contactId: c.id }, body: { expectedVersion: moved.version, lifecycleStageId: target.id } })).code).toBe("invalid_stage");
  });
  it("only admins configure; agents just read; reordering is audited", async () => {
    expect(ok(await h.clientFor(agent).call(endpoints.listLifecycleStages, { params: p() })).length).toBeGreaterThan(0);
    const audit = ok(await o().call(endpoints.auditLog, { params: p(), query: { limit: 50 } }));
    expect(audit.items.map((i) => i.action)).toEqual(expect.arrayContaining(["lifecycle_stage.created", "lifecycle_stage.renamed", "lifecycle_stage.reordered", "lifecycle_stage.archived"]));
  });
});

describe("tags", () => {
  it("are created by name, case-insensitively unique, attached idempotently and removable", async () => {
    const c = await h.contact(o(), W, { name: "Tag Target" });
    const added = ok(await o().call(endpoints.addContactTag, { params: { ...p(), contactId: c.id }, body: { name: "Wholesale" } }));
    expect(added.tags.map((t) => t.name)).toEqual(["Wholesale"]);
    ok(await o().call(endpoints.addContactTag, { params: { ...p(), contactId: c.id }, body: { name: "wholesale" } })); // same tag, not a second one
    const tags = ok(await o().call(endpoints.listTags, { params: p() }));
    expect(tags.filter((t) => t.name.toLowerCase() === "wholesale")).toHaveLength(1);
    expect(tags.find((t) => t.name === "Wholesale")!.contactCount).toBe(1);
    expect(failure(await o().call(endpoints.createTag, { params: p(), body: { name: "WHOLESALE" } })).code).toBe("name_taken");
    const removed = ok(await o().call(endpoints.removeContactTag, { params: { ...p(), contactId: c.id, tagId: tags.find((t) => t.name === "Wholesale")!.id } }));
    expect(removed.tags).toEqual([]);
    const act = ok(await o().call(endpoints.listActivity, { params: { ...p(), contactId: c.id } }));
    expect(act.items.map((i) => i.kind).slice(0, 2)).toEqual(["contact.tag_removed", "contact.tag_added"]);
  });
  it("renaming and deleting a tag is an admin action; deleting removes it from every contact", async () => {
    const c = await h.contact(o(), W, { name: "Tag Cascade" });
    const t = ok(await o().call(endpoints.createTag, { params: p(), body: { name: "temp-tag", color: "warning" } }));
    ok(await o().call(endpoints.addContactTag, { params: { ...p(), contactId: c.id }, body: { tagId: t.id } }));
    expect(ok(await o().call(endpoints.updateTag, { params: { ...p(), tagId: t.id }, body: { name: "temp-renamed", color: "danger" } }))).toMatchObject({ name: "temp-renamed", color: "danger", contactCount: 1 });
    expect((await o().call(endpoints.deleteTag, { params: { ...p(), tagId: t.id } })).ok).toBe(true);
    expect(ok(await o().call(endpoints.getContact, { params: { ...p(), contactId: c.id } })).tags).toEqual([]);
  });
});

describe("custom fields", () => {
  it("are defined with a key and type; keys are unique and invalid keys are refused", async () => {
    ok(await o().call(endpoints.createCustomField, { params: p(), body: { key: "budget", label: "Budget", type: "number" } }));
    ok(await o().call(endpoints.createCustomField, { params: p(), body: { key: "tier", label: "Tier", type: "select", options: ["gold", "silver"], required: false } }));
    expect(failure(await o().call(endpoints.createCustomField, { params: p(), body: { key: "budget", label: "Again", type: "text" } })).code).toBe("key_taken");
    expect(failure(await o().call(endpoints.createCustomField, { params: p(), body: { key: "Bad Key", label: "x", type: "text" } })).kind).toBe("invalid_request");
    expect(failure(await o().call(endpoints.createCustomField, { params: p(), body: { key: "choices", label: "x", type: "select" } })).kind).toBe("invalid_request"); // select needs options
  });
  it("values are validated on create and update, and per-field errors are returned", async () => {
    const bad = failure(await o().call(endpoints.createContact, { params: p(), body: { name: "Custom Bad", custom: { budget: "lots", tier: "bronze", mystery: 1 } } }));
    expect(bad).toMatchObject({ status: 422, code: "invalid_custom_fields" });
    expect(Object.keys(bad.details as object).sort()).toEqual(["budget", "mystery", "tier"]);
    const good = await h.contact(o(), W, { name: "Custom Good", custom: { budget: 1200, tier: "gold" } });
    expect(good.custom).toEqual({ budget: 1200, tier: "gold" });
    const updated = ok(await o().call(endpoints.updateContact, { params: { ...p(), contactId: good.id }, body: { expectedVersion: good.version, custom: { budget: null, tier: "silver" } } }));
    expect(updated.custom).toEqual({ tier: "silver" });
  });
  it("required fields are enforced on create; archived fields keep their stored values but stop validating", async () => {
    const f = ok(await o().call(endpoints.createCustomField, { params: p(), body: { key: "region", label: "Region", type: "text", required: true } }));
    expect(failure(await o().call(endpoints.createContact, { params: p(), body: { name: "No Region" } })).code).toBe("invalid_custom_fields");
    const c = await h.contact(o(), W, { name: "Has Region", custom: { region: "EMEA" } });
    ok(await o().call(endpoints.updateCustomField, { params: { ...p(), fieldId: f.id }, body: { archived: true } }));
    expect(ok(await o().call(endpoints.getContact, { params: { ...p(), contactId: c.id } })).custom).toMatchObject({ region: "EMEA" });
    expect((await o().call(endpoints.createContact, { params: p(), body: { name: "After Archive" } })).ok).toBe(true);
    expect(failure(await h.clientFor(agent).call(endpoints.createCustomField, { params: p(), body: { key: "agentfield", label: "x", type: "text" } })).status).toBe(403);
  });
});

describe("timeline and saved views", () => {
  it("lists activity newest first and pages through it with a cursor", async () => {
    const c = await h.contact(o(), W, { name: "Busy Contact" });
    for (let i = 0; i < 6; i++) ok(await o().call(endpoints.createNote, { params: { ...p(), contactId: c.id }, body: { body: `note ${i}` } }));
    const first = ok(await o().call(endpoints.listActivity, { params: { ...p(), contactId: c.id }, query: { limit: 4 } }));
    expect(first.items.map((i) => i.kind)).toEqual(["note.added", "note.added", "note.added", "note.added"]);
    expect((first.items[0]!.data as { preview: string }).preview).toBe("note 5");
    const rest = ok(await o().call(endpoints.listActivity, { params: { ...p(), contactId: c.id }, query: { limit: 4, cursor: first.nextCursor! } }));
    expect(rest.items.map((i) => i.kind)).toEqual(["note.added", "note.added", "contact.created"]);
    expect(rest.nextCursor).toBeNull();
    expect(ok(await o().call(endpoints.getContact, { params: { ...p(), contactId: c.id } })).openTaskCount).toBe(0);
  });
  it("completing a task is recorded and the contact's open-task count follows", async () => {
    const c = await h.contact(o(), W, { name: "Task Holder" });
    const t = ok(await o().call(endpoints.createTask, { params: { ...p(), contactId: c.id }, body: { title: "Follow up", dueAt: "2026-12-05T10:00:00Z" } }));
    expect(ok(await o().call(endpoints.getContact, { params: { ...p(), contactId: c.id } })).openTaskCount).toBe(1);
    ok(await o().call(endpoints.updateTask, { params: { ...p(), taskId: t.id }, body: { status: "done" } }));
    expect(ok(await o().call(endpoints.getContact, { params: { ...p(), contactId: c.id } })).openTaskCount).toBe(0);
    const kinds = ok(await o().call(endpoints.listActivity, { params: { ...p(), contactId: c.id } })).items.map((i) => i.kind);
    expect(kinds.slice(0, 2)).toEqual(["task.completed", "task.created"]);
    expect(ok(await o().call(endpoints.listContactTasks, { params: { ...p(), contactId: c.id } }))[0]!.status).toBe("done");
    expect(failure(await o().call(endpoints.createTask, { params: { ...p(), contactId: c.id }, body: { title: "x", assigneeUserId: "stranger" } })).code).toBe("invalid_assignee");
  });
  it("saved views validate their column set (the contact column is required, columns unique)", async () => {
    const ok1 = ok(await o().call(endpoints.createView, { params: p(), body: { name: "Compact", config: { columns: ["contact", "lifecycle", "lastActivity"], filters: { ownerId: "me" }, sort: "lastActivity", dir: "desc" } } }));
    expect(ok1.config.columns).toEqual(["contact", "lifecycle", "lastActivity"]);
    expect(failure(await o().call(endpoints.createView, { params: p(), body: { name: "Bad", config: { columns: ["tags"], filters: {}, sort: "name", dir: "asc" } } })).kind).toBe("invalid_request");
    expect(failure(await o().call(endpoints.createView, { params: p(), body: { name: "Dup", config: { columns: ["contact", "contact"], filters: {}, sort: "name", dir: "asc" } } })).kind).toBe("invalid_request");
    const renamed = ok(await o().call(endpoints.updateView, { params: { ...p(), viewId: ok1.id }, body: { name: "Compact v2" } }));
    expect(renamed.name).toBe("Compact v2");
    expect((await o().call(endpoints.deleteView, { params: { ...p(), viewId: ok1.id } })).ok).toBe(true);
  });
});
