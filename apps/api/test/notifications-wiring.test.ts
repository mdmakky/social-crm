import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { endpoints } from "@crm/contracts";
import { dispatchPending } from "../src/events.ts";
import { notificationsConsumer } from "../src/notifications/index.ts";
import { bootstrap, ok, type Harness, type TestUser } from "./harness.ts";

// Integration of tracks B/C with the contacts and imports routes: real writes produce events, the dispatcher turns them into notifications.
let h: Harness;
let owner: TestUser, agent: TestUser;
let W: string;
const o = () => h.clientFor(owner);
const p = () => ({ workspaceId: W });
const dispatch = () => dispatchPending(h.db, { consumers: [notificationsConsumer], workspaceIds: [W] });
const mine = async (u: TestUser) => ok(await h.clientFor(u).call(endpoints.listNotifications, { params: p() })).items;

beforeAll(async () => {
  h = await bootstrap({ import: { limits: { uploadsPerUser: 10_000, previewsPerUser: 10_000, commitsPerWorkspace: 10_000, maxOpenJobs: 10_000 } } });
  owner = await h.newUser("nw-owner"); agent = await h.newUser("nw-agent");
  W = await h.workspace(owner, "Notif Wiring Co", { agent });
});
afterAll(async () => h.close());

describe("notification wiring", () => {
  it("assigning a contact to someone else notifies them; self-assignment and unchanged owners notify nobody", async () => {
    const c = await h.contact(o(), W, { name: "Owned By Agent", email: "oa@nw.example", ownerUserId: agent.id });
    await h.contact(o(), W, { name: "Owned By Me", email: "om@nw.example", ownerUserId: owner.id });
    await dispatch();
    const items = await mine(agent);
    expect(items.filter((n) => n.kind === "contact.owner_assigned")).toHaveLength(1);
    expect(items.find((n) => n.kind === "contact.owner_assigned")).toMatchObject({ entityType: "contact", entityId: c.id });
    expect((await mine(owner)).filter((n) => n.kind === "contact.owner_assigned")).toHaveLength(0);
    // PATCH with the same owner is not a change
    ok(await o().call(endpoints.updateContact, { params: { ...p(), contactId: c.id }, body: { expectedVersion: c.version, ownerUserId: agent.id, company: "Same Owner" } }));
    await dispatch();
    expect((await mine(agent)).filter((n) => n.kind === "contact.owner_assigned")).toHaveLength(1);
  });
  it("changing a contact's owner to the agent notifies the agent", async () => {
    const c = await h.contact(o(), W, { name: "Reassigned", email: "re@nw.example" });
    ok(await o().call(endpoints.updateContact, { params: { ...p(), contactId: c.id }, body: { expectedVersion: c.version, ownerUserId: agent.id } }));
    await dispatch();
    expect((await mine(agent)).filter((n) => n.kind === "contact.owner_assigned" && n.entityId === c.id)).toHaveLength(1);
  });
  it("creating or reassigning a task notifies the assignee", async () => {
    const c = await h.contact(o(), W, { name: "Task Host", email: "th@nw.example" });
    const t = ok(await o().call(endpoints.createTask, { params: { ...p(), contactId: c.id }, body: { title: "Call back", assigneeUserId: agent.id } }));
    await dispatch();
    expect((await mine(agent)).filter((n) => n.kind === "task.assigned" && n.entityId === t.id)).toHaveLength(1);
    const t2 = ok(await o().call(endpoints.createTask, { params: { ...p(), contactId: c.id }, body: { title: "Mine first" } }));
    ok(await o().call(endpoints.updateTask, { params: { ...p(), taskId: t2.id }, body: { assigneeUserId: agent.id } }));
    await dispatch();
    expect((await mine(agent)).filter((n) => n.kind === "task.assigned" && n.entityId === t2.id)).toHaveLength(1);
  });
  it("a finished import notifies the person who ran it, and a rolled-back import produces no event", async () => {
    const up = ok(await o().call(endpoints.uploadImport, { params: p(), body: { filename: "n.csv", csv: "Name,Email\nImp One,i1@nw.example\nImp Two,i2@nw.example\n" } }));
    const res = ok(await o().call(endpoints.commitImport, { params: { ...p(), importId: up.id }, body: { mapping: ["name", "email"], onDuplicate: "skip" } }));
    await dispatch();
    const n = (await mine(owner)).find((x) => x.kind === "import.completed" && x.entityId === up.id);
    expect(n).toBeTruthy();
    expect(res.created).toBe(2);
    const before = (await h.admin.query("SELECT count(*)::int n FROM domain_events WHERE workspace_id=$1 AND type='import.completed'", [W])).rows[0].n;
    const bad = ok(await o().call(endpoints.uploadImport, { params: p(), body: { filename: "x.csv", csv: "Name,Email\nA,a@nw.example\n" } }));
    await o().call(endpoints.commitImport, { params: { ...p(), importId: bad.id }, body: { mapping: ["company", null], onDuplicate: "skip" } }); // no name, email or phone column mapped: refused, nothing written
    expect((await h.admin.query("SELECT count(*)::int n FROM domain_events WHERE workspace_id=$1 AND type='import.completed'", [W])).rows[0].n).toBe(before);
  });
});
