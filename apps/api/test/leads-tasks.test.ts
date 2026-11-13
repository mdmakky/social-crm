import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { endpoints, type ContactDetail } from "@crm/contracts";
import { bootstrap, failure, ok, type Harness, type TestUser } from "./harness.ts";

let h: Harness;
let owner!: TestUser, agent!: TestUser, agent2!: TestUser, viewer!: TestUser, ownerB!: TestUser;
let A = "", B = "";
let alice!: ContactDetail;
const as = (u: TestUser) => h.clientFor(u);
const lp = (leadId: string, ws = A, taskId = "") => ({ workspaceId: ws, leadId, taskId });
const status = (r: Parameters<typeof failure>[0]) => (failure(r) as unknown as { code: string }).code;
const lead = async () => ok(await as(owner).call(endpoints.createLead, { params: { workspaceId: A }, body: { title: "Deal", primaryContactId: alice.id, allowDuplicate: true } }));
const task = async (u: TestUser, body: Record<string, unknown> = {}) => ok(await as(u).call(endpoints.createWorkspaceTask, { params: { workspaceId: A }, body: { title: "T", ...body } as never }));
const next = async (id: string) => ok(await as(owner).call(endpoints.getLead, { params: lp(id) })).nextActivityAt;

beforeAll(async () => {
  h = await bootstrap();
  owner = await h.newUser("lt-owner"); agent = await h.newUser("lt-agent"); agent2 = await h.newUser("lt-agent2"); viewer = await h.newUser("lt-viewer"); ownerB = await h.newUser("lt-ownerb");
  A = await h.workspace(owner, "LT A", { agent, agent2, viewer });
  B = await h.workspace(ownerB, "LT B");
  alice = await h.contact(as(owner), A, { name: "Alice" });
});
afterAll(async () => { await h.close(); });

describe("lead tasks", () => {
  it("creates a linked task (with contact), lists it, and drives next_activity_at", async () => {
    const l = await lead();
    expect(l.nextActivityAt).toBeNull();
    const due = "2031-03-02T10:00:00.000Z";
    const t = ok(await as(agent).call(endpoints.createLeadTask, { params: lp(l.id), body: { title: "Call", dueAt: due, contactId: alice.id } }));
    expect(t.contact?.id).toBe(alice.id);
    expect(ok(await as(agent).call(endpoints.listLeadTasks, { params: lp(l.id) })).map((x) => x.id)).toEqual([t.id]);
    expect(await next(l.id)).toBe(due);
    // a contact-scoped list still sees it
    expect(ok(await as(agent).call(endpoints.listContactTasks, { params: { workspaceId: A, contactId: alice.id } })).some((x) => x.id === t.id)).toBe(true);
    ok(await as(agent).call(endpoints.updateTask, { params: { workspaceId: A, taskId: t.id }, body: { dueAt: "2031-03-05T10:00:00.000Z" } }));
    expect(await next(l.id)).toBe("2031-03-05T10:00:00.000Z");
    ok(await as(agent).call(endpoints.updateTask, { params: { workspaceId: A, taskId: t.id }, body: { status: "done" } }));
    expect(await next(l.id)).toBeNull();
    ok(await as(agent).call(endpoints.updateTask, { params: { workspaceId: A, taskId: t.id }, body: { status: "open" } }));
    expect(await next(l.id)).toBe("2031-03-05T10:00:00.000Z");
    ok(await as(agent).call(endpoints.deleteTask, { params: { workspaceId: A, taskId: t.id } }));
    expect(await next(l.id)).toBeNull();
    expect(ok(await as(agent).call(endpoints.listLeadTasks, { params: lp(l.id) }))).toEqual([]);
  });

  it("links and unlinks an existing task; relink is idempotent", async () => {
    const l = await lead();
    const t = await task(agent, { dueAt: "2031-04-01T00:00:00.000Z" });
    ok(await as(agent).call(endpoints.linkLeadTask, { params: lp(l.id, A, t.id) }));
    ok(await as(agent).call(endpoints.linkLeadTask, { params: lp(l.id, A, t.id) }));
    expect(await next(l.id)).toBe("2031-04-01T00:00:00.000Z");
    ok(await as(agent).call(endpoints.unlinkLeadTask, { params: lp(l.id, A, t.id) }));
    expect(await next(l.id)).toBeNull();
    expect(ok(await as(agent).call(endpoints.listLeadTasks, { params: lp(l.id) }))).toEqual([]);
  });

  it("permissions: viewer cannot; agent only tasks they own; owner can link any", async () => {
    const l = await lead();
    const mine = await task(agent), theirs = await task(owner, { assigneeUserId: null });
    expect(status(await as(viewer).call(endpoints.linkLeadTask, { params: lp(l.id, A, mine.id) }))).toBe("forbidden");
    expect(status(await as(viewer).call(endpoints.createLeadTask, { params: lp(l.id), body: { title: "x" } }))).toBe("forbidden");
    expect(status(await as(agent2).call(endpoints.linkLeadTask, { params: lp(l.id, A, mine.id) }))).toBe("forbidden");
    expect(status(await as(agent).call(endpoints.linkLeadTask, { params: lp(l.id, A, theirs.id) }))).toBe("forbidden");
    ok(await as(agent).call(endpoints.linkLeadTask, { params: lp(l.id, A, mine.id) }));
    expect(status(await as(viewer).call(endpoints.unlinkLeadTask, { params: lp(l.id, A, mine.id) }))).toBe("forbidden");
    expect(status(await as(agent2).call(endpoints.unlinkLeadTask, { params: lp(l.id, A, mine.id) }))).toBe("forbidden");
    ok(await as(owner).call(endpoints.linkLeadTask, { params: lp(l.id, A, theirs.id) }));
    expect(ok(await as(viewer).call(endpoints.listLeadTasks, { params: lp(l.id) }))).toHaveLength(2);
  });

  it("404s across workspaces and for unknown ids", async () => {
    const l = await lead();
    const t = await task(owner);
    const bt = ok(await as(ownerB).call(endpoints.createWorkspaceTask, { params: { workspaceId: B }, body: { title: "B" } }));
    expect(status(await as(owner).call(endpoints.linkLeadTask, { params: lp(l.id, A, bt.id) }))).toBe("not_found");
    expect(status(await as(ownerB).call(endpoints.linkLeadTask, { params: lp(l.id, B, bt.id) }))).toBe("not_found");
    expect(status(await as(ownerB).call(endpoints.listLeadTasks, { params: lp(l.id, B) }))).toBe("not_found");
    expect(status(await as(owner).call(endpoints.linkLeadTask, { params: lp("00000000-0000-4000-8000-000000000000", A, t.id) }))).toBe("not_found");
    expect(status(await as(owner).call(endpoints.createLeadTask, { params: lp("00000000-0000-4000-8000-000000000000"), body: { title: "x" } }))).toBe("not_found");
  });
});
