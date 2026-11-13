import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { endpoints, type ContactDetail, type Task, type TaskListQuery } from "@crm/contracts";
import { bootstrap, failure, ok, type Harness, type TestUser } from "./harness.ts";

let h: Harness;
let owner: TestUser, admin: TestUser, agent: TestUser, agent2: TestUser, viewer: TestUser, outsider: TestUser, ownerB: TestUser;
let A: string;
let B: string;
let alice: ContactDetail;
let bob: ContactDetail;

const as = (u: TestUser) => h.clientFor(u);
const p = (ws = A) => ({ workspaceId: ws });
const create = async (u: TestUser, body: Record<string, unknown>, ws = A) => ok(await as(u).call(endpoints.createWorkspaceTask, { params: p(ws), body: body as never }));
const list = async (u: TestUser, query: TaskListQuery = {}, ws = A) => ok(await as(u).call(endpoints.listTasks, { params: p(ws), query }));
const patch = (u: TestUser, id: string, body: Record<string, unknown>, ws = A) => as(u).call(endpoints.updateTask, { params: { workspaceId: ws, taskId: id }, body: body as never });
const events = async (u: TestUser, id: string, ws = A) => ok(await as(u).call(endpoints.listTaskEvents, { params: { workspaceId: ws, taskId: id }, query: { limit: 100 } })).items;
const kinds = async (id: string) => (await events(owner, id)).map((e) => e.kind).reverse();
const raw = (u: TestUser, method: string, path: string, body?: unknown) => h.app.request(`/v1/workspaces/${A}${path}`, { method, headers: { cookie: u.cookie, origin: "http://localhost:3000", "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
const status = (r: { ok: boolean }) => (r as unknown as { error: { status: number } }).error.status;

beforeAll(async () => {
  h = await bootstrap();
  const u = await Promise.all(["owner", "admin", "agent", "agent2", "viewer", "outsider", "ownerb"].map((l) => h.newUser(l)));
  [owner, admin, agent, agent2, viewer, outsider, ownerB] = u as [TestUser, TestUser, TestUser, TestUser, TestUser, TestUser, TestUser];
  A = await h.workspace(owner, "Tasks A", { admin, agent, agent2, viewer });
  B = await h.workspace(ownerB, "Tasks B");
  alice = await h.contact(as(agent), A, { name: "Alice Anders" });
  bob = await h.contact(as(ownerB), B, { name: "Bob Brown" });
});
afterAll(async () => h.close());

describe("create and validate", () => {
  it("creates a standalone task with defaults and assigns it to the creator", async () => {
    const t = await create(agent, { title: "  Prepare quote  " });
    expect(t).toMatchObject({ title: "Prepare quote", status: "open", priority: "normal", description: null, dueAt: null, contactId: null, contact: null, version: 1, assignee: { id: agent.id }, createdBy: { id: agent.id } });
    expect(await kinds(t.id)).toEqual(["created"]);
  });
  it("accepts description, due date, priority, explicit unassigned and a contact", async () => {
    const t = await create(admin, { title: "Call back", description: "About the renewal", dueAt: "2026-12-01T09:00:00+02:00", priority: "urgent", assigneeUserId: null, contactId: alice.id });
    expect(t).toMatchObject({ description: "About the renewal", dueAt: "2026-12-01T07:00:00.000Z", priority: "urgent", assignee: null, contact: { id: alice.id, name: "Alice Anders" } });
  });
  it.each([
    ["empty title", { title: "   " }],
    ["title over 200 characters", { title: "x".repeat(201) }],
    ["description over 4000 characters", { title: "ok", description: "x".repeat(4001) }],
    ["due date without offset", { title: "ok", dueAt: "2026-12-01T09:00:00" }],
    ["due date in the year 202", { title: "ok", dueAt: "0202-12-01T09:00:00Z" }],
    ["due date past 2100", { title: "ok", dueAt: "2101-01-01T00:00:00Z" }],
    ["unknown priority", { title: "ok", priority: "critical" }],
    ["contact id that is not a uuid", { title: "ok", contactId: "nope" }],
  ])("rejects %s with 400", async (_n, body) => {
    expect((await raw(owner, "POST", "/tasks", body)).status).toBe(400);
    expect((await as(owner).call(endpoints.createWorkspaceTask, { params: p(), body: body as never })).ok).toBe(false); // the typed client refuses it too
  });
  it("rejects an assignee who is not a member and a contact from another workspace", async () => {
    expect(failure(await as(owner).call(endpoints.createWorkspaceTask, { params: p(), body: { title: "x", assigneeUserId: outsider.id } })).code).toBe("invalid_assignee");
    expect(failure(await as(owner).call(endpoints.createWorkspaceTask, { params: p(), body: { title: "x", contactId: bob.id } })).code).toBe("invalid_contact");
  });
  it("rejects an assignee whose membership is no longer active", async () => {
    const gone = await h.newUser("gone");
    await h.admin.query("INSERT INTO memberships(workspace_id,user_id,role,status) VALUES ($1,$2,'agent','deactivated')", [A, gone.id]);
    expect(failure(await as(owner).call(endpoints.createWorkspaceTask, { params: p(), body: { title: "x", assigneeUserId: gone.id } })).code).toBe("invalid_assignee");
  });
});

describe("tenant isolation on every task operation", () => {
  let t: Task;
  beforeAll(async () => { t = await create(agent, { title: "A only", contactId: alice.id }); });
  it("workspace B's owner gets 404 for A's task on read, history, update, delete, and 403/404 on A's collection", async () => {
    const pb = { workspaceId: B, taskId: t.id };
    expect(status(await as(ownerB).call(endpoints.getTask, { params: pb }))).toBe(404);
    expect(status(await as(ownerB).call(endpoints.listTaskEvents, { params: pb }))).toBe(404);
    expect(status(await as(ownerB).call(endpoints.updateTask, { params: pb, body: { title: "hijack" } }))).toBe(404);
    expect(status(await as(ownerB).call(endpoints.deleteTask, { params: pb }))).toBe(404);
    for (const r of [await as(ownerB).call(endpoints.listTasks, { params: p() }), await as(ownerB).call(endpoints.taskSummary, { params: p() }), await as(ownerB).call(endpoints.createWorkspaceTask, { params: p(), body: { title: "x" } }), await as(ownerB).call(endpoints.getTask, { params: { workspaceId: A, taskId: t.id } }), await as(ownerB).call(endpoints.listContactTasks, { params: { ...p(B), contactId: alice.id } }), await as(ownerB).call(endpoints.createTask, { params: { ...p(B), contactId: alice.id }, body: { title: "x" } })]) expect([403, 404]).toContain(status(r));
    expect((await list(ownerB, {}, B)).items.map((x) => x.id)).not.toContain(t.id);
    expect(ok(await as(ownerB).call(endpoints.taskSummary, { params: p(B) })).active).toBe(0);
    expect((await list(owner)).items.find((x) => x.id === t.id)?.title).toBe("A only"); // untouched
  });
  it("a user who is not a member of the workspace is refused", async () => {
    expect([403, 404]).toContain(status(await as(outsider).call(endpoints.listTasks, { params: p() })));
  });
  it("cannot move a task onto another workspace's contact", async () => {
    expect(failure(await patch(owner, t.id, { contactId: bob.id })).code).toBe("invalid_contact");
  });
  it("another workspace's filter by contactId or assignee id never leaks rows", async () => {
    expect((await list(ownerB, { contactId: alice.id }, B)).items).toHaveLength(0);
    expect((await list(ownerB, { assignee: agent.id }, B)).items).toHaveLength(0);
  });
});

describe("permissions follow the matrix (task.edit: owner/admin all, agent own, viewer none; all roles view)", () => {
  let mine: Task, others: Task, assignedToAgent: Task;
  beforeAll(async () => {
    mine = await create(agent, { title: "agent made this", assigneeUserId: null });
    others = await create(admin, { title: "admin made this", assigneeUserId: admin.id });
    assignedToAgent = await create(admin, { title: "admin gave this to agent", assigneeUserId: agent.id });
  });
  it("every role can list, read and see history", async () => {
    for (const u of [owner, admin, agent, viewer]) {
      expect((await list(u, { search: "made this" })).items.length).toBeGreaterThanOrEqual(2);
      expect(ok(await as(u).call(endpoints.getTask, { params: { workspaceId: A, taskId: mine.id } })).id).toBe(mine.id);
      expect((await events(u, mine.id)).length).toBe(1);
    }
  });
  it("viewers cannot create, update or delete", async () => {
    expect(status(await as(viewer).call(endpoints.createWorkspaceTask, { params: p(), body: { title: "v" } }))).toBe(403);
    expect(status(await patch(viewer, mine.id, { status: "done" }))).toBe(403);
    expect(status(await as(viewer).call(endpoints.deleteTask, { params: { workspaceId: A, taskId: mine.id } }))).toBe(403);
    expect(status(await as(viewer).call(endpoints.createTask, { params: { ...p(), contactId: alice.id }, body: { title: "v" } }))).toBe(403);
  });
  it("an agent edits tasks they created or are assigned to, not someone else's", async () => {
    expect(ok(await patch(agent, mine.id, { status: "in_progress" })).status).toBe("in_progress");
    expect(ok(await patch(agent, assignedToAgent.id, { priority: "high" })).priority).toBe("high");
    expect(status(await patch(agent, others.id, { title: "nope" }))).toBe(403);
    expect(status(await patch(agent2, mine.id, { title: "nope" }))).toBe(403);
    expect(status(await as(agent2).call(endpoints.deleteTask, { params: { workspaceId: A, taskId: mine.id } }))).toBe(403);
    expect((await list(owner, { search: "admin made this" })).items[0]!.title).toBe("admin made this");
  });
  it("an agent who hands a task over loses the right to edit it (unless they created it)", async () => {
    expect(ok(await patch(agent, assignedToAgent.id, { assigneeUserId: agent2.id })).assignee?.id).toBe(agent2.id);
    expect(status(await patch(agent, assignedToAgent.id, { title: "still mine?" }))).toBe(403);
    expect(ok(await patch(agent2, assignedToAgent.id, { status: "done" })).status).toBe("done");
  });
  it("owner and admin edit any task", async () => {
    expect(ok(await patch(owner, mine.id, { title: "renamed by owner" })).title).toBe("renamed by owner");
    expect(ok(await patch(admin, mine.id, { priority: "low" })).priority).toBe("low");
  });
});

describe("history: exactly one entry per change", () => {
  it("records each kind of change once, with actor, and nothing for a no-op", async () => {
    const t = await create(agent, { title: "Track me", dueAt: "2026-06-01T10:00:00Z", assigneeUserId: null });
    let v = t.version;
    const step = async (u: TestUser, body: Record<string, unknown>) => { const r = ok(await patch(u, t.id, { ...body, expectedVersion: v })); v = r.version; return r; };
    await step(agent, { title: "Track me better", description: "now with notes" });
    await step(agent, { dueAt: "2026-06-02T10:00:00Z" });
    await step(agent, { priority: "high" });
    await step(admin, { assigneeUserId: agent2.id });
    await step(agent2, { status: "in_progress" });
    await step(agent2, { status: "done" });
    await step(admin, { status: "open" });
    await step(admin, { status: "cancelled" });
    await step(admin, { status: "open" });
    await step(admin, { priority: "high", title: "Track me better" }); // already so
    expect(await kinds(t.id)).toEqual(["created", "updated", "due_date_changed", "priority_changed", "assignee_changed", "status_changed", "completed", "reopened", "status_changed", "reopened"]);
    const ev = await events(owner, t.id);
    expect(ev.find((e) => e.kind === "completed")).toMatchObject({ actor: { id: agent2.id }, data: { from: "in_progress", to: "done" } });
    expect(ev.find((e) => e.kind === "assignee_changed")?.data).toMatchObject({ from: null, to: { id: agent2.id } });
    expect(ev.find((e) => e.kind === "updated")?.data).toMatchObject({ fields: ["title", "description"] });
    expect(v).toBe(11 - 1); // 9 effective edits after version 1; the no-op did not bump
  });
  it("one request changing three things writes three entries", async () => {
    const t = await create(agent, { title: "Multi" });
    ok(await patch(agent, t.id, { priority: "urgent", dueAt: "2026-07-01T00:00:00Z", status: "done" }));
    expect((await kinds(t.id)).sort()).toEqual(["completed", "created", "due_date_changed", "priority_changed"]);
  });
  it("completion sets completedAt; reopening and cancelling clear it", async () => {
    const t = await create(agent, { title: "Close me" });
    expect(ok(await patch(agent, t.id, { status: "done" })).completedAt).toBeTruthy();
    expect(ok(await patch(agent, t.id, { status: "open" })).completedAt).toBeNull();
    ok(await patch(agent, t.id, { status: "done" }));
    expect(ok(await patch(agent, t.id, { status: "cancelled" })).completedAt).toBeNull();
  });
  it("history is paged newest first", async () => {
    const t = await create(agent, { title: "Paged" });
    for (const pr of ["low", "high", "urgent", "normal"]) ok(await patch(agent, t.id, { priority: pr }));
    const first = ok(await as(owner).call(endpoints.listTaskEvents, { params: { workspaceId: A, taskId: t.id }, query: { limit: 2 } }));
    expect(first.items.map((e) => e.kind)).toEqual(["priority_changed", "priority_changed"]);
    const rest = ok(await as(owner).call(endpoints.listTaskEvents, { params: { workspaceId: A, taskId: t.id }, query: { limit: 10, cursor: first.nextCursor! } }));
    expect(rest.items).toHaveLength(3);
    expect(rest.nextCursor).toBeNull();
    expect(rest.items.at(-1)?.kind).toBe("created");
  });
  it("deleting is a soft delete that keeps and extends the history", async () => {
    const t = await create(agent, { title: "Remove me", contactId: alice.id });
    expect((await as(agent).call(endpoints.deleteTask, { params: { workspaceId: A, taskId: t.id } })).ok).toBe(true);
    expect(status(await as(agent).call(endpoints.getTask, { params: { workspaceId: A, taskId: t.id } }))).toBe(404);
    expect((await list(owner, { search: "Remove me" })).items).toHaveLength(0);
    expect(await kinds(t.id)).toEqual(["created", "deleted"]);
    expect(status(await patch(agent, t.id, { title: "zombie" }))).toBe(404);
  });
});

describe("optimistic concurrency", () => {
  it("a stale expectedVersion returns 409 with the current task and changes nothing", async () => {
    const t = await create(owner, { title: "Contested" });
    const v2 = ok(await patch(owner, t.id, { title: "Contested 2", expectedVersion: 1 }));
    expect(v2.version).toBe(2);
    const stale = failure(await patch(admin, t.id, { title: "Mine", expectedVersion: 1 }));
    expect(stale).toMatchObject({ status: 409, code: "version_conflict" });
    expect((stale.details as { current: Task }).current).toMatchObject({ title: "Contested 2", version: 2 });
    expect(ok(await as(owner).call(endpoints.getTask, { params: { workspaceId: A, taskId: t.id } })).title).toBe("Contested 2");
    expect(await kinds(t.id)).toEqual(["created", "updated"]);
  });
  it("two concurrent edits with the same version: one wins, one conflicts, history has one entry", async () => {
    const t = await create(owner, { title: "Race" });
    const rs = await Promise.all([patch(owner, t.id, { priority: "high", expectedVersion: 1 }), patch(admin, t.id, { priority: "low", expectedVersion: 1 })]);
    expect(rs.filter((r) => r.ok)).toHaveLength(1);
    expect(rs.filter((r) => !r.ok).map((r) => status(r))).toEqual([409]);
    expect((await kinds(t.id)).filter((k) => k === "priority_changed")).toHaveLength(1);
  });
  it("older clients that omit expectedVersion still work", async () => {
    const t = await create(owner, { title: "Legacy" });
    expect(ok(await patch(owner, t.id, { status: "done" })).version).toBe(2);
  });
  it("an empty update is rejected", async () => {
    const t = await create(owner, { title: "Empty" });
    expect((await raw(owner, "PATCH", `/tasks/${t.id}`, { expectedVersion: 1 })).status).toBe(400);
  });
});

describe("filters, sorting and keyset pagination", () => {
  let ws: string;
  let seeded: Task[];
  const mk = (title: string, o: Record<string, unknown> = {}) => as(owner).call(endpoints.createWorkspaceTask, { params: p(ws), body: { title, ...o } as never }).then(ok);
  beforeAll(async () => {
    ws = await h.workspace(owner, "Tasks filters", { admin, agent, viewer });
    const c = await h.contact(as(owner), ws, { name: "Filter Contact" });
    seeded = [];
    const base = Date.UTC(2026, 4, 1, 12, 0, 0);
    const prios = ["low", "normal", "high", "urgent"] as const;
    for (let i = 0; i < 14; i++) {
      // Pairs share a due date so ties exist; every third has none; priorities cycle.
      const due = i % 3 === 2 ? undefined : new Date(base + Math.floor(i / 2) * 86_400_000).toISOString();
      seeded.push(await mk(`Task ${String(i).padStart(2, "0")} ${i % 2 ? "alpha" : "beta"}`, { dueAt: due, priority: prios[i % 4], assigneeUserId: i % 4 === 0 ? null : i % 4 === 1 ? owner.id : agent.id, contactId: i < 4 ? c.id : undefined, description: i === 5 ? "mentions 100% of the budget" : undefined }));
    }
    ok(await patch(owner, seeded[1]!.id, { status: "done" }, ws));
    ok(await patch(owner, seeded[3]!.id, { status: "cancelled" }, ws));
    ok(await patch(owner, seeded[4]!.id, { status: "in_progress" }, ws));
  });
  const L = (q: TaskListQuery) => list(owner, q, ws);
  const ids = (xs: Task[]) => xs.map((x) => x.id);

  it("filters by assignee (me, unassigned, a member), status, priority, contact, search, due range", async () => {
    expect(ids((await L({ assignee: "unassigned", limit: 100 })).items).sort()).toEqual(seeded.filter((t) => !t.assignee).map((t) => t.id).sort());
    expect((await L({ assignee: "me", limit: 100 })).items.every((t) => t.assignee?.id === owner.id)).toBe(true);
    expect((await L({ assignee: agent.id, limit: 100 })).total).toBe(seeded.filter((_t, i) => i % 4 >= 2).length);
    expect((await L({ status: "done" as never })).items.map((t) => t.id)).toEqual([seeded[1]!.id]);
    expect((await L({ status: "open,in_progress" as never, limit: 100 })).total).toBe(14 - 2);
    expect((await L({ priority: "urgent,high" as never, limit: 100 })).items.every((t) => ["urgent", "high"].includes(t.priority))).toBe(true);
    expect((await L({ contactId: seeded[0]!.contactId!, limit: 100 })).total).toBe(4);
    expect((await L({ search: "ALPHA", limit: 100 })).total).toBe(7);
    expect((await L({ search: "100%" })).items.map((t) => t.id)).toEqual([seeded[5]!.id]); // % is literal, not a wildcard
    expect((await L({ search: "%" })).total).toBe(1);
    const from = new Date(Date.UTC(2026, 4, 2, 0, 0, 0)).toISOString();
    const to = new Date(Date.UTC(2026, 4, 3, 23, 59, 59)).toISOString();
    expect((await L({ dueFrom: from, dueTo: to, limit: 100 })).items.every((t) => t.dueAt! >= from && t.dueAt! <= to)).toBe(true);
  });
  it("rejects bad filters", async () => {
    for (const q of ["status=bogus", "priority=x", "view=later", "sort=name", "limit=101", "contactId=x", "dueFrom=yesterday"]) expect((await h.app.request(`/v1/workspaces/${ws}/tasks?${q}`, { headers: { cookie: owner.cookie } })).status, q).toBe(400);
    expect(failure(await as(owner).call(endpoints.listTasks, { params: p(ws), query: { tz: "Mars/Base" } })).code).toBe("invalid_query");
  });

  const rank = { low: 0, normal: 1, high: 2, urgent: 3 } as const;
  const expected = (sort: string, dir: "asc" | "desc") => {
    const s = [...seeded].filter(() => true);
    const key = (t: Task) => (sort === "due" ? (t.dueAt === null ? null : Date.parse(t.dueAt)) : sort === "priority" ? rank[t.priority] : sort === "created" ? Date.parse(t.createdAt) : Date.parse(t.updatedAt));
    const sign = dir === "asc" ? 1 : -1;
    return s.sort((a, b) => {
      const ka = key(a), kb = key(b);
      if (ka !== kb) {
        if (ka === null) return 1; // no date is always last
        if (kb === null) return -1;
        return (ka - kb) * sign;
      }
      return a.id < b.id ? -sign : a.id > b.id ? sign : 0;
    });
  };
  it.each(["due", "priority", "created", "updated"] as const)("pages through every task exactly once in %s order, ascending and descending, with ties", async (sort) => {
    for (const dir of ["asc", "desc"] as const) {
      const seen: Task[] = [];
      let cursor: string | undefined;
      for (let i = 0; i < 10; i++) {
        const page = await L({ sort, dir, limit: 4, cursor });
        expect(page.total).toBe(14);
        seen.push(...page.items);
        if (!page.nextCursor) break;
        cursor = page.nextCursor;
      }
      expect(seen).toHaveLength(14);
      expect(new Set(ids(seen)).size).toBe(14);
      if (sort !== "updated") expect(ids(seen)).toEqual(ids(expected(sort, dir)));
      else expect(seen.map((t) => t.updatedAt)).toEqual([...seen.map((t) => t.updatedAt)].sort((a, b) => (dir === "asc" ? (a < b ? -1 : a > b ? 1 : 0) : a < b ? 1 : a > b ? -1 : 0)));
    }
  });
  it("defaults to due date ascending with undated tasks last, and rejects a cursor from another query", async () => {
    const all = (await L({ limit: 100 })).items;
    const dated = all.filter((t) => t.dueAt);
    expect(all.slice(0, dated.length)).toEqual(dated);
    const page = await L({ limit: 2 });
    expect(failure(await as(owner).call(endpoints.listTasks, { params: p(ws), query: { limit: 2, sort: "created", cursor: page.nextCursor! } })).code).toBe("invalid_query");
    expect(failure(await as(owner).call(endpoints.listTasks, { params: p(ws), query: { cursor: "garbage" } })).code).toBe("invalid_query");
  });
  it("paging stays correct when a task changes between pages (keyset, not offset)", async () => {
    const first = await L({ sort: "created", dir: "asc", limit: 5 });
    ok(await patch(owner, seeded[0]!.id, { title: "changed meanwhile" }, ws));
    const second = await L({ sort: "created", dir: "asc", limit: 100, cursor: first.nextCursor! });
    expect(ids([...first.items, ...second.items])).toEqual(ids(seeded));
  });
});

describe("views, boundaries and time zones (asOf makes 'now' explicit)", () => {
  let ws: string;
  const NOW = "2026-03-15T12:00:00.000Z";
  const mk = async (title: string, dueAt: string | null, st?: string) => { const t = ok(await as(owner).call(endpoints.createWorkspaceTask, { params: p(ws), body: { title, dueAt } })); if (st) ok(await patch(owner, t.id, { status: st }, ws)); return t; };
  const view = async (v: string, tz?: string) => (ok(await as(owner).call(endpoints.listTasks, { params: p(ws), query: { view: v as never, asOf: NOW, tz, limit: 100, sort: "due" } })).items.map((t) => t.title));
  beforeAll(async () => {
    ws = await h.workspace(owner, "Tasks views");
    await mk("just overdue", "2026-03-15T11:59:59Z");
    await mk("exactly now", "2026-03-15T12:00:00Z");
    await mk("later today", "2026-03-15T23:59:59Z");
    await mk("day start", "2026-03-15T00:00:00Z");
    await mk("yesterday end", "2026-03-14T23:59:59Z");
    await mk("tomorrow start", "2026-03-16T00:00:00Z");
    await mk("nz edge in", "2026-03-15T11:00:00Z");
    await mk("nz edge out", "2026-03-16T11:00:00Z");
    await mk("dst edge in", "2026-03-09T03:59:59Z");
    await mk("dst edge out", "2026-03-09T04:00:00Z");
    await mk("no date", null);
    await mk("progress overdue", "2026-03-01T00:00:00Z", "in_progress");
    await mk("done overdue", "2026-03-01T00:00:00Z", "done");
    await mk("cancelled overdue", "2026-03-01T00:00:00Z", "cancelled");
    await mk("done no date", null, "done");
  });
  it("overdue is strictly before now, active tasks only; a task due exactly now is upcoming", async () => {
    const o = await view("overdue");
    expect(o).toContain("just overdue");
    expect(o).toContain("progress overdue");
    expect(o).not.toContain("exactly now");
    expect(o).not.toContain("done overdue");
    expect(o).not.toContain("cancelled overdue");
    expect(o).not.toContain("no date");
    const u = await view("upcoming");
    expect(u).toContain("exactly now");
    expect(u).toContain("later today");
    expect(u).not.toContain("just overdue");
    expect(u).not.toContain("no date");
  });
  it("today (UTC): from 00:00:00 inclusive to 24:00:00 exclusive", async () => {
    const t = await view("today", "UTC");
    expect(t).toEqual(expect.arrayContaining(["day start", "just overdue", "exactly now", "later today"]));
    expect(t).not.toContain("yesterday end");
    expect(t).not.toContain("tomorrow start");
    expect(await view("today")).toEqual(t); // default tz is UTC
  });
  it("today in Pacific/Auckland (UTC+13 on that date) is 11:00Z to 11:00Z next day", async () => {
    const t = await view("today", "Pacific/Auckland");
    expect(t).toContain("nz edge in");
    expect(t).toContain("tomorrow start");
    expect(t).not.toContain("nz edge out");
    expect(t).not.toContain("day start");
  });
  it("today in America/New_York (EDT, UTC-4) is 04:00Z to 04:00Z next day", async () => {
    const t = await view("today", "America/New_York");
    expect(t).toEqual(expect.arrayContaining(["just overdue", "exactly now", "later today", "tomorrow start"]));
    expect(t).not.toContain("yesterday end");
    expect(t).not.toContain("day start");
  });
  it("a 23-hour DST day is handled by the calendar, not by adding 24 hours", async () => {
    const asOf = "2026-03-08T15:00:00Z"; // 11:00 EDT, the day clocks went forward
    const q = (due: string) => as(owner).call(endpoints.createWorkspaceTask, { params: p(ws), body: { title: `dst ${due}`, dueAt: due } }).then(ok);
    await q("2026-03-08T04:59:59Z");
    await q("2026-03-08T05:00:00Z");
    await q("2026-03-09T03:59:59Z");
    await q("2026-03-09T04:00:00Z");
    const r = ok(await as(owner).call(endpoints.listTasks, { params: p(ws), query: { view: "today", asOf, tz: "America/New_York", limit: 100, search: "dst 2026-03-0" } })).items.map((t) => t.title);
    expect(r.sort()).toEqual(["dst 2026-03-08T05:00:00Z", "dst 2026-03-09T03:59:59Z"].sort());
  });
  it("no_date and completed", async () => {
    expect((await view("no_date")).sort()).toEqual(["no date"]);
    expect((await view("completed")).sort()).toEqual(["done no date", "done overdue"]);
  });
  it("summary counts match the views and respect assignee and contact filters", async () => {
    const s = ok(await as(owner).call(endpoints.taskSummary, { params: p(ws), query: { asOf: NOW } }));
    expect(s.overdue).toBe((await view("overdue")).length);
    expect(s.upcoming).toBe((await view("upcoming")).length);
    expect(s.today).toBe((await view("today")).length);
    expect(s.noDate).toBe(1);
    expect(s.completed).toBe(2);
    expect(s.active).toBe(s.overdue + s.upcoming + s.noDate);
    const none = ok(await as(owner).call(endpoints.taskSummary, { params: p(ws), query: { asOf: NOW, assignee: "unassigned" } }));
    expect(none.active).toBe(0);
    const nz = ok(await as(owner).call(endpoints.taskSummary, { params: p(ws), query: { asOf: NOW, tz: "Pacific/Auckland" } }));
    expect(nz.today).toBe((await view("today", "Pacific/Auckland")).length);
  });
});

describe("contact link keeps the contact timeline and last activity consistent", () => {
  it("create, complete, reopen, cancel and delete show on the contact timeline and bump lastActivityAt", async () => {
    const c = await h.contact(as(agent), A, { name: "Timeline Tina" });
    const last = async () => ok(await as(agent).call(endpoints.getContact, { params: { workspaceId: A, contactId: c.id } })).lastActivityAt;
    const acts = async () => ok(await as(agent).call(endpoints.listActivity, { params: { workspaceId: A, contactId: c.id } })).items.map((i) => i.kind);
    let before = (await last())!;
    const t = await create(agent, { title: "Send contract", contactId: c.id });
    expect((await last())! >= before).toBe(true);
    before = (await last())!;
    await new Promise((r) => setTimeout(r, 15));
    ok(await patch(agent, t.id, { status: "in_progress" })); // no activity: not a milestone
    ok(await patch(agent, t.id, { status: "done" }));
    expect((await last())! > before).toBe(true);
    ok(await patch(agent, t.id, { status: "open" }));
    ok(await patch(agent, t.id, { status: "cancelled" }));
    ok(await patch(agent, t.id, { title: "Send contract v2" })); // edits are not timeline events
    expect(await acts()).toEqual(["task.cancelled", "task.reopened", "task.completed", "task.created", "contact.created"]);
    expect(ok(await as(agent).call(endpoints.getContact, { params: { workspaceId: A, contactId: c.id } })).openTaskCount).toBe(0);
    ok(await patch(agent, t.id, { status: "open" }));
    expect(ok(await as(agent).call(endpoints.getContact, { params: { workspaceId: A, contactId: c.id } })).openTaskCount).toBe(1);
    ok(await as(agent).call(endpoints.deleteTask, { params: { workspaceId: A, taskId: t.id } }));
    expect((await acts())[0]).toBe("task.deleted");
    expect(ok(await as(agent).call(endpoints.getContact, { params: { workspaceId: A, contactId: c.id } })).openTaskCount).toBe(0);
  });
  it("moving a task between contacts, or to none, is recorded on both contacts and in the task history", async () => {
    const c1 = await h.contact(as(agent), A, { name: "Move From" });
    const c2 = await h.contact(as(agent), A, { name: "Move To" });
    const t = await create(agent, { title: "Wander", contactId: c1.id });
    expect(ok(await patch(agent, t.id, { contactId: c2.id })).contact?.name).toBe("Move To");
    expect(ok(await patch(agent, t.id, { contactId: null })).contact).toBeNull();
    const acts = async (id: string) => ok(await as(agent).call(endpoints.listActivity, { params: { workspaceId: A, contactId: id } })).items.map((i) => i.kind);
    expect((await acts(c1.id)).slice(0, 2)).toEqual(["task.unlinked", "task.created"]);
    expect((await acts(c2.id)).slice(0, 2)).toEqual(["task.unlinked", "task.linked"]);
    expect(await kinds(t.id)).toEqual(["created", "contact_changed", "contact_changed"]);
    expect(ok(await as(agent).call(endpoints.listContactTasks, { params: { workspaceId: A, contactId: c1.id } }))).toHaveLength(0);
  });
  it("the mirrored task_links row follows the contact", async () => {
    const c = await h.contact(as(agent), A, { name: "Link Lena" });
    const t = await create(agent, { title: "Linked", contactId: c.id });
    const q = () => h.admin.query("SELECT entity_type, entity_id FROM task_links WHERE task_id = $1", [t.id]).then((r) => r.rows);
    expect(await q()).toEqual([{ entity_type: "contact", entity_id: c.id }]);
    ok(await patch(agent, t.id, { contactId: null }));
    expect(await q()).toEqual([]);
  });
});

describe("contact-scoped endpoints keep working", () => {
  it("list, create, update and delete through /contacts/:id/tasks and /tasks/:id", async () => {
    const c = await h.contact(as(agent), A, { name: "Scoped Sam" });
    const t = ok(await as(agent).call(endpoints.createTask, { params: { workspaceId: A, contactId: c.id }, body: { title: "Old style", dueAt: "2026-12-01T09:00:00Z" } }));
    expect(t).toMatchObject({ contactId: c.id, status: "open", assignee: { id: agent.id } });
    const done = ok(await patch(agent, t.id, { status: "done" }));
    expect(done.completedAt).toBeTruthy();
    const second = ok(await as(agent).call(endpoints.createTask, { params: { workspaceId: A, contactId: c.id }, body: { title: "Second", dueAt: "2026-11-01T09:00:00Z" } }));
    const listed = ok(await as(agent).call(endpoints.listContactTasks, { params: { workspaceId: A, contactId: c.id } }));
    expect(listed.map((x) => x.id)).toEqual([second.id, t.id]); // open first, closed after
    expect(ok(await as(agent).call(endpoints.createTask, { params: { workspaceId: A, contactId: c.id }, body: { title: "Mine", assigneeUserId: null } })).assignee).toBeNull();
    expect((await as(agent).call(endpoints.deleteTask, { params: { workspaceId: A, taskId: t.id } })).ok).toBe(true);
    expect(failure(await as(agent).call(endpoints.createTask, { params: { workspaceId: A, contactId: c.id }, body: { title: "x", assigneeUserId: outsider.id } })).code).toBe("invalid_assignee");
    expect(status(await as(agent).call(endpoints.createTask, { params: { workspaceId: A, contactId: bob.id }, body: { title: "x" } }))).toBe(404);
    // Tasks made on the contact page appear in the workspace list, and the other way round.
    expect((await list(owner, { contactId: c.id })).total).toBe(2);
  });
  it("the shared client works with bearer authentication and no cookies (mobile path)", async () => {
    const mobile = h.clientFor(agent, "bearer");
    const t = ok(await mobile.call(endpoints.createWorkspaceTask, { params: p(), body: { title: "From phone", priority: "high" } }));
    expect(ok(await mobile.call(endpoints.updateTask, { params: { workspaceId: A, taskId: t.id }, body: { status: "done", expectedVersion: 1 } })).status).toBe("done");
    expect(ok(await mobile.call(endpoints.listTasks, { params: p(), query: { view: "completed", search: "From phone" } })).items[0]?.id).toBe(t.id);
    expect(ok(await mobile.call(endpoints.taskSummary, { params: p() })).completed).toBeGreaterThan(0);
    expect((await events(agent, t.id)).map((e) => e.kind)).toEqual(["completed", "created"]);
    expect(ok(await mobile.call(endpoints.getTask, { params: { workspaceId: A, taskId: t.id } })).id).toBe(t.id);
  });
  it("without credentials every task endpoint is 401", async () => {
    const r = await h.app.request(`/v1/workspaces/${A}/tasks`);
    expect(r.status).toBe(401);
  });
});
