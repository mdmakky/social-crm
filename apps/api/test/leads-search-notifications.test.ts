import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { endpoints, type LeadDto } from "@crm/contracts";
import { dispatchPending } from "../src/events.ts";
import { notificationsConsumer } from "../src/notifications/index.ts";
import { bootstrap, ok, type Harness, type TestUser } from "./harness.ts";

let h: Harness;
let owner: TestUser, agent: TestUser, viewer: TestUser, ownerB: TestUser;
let A = "", B = "";
let alice: { id: string };
const as = (u: TestUser) => h.clientFor(u);
const p = (ws = A) => ({ workspaceId: ws });
const create = async (u: TestUser, body: Record<string, unknown>, contactId = alice.id) => ok(await as(u).call(endpoints.createLead, { params: p(), body: { title: "Deal", primaryContactId: contactId, allowDuplicate: true, ...body } as never }));
const update = (u: TestUser, l: LeadDto, body: Record<string, unknown>) => as(u).call(endpoints.updateLead, { params: { workspaceId: A, leadId: l.id }, body: { expectedVersion: l.version, ...body } as never });
const dispatch = () => dispatchPending(h.db, { consumers: [notificationsConsumer], workspaceIds: [A] });
const mine = async (u: TestUser) => ok(await as(u).call(endpoints.listNotifications, { params: p() })).items.filter((n) => n.kind === "lead.owner_assigned");
const hits = async (u: TestUser, q: string, ws = A) => ok(await as(u).call(endpoints.search, { params: { workspaceId: ws }, query: { q } as never })).groups.find((g) => g.type === "leads")?.hits ?? [];

beforeAll(async () => {
  h = await bootstrap();
  owner = await h.newUser("ls-owner"); agent = await h.newUser("ls-agent"); viewer = await h.newUser("ls-viewer"); ownerB = await h.newUser("ls-ownerb");
  A = await h.workspace(owner, "LS A", { agent, viewer });
  B = await h.workspace(ownerB, "LS B");
  alice = await h.contact(as(owner), A, { name: "Alice Search" });
});
afterAll(async () => { await h.close(); });

describe("lead search", () => {
  it("finds by title with deep link, never returns deal value, viewer can search", async () => {
    const l = await create(owner, { title: "Zebra Renewal 100%", valueMinor: 987654, currency: "USD" });
    for (const u of [owner, viewer]) {
      const r = await hits(u, "zebra");
      expect(r).toHaveLength(1);
      expect(r[0]).toMatchObject({ id: l.id, type: "leads", title: "Zebra Renewal 100%", href: `/w/${A}/leads/${l.id}` });
      expect(JSON.stringify(r)).not.toMatch(/987654|valueMinor|USD/);
    }
    expect(await hits(owner, "100%")).toHaveLength(1);
    expect(await hits(owner, "%%")).toHaveLength(0);
  });
  it("is tenant isolated", async () => {
    await create(owner, { title: "Isolated Quokka" });
    expect(await hits(owner, "quokka")).toHaveLength(1);
    expect(await hits(ownerB, "quokka", B)).toHaveLength(0);
  });
  it("hides soft-deleted leads but keeps leads of deleted contacts searchable", async () => {
    const gone = await create(owner, { title: "Vanishing Wombat" });
    ok(await as(owner).call(endpoints.deleteLead, { params: { workspaceId: A, leadId: gone.id }, query: { expectedVersion: gone.version } as never }));
    expect(await hits(owner, "wombat")).toHaveLength(0);
    const c = await h.contact(as(owner), A, { name: "Doomed Contact" });
    const kept = await create(owner, { title: "Orphan Lemur" }, c.id);
    ok(await as(owner).call(endpoints.deleteContact, { params: { workspaceId: A, contactId: c.id } }));
    expect((await hits(owner, "lemur")).map((x) => x.id)).toEqual([kept.id]);
  });
});

describe("lead.owner_assigned notifications", () => {
  it("assigning to another user on create notifies once; self-assign notifies nobody", async () => {
    const l = await create(owner, { title: "Assigned On Create", ownerUserId: agent.id });
    await create(owner, { title: "Self Owned", ownerUserId: owner.id });
    await dispatch();
    const n = await mine(agent);
    expect(n.filter((x) => x.entityId === l.id)).toHaveLength(1);
    expect(n[0]).toMatchObject({ entityType: "lead", title: "Assigned On Create was assigned to you" });
    expect(await mine(owner)).toHaveLength(0);
  });
  it("PATCH owner notifies once, no-op or unrelated update does not duplicate, and no deal value leaks", async () => {
    const l = await create(owner, { title: "Reassign Me", valueMinor: 555111, currency: "USD" });
    const r = ok(await update(owner, l, { ownerUserId: agent.id }));
    await dispatch();
    const count = async () => (await mine(agent)).filter((x) => x.entityId === l.id);
    expect(await count()).toHaveLength(1);
    ok(await update(owner, r, { ownerUserId: agent.id, priority: "high" }));
    await dispatch();
    expect(await count()).toHaveLength(1);
    expect(JSON.stringify(await count())).not.toMatch(/555111|USD/);
  });
  it("respects the recipient's preference", async () => {
    ok(await as(agent).call(endpoints.updateNotificationPreferences, { params: p(), body: { preferences: [{ kind: "lead.owner_assigned", inApp: false }] } }));
    const before = (await mine(agent)).length;
    await create(owner, { title: "Muted Assignment", ownerUserId: agent.id });
    await dispatch();
    expect((await mine(agent)).length).toBe(before);
  });
});
