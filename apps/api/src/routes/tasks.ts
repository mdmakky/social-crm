import { emitEvent } from "../events.ts";
import { Hono } from "hono";
import { and, asc, desc, eq, isNull, lt, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { CreateTaskBody, CreateWorkspaceTaskBody, TaskEventsQuery, TaskListQuery, TaskSummaryQuery, UpdateTaskBody } from "@crm/contracts";
import { escapeLike } from "@crm/core";
import { can } from "@crm/core/permissions";
import { schema, user, withContext, type Db, type Tx } from "@crm/db";
import { activeMember, loadContact, recordActivity } from "../crm-service.ts";
import { body, fail, forbidden, isUuid, query, wctx, type SC, type ScopedEnv } from "./scope.ts";

type TaskRow = typeof schema.tasks.$inferSelect;
const ACTIVE = sql`tasks.status IN ('open', 'in_progress')`;
const asg = alias(user, "asg");
const cr = alias(user, "cr");

/** shortcut: cursor is an opaque base64 JSON blob, not signed; it only carries keys the caller could already filter on. */
const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
const dec = (s: string): { k: string; id: string; sort: string; dir: string } | null => {
  try {
    const o = JSON.parse(Buffer.from(s, "base64url").toString("utf8"));
    return typeof o?.k === "string" && isUuid(o?.id) ? o : null;
  } catch {
    return null;
  }
};
const validTz = (tz: string) => {
  try {
    new Intl.DateTimeFormat("en", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
};

type Joined = { t: TaskRow; asg: string | null; cr: string | null; cn: string | null; k: string };
const taskDto = (r: Joined) => ({
  id: r.t.id,
  contactId: r.t.contactId,
  title: r.t.title,
  description: r.t.description,
  dueAt: r.t.dueAt?.toISOString() ?? null,
  remindAt: r.t.remindAt?.toISOString() ?? null,
  status: r.t.status,
  priority: r.t.priority,
  assignee: r.t.assigneeUserId ? { id: r.t.assigneeUserId, name: r.asg ?? "" } : null,
  contact: r.t.contactId ? { id: r.t.contactId, name: r.cn ?? "" } : null,
  createdBy: { id: r.t.createdBy, name: r.cr ?? "" },
  completedAt: r.t.completedAt?.toISOString() ?? null,
  createdAt: r.t.createdAt.toISOString(),
  updatedAt: r.t.updatedAt.toISOString(),
  version: r.t.version,
});

/** Task joined to assignee, creator and contact names. `k` is the keyset sort key as text (only meaningful in list). */
const joined = (tx: Tx, k: SQL) =>
  tx
    .select({ t: schema.tasks, asg: asg.name, cr: cr.name, cn: schema.contacts.name, k: sql<string>`${k}` })
    .from(schema.tasks)
    .leftJoin(asg, eq(asg.id, schema.tasks.assigneeUserId))
    .leftJoin(cr, eq(cr.id, schema.tasks.createdBy))
    .leftJoin(schema.contacts, and(eq(schema.contacts.workspaceId, schema.tasks.workspaceId), eq(schema.contacts.id, schema.tasks.contactId)));

const loadLead = async (tx: Tx, workspaceId: string, id: string) => (await tx.select({ id: schema.leads.id }).from(schema.leads).where(and(eq(schema.leads.workspaceId, workspaceId), eq(schema.leads.id, id), isNull(schema.leads.deletedAt))))[0] ?? null;
// leads.next_activity_at is kept in step by DB triggers on task_links and tasks (migration 0016).
const linkLead = (tx: Tx, workspaceId: string, taskId: string, leadId: string) => tx.execute(sql`INSERT INTO task_links (workspace_id, task_id, entity_type, entity_id) VALUES (${workspaceId}, ${taskId}, 'lead', ${leadId}) ON CONFLICT DO NOTHING`);

async function loadJoined(tx: Tx, workspaceId: string, id: string): Promise<Joined | null> {
  const [r] = await joined(tx, sql`''`).where(and(eq(schema.tasks.workspaceId, workspaceId), eq(schema.tasks.id, id), isNull(schema.tasks.deletedAt)));
  return r ?? null;
}

type Filters = { where: SQL[]; error?: string };
type FilterQ = { view?: string; status?: string[]; priority?: string[]; assignee?: string; contactId?: string; dueFrom?: string; dueTo?: string; search?: string; tz?: string; asOf?: string };

/** Builds WHERE clauses on alias `t`. "Now" is asOf or the server clock; "today" is the calendar day containing now in `tz` (UTC by default). */
function filters(workspaceId: string, userId: string, q: FilterQ): Filters {
  const tz = q.tz ?? "UTC";
  if (!validTz(tz)) return { where: [], error: "Unknown time zone" };
  const now = (q.asOf ? new Date(q.asOf) : new Date()).toISOString();
  const where: SQL[] = [sql`tasks.workspace_id = ${workspaceId}`, sql`tasks.deleted_at IS NULL`];
  if (q.assignee === "me") where.push(sql`tasks.assignee_user_id = ${userId}`);
  else if (q.assignee === "unassigned") where.push(sql`tasks.assignee_user_id IS NULL`);
  else if (q.assignee) where.push(sql`tasks.assignee_user_id = ${q.assignee}`);
  if (q.status?.length) where.push(sql`tasks.status::text IN (${sql.join(q.status.map((x) => sql`${x}`), sql`, `)})`);
  if (q.priority?.length) where.push(sql`tasks.priority::text IN (${sql.join(q.priority.map((x) => sql`${x}`), sql`, `)})`);
  if (q.contactId) where.push(sql`tasks.contact_id = ${q.contactId}::uuid`);
  if (q.dueFrom) where.push(sql`tasks.due_at >= ${q.dueFrom}::timestamptz`);
  if (q.dueTo) where.push(sql`tasks.due_at <= ${q.dueTo}::timestamptz`);
  const search = q.search?.trim().toLowerCase();
  if (search) {
    const like = `%${escapeLike(search)}%`;
    where.push(sql`(lower(tasks.title) LIKE ${like} ESCAPE '\\' OR lower(coalesce(tasks.description, '')) LIKE ${like} ESCAPE '\\')`);
  }
  const dayStart = sql`((date_trunc('day', ${now}::timestamptz AT TIME ZONE ${tz})) AT TIME ZONE ${tz})`;
  const dayEnd = sql`((date_trunc('day', ${now}::timestamptz AT TIME ZONE ${tz}) + interval '1 day') AT TIME ZONE ${tz})`;
  switch (q.view) {
    case "overdue": where.push(ACTIVE, sql`tasks.due_at < ${now}::timestamptz`); break;
    case "upcoming": where.push(ACTIVE, sql`tasks.due_at >= ${now}::timestamptz`); break;
    case "today": where.push(ACTIVE, sql`tasks.due_at >= ${dayStart} AND tasks.due_at < ${dayEnd}`); break;
    case "no_date": where.push(ACTIVE, sql`tasks.due_at IS NULL`); break;
    case "completed": where.push(sql`tasks.status = 'done'`); break;
  }
  return { where };
}

const SORTS = { due: "due_at", priority: "priority", created: "created_at", updated: "updated_at" } as const;

export function taskRoutes(db: Db) {
  const r = new Hono<ScopedEnv>();
  const mayEdit = (c: SC, t: Pick<TaskRow, "assigneeUserId" | "createdBy">) => can(c.get("role"), "task.edit", { isOwn: t.assigneeUserId === c.get("userId") || t.createdBy === c.get("userId") });
  const person = async (tx: Tx, id: string | null) => (id ? { id, name: (await tx.select({ name: user.name }).from(user).where(eq(user.id, id)))[0]?.name ?? "" } : null);
  const addEvent = (tx: Tx, workspaceId: string, taskId: string, actorUserId: string, kind: (typeof schema.TASK_EVENT_KINDS)[number], data: Record<string, unknown>) =>
    tx.insert(schema.taskEvents).values({ workspaceId, taskId, kind, actorUserId, data });

  // ----- workspace list, summary -----
  r.get("/tasks", async (c) => {
    const q = query(c, TaskListQuery);
    if (!q.ok) return q.res;
    const { workspaceId, userId } = wctx(c);
    const f = filters(workspaceId, userId, q.data);
    if (f.error) return fail(c, 400, "invalid_query", f.error);
    const sort = q.data.sort ?? "due";
    const dir = q.data.dir ?? "asc";
    const limit = q.data.limit ?? 25;
    // Due date sorts nulls last in both directions: a no-date task has no place in a date ordering.
    const col = sort === "due" ? `coalesce(tasks.due_at, '${dir === "asc" ? "infinity" : "-infinity"}'::timestamptz)` : `tasks.${SORTS[sort]}`;
    const keyExpr = sql.raw(col);
    const castTo = sort === "priority" ? "task_priority" : "timestamptz";
    const where = [...f.where];
    if (q.data.cursor) {
      const cur = dec(q.data.cursor);
      if (!cur || cur.sort !== sort || cur.dir !== dir) return fail(c, 400, "invalid_query", "The cursor does not match this query");
      where.push(sql`(${keyExpr}, tasks.id) ${sql.raw(dir === "desc" ? "<" : ">")} (${cur.k}::${sql.raw(castTo)}, ${cur.id}::uuid)`);
    }
    return withContext(db, wctx(c), async (tx) => {
      const rows = await joined(tx, sql`(${keyExpr})::text`)
        .where(sql.join(where, sql` AND `))
        .orderBy(sql`${keyExpr} ${sql.raw(dir)}`, sql`tasks.id ${sql.raw(dir)}`)
        .limit(limit + 1);
      const total = ((await tx.execute(sql`SELECT count(*)::int AS n FROM tasks WHERE ${sql.join(f.where, sql` AND `)}`)).rows[0] as { n: number }).n;
      const page = rows.slice(0, limit);
      const last = page[page.length - 1];
      return c.json({ items: page.map(taskDto), total, nextCursor: rows.length > limit && last ? enc({ k: last.k, id: last.t.id, sort, dir }) : null });
    });
  });

  r.get("/tasks/summary", async (c) => {
    const q = query(c, TaskSummaryQuery);
    if (!q.ok) return q.res;
    const { workspaceId, userId } = wctx(c);
    const f = filters(workspaceId, userId, q.data);
    if (f.error) return fail(c, 400, "invalid_query", f.error);
    const part = (view: string) => sql.join(filters(workspaceId, userId, { ...q.data, view }).where.slice(f.where.length), sql` AND `);
    return withContext(db, wctx(c), async (tx) => {
      const res = await tx.execute(sql`SELECT
        count(*) FILTER (WHERE ${part("overdue")})::int AS overdue, count(*) FILTER (WHERE ${part("today")})::int AS today,
        count(*) FILTER (WHERE ${part("upcoming")})::int AS upcoming, count(*) FILTER (WHERE ${part("no_date")})::int AS "noDate",
        count(*) FILTER (WHERE ${part("completed")})::int AS completed, count(*) FILTER (WHERE ${ACTIVE})::int AS active
        FROM tasks WHERE ${sql.join(f.where, sql` AND `)}`);
      return c.json(res.rows[0]);
    });
  });

  // ----- single task and history -----
  r.get("/tasks/:taskId", async (c) => {
    const id = c.req.param("taskId");
    if (!isUuid(id)) return fail(c, 404, "not_found");
    const { workspaceId } = wctx(c);
    return withContext(db, wctx(c), async (tx) => {
      const t = await loadJoined(tx, workspaceId, id);
      return t ? c.json(taskDto(t)) : fail(c, 404, "not_found");
    });
  });

  r.get("/tasks/:taskId/events", async (c) => {
    const id = c.req.param("taskId");
    if (!isUuid(id)) return fail(c, 404, "not_found");
    const q = query(c, TaskEventsQuery);
    if (!q.ok) return q.res;
    const { workspaceId } = wctx(c);
    const limit = q.data.limit ?? 50;
    return withContext(db, wctx(c), async (tx) => {
      const [t] = await tx.select({ id: schema.tasks.id }).from(schema.tasks).where(and(eq(schema.tasks.workspaceId, workspaceId), eq(schema.tasks.id, id)));
      if (!t) return fail(c, 404, "not_found");
      const e = schema.taskEvents;
      const rows = await tx.select({ e, name: user.name }).from(e).leftJoin(user, eq(user.id, e.actorUserId)).where(and(eq(e.workspaceId, workspaceId), eq(e.taskId, id), q.data.cursor ? lt(e.id, q.data.cursor) : undefined)).orderBy(desc(e.id)).limit(limit + 1);
      const page = rows.slice(0, limit);
      return c.json({
        items: page.map((x) => ({ id: x.e.id, kind: x.e.kind, actor: x.e.actorUserId ? { id: x.e.actorUserId, name: x.name ?? "" } : null, data: x.e.data as Record<string, unknown>, occurredAt: x.e.occurredAt.toISOString() })),
        nextCursor: rows.length > limit ? page[page.length - 1]!.e.id : null,
      });
    });
  });

  // ----- create -----
  async function create(c: SC, input: { title: string; description?: string | null; dueAt?: string | null; remindAt?: string | null; assigneeUserId?: string | null; priority?: "low" | "normal" | "high" | "urgent"; contactId?: string | null }, scopedContact: boolean, leadId?: string) {
    const { workspaceId, userId } = wctx(c);
    return withContext(db, wctx(c), async (tx) => {
      if (leadId && !(await loadLead(tx, workspaceId, leadId))) return fail(c, 404, "not_found");
      if (input.contactId && !(await loadContact(tx, workspaceId, input.contactId))) return scopedContact ? fail(c, 404, "not_found") : fail(c, 400, "invalid_contact", "That contact could not be found.");
      const assignee = input.assigneeUserId === undefined ? userId : input.assigneeUserId;
      if (assignee && !(await activeMember(tx, workspaceId, assignee))) return fail(c, 400, "invalid_assignee", "The assignee must be a member of this workspace.");
      const [t] = await tx.insert(schema.tasks).values({ workspaceId, contactId: input.contactId ?? null, title: input.title, description: input.description ?? null, dueAt: input.dueAt ? new Date(input.dueAt) : null, remindAt: input.dueAt && input.remindAt ? new Date(input.remindAt) : null, assigneeUserId: assignee, priority: input.priority ?? "normal", createdBy: userId }).returning();
      if (assignee) await emitEvent(tx, { workspaceId, type: "task.assigned", entityType: "task", entityId: t!.id, actorUserId: userId, payload: { assigneeUserId: assignee, title: t!.title, contactId: t!.contactId ?? null } });
      await addEvent(tx, workspaceId, t!.id, userId, "created", { title: t!.title, priority: t!.priority, dueAt: t!.dueAt?.toISOString() ?? null, assignee: await person(tx, assignee), contact: input.contactId ?? null });
      if (leadId) await linkLead(tx, workspaceId, t!.id, leadId);
      if (input.contactId) await recordActivity(tx, { workspaceId, contactId: input.contactId, kind: "task.created", actorUserId: userId, data: { taskId: t!.id, title: t!.title } });
      return c.json(taskDto((await loadJoined(tx, workspaceId, t!.id))!), 201);
    });
  }

  r.post("/tasks", async (c) => {
    if (!can(c.get("role"), "task.edit", { isOwn: true })) return forbidden(c);
    const b = await body(c, CreateWorkspaceTaskBody);
    return b.ok ? create(c, b.data, false) : b.res;
  });

  r.get("/contacts/:contactId/tasks", async (c) => {
    const id = c.req.param("contactId");
    if (!isUuid(id)) return fail(c, 404, "not_found");
    const { workspaceId } = wctx(c);
    return withContext(db, wctx(c), async (tx) => {
      if (!(await loadContact(tx, workspaceId, id))) return fail(c, 404, "not_found");
      const rows = await joined(tx, sql`''`)
        .where(and(eq(schema.tasks.workspaceId, workspaceId), eq(schema.tasks.contactId, id), isNull(schema.tasks.deletedAt)))
        .orderBy(sql`CASE WHEN ${schema.tasks.status} IN ('open', 'in_progress') THEN 0 ELSE 1 END`, sql`${schema.tasks.dueAt} ASC NULLS LAST`, asc(schema.tasks.id));
      return c.json(rows.map(taskDto));
    });
  });

  r.post("/contacts/:contactId/tasks", async (c) => {
    if (!can(c.get("role"), "contact.edit", {})) return forbidden(c);
    const id = c.req.param("contactId");
    if (!isUuid(id)) return fail(c, 404, "not_found");
    const b = await body(c, CreateTaskBody);
    return b.ok ? create(c, { ...b.data, contactId: id }, true) : b.res;
  });

  // ----- lead links -----
  r.get("/leads/:leadId/tasks", async (c) => {
    const id = c.req.param("leadId");
    if (!isUuid(id)) return fail(c, 404, "not_found");
    const { workspaceId } = wctx(c);
    return withContext(db, wctx(c), async (tx) => {
      if (!(await loadLead(tx, workspaceId, id))) return fail(c, 404, "not_found");
      const rows = await joined(tx, sql`''`)
        .where(and(eq(schema.tasks.workspaceId, workspaceId), isNull(schema.tasks.deletedAt), sql`EXISTS (SELECT 1 FROM task_links tl WHERE tl.workspace_id = tasks.workspace_id AND tl.task_id = tasks.id AND tl.entity_type = 'lead' AND tl.entity_id = ${id})`))
        .orderBy(sql`CASE WHEN ${schema.tasks.status} IN ('open', 'in_progress') THEN 0 ELSE 1 END`, sql`${schema.tasks.dueAt} ASC NULLS LAST`, asc(schema.tasks.id));
      return c.json(rows.map(taskDto));
    });
  });

  r.post("/leads/:leadId/tasks", async (c) => {
    if (!can(c.get("role"), "lead.edit", {}) || !can(c.get("role"), "task.edit", { isOwn: true })) return forbidden(c);
    const id = c.req.param("leadId");
    if (!isUuid(id)) return fail(c, 404, "not_found");
    const b = await body(c, CreateWorkspaceTaskBody);
    return b.ok ? create(c, b.data, false, id) : b.res;
  });

  // Link/unlink needs lead.edit and edit rights on the task itself (agents: only tasks they own or created).
  const leadLink = (link: boolean) => async (c: SC) => {
    if (!can(c.get("role"), "lead.edit", {})) return forbidden(c);
    const leadId = c.req.param("leadId") ?? "";
    const taskId = c.req.param("taskId") ?? "";
    if (!isUuid(leadId) || !isUuid(taskId)) return fail(c, 404, "not_found");
    const { workspaceId } = wctx(c);
    return withContext(db, wctx(c), async (tx) => {
      const cur = await loadJoined(tx, workspaceId, taskId);
      if (!cur || !(await loadLead(tx, workspaceId, leadId))) return fail(c, 404, "not_found");
      if (!mayEdit(c, cur.t)) return forbidden(c);
      if (link) await linkLead(tx, workspaceId, taskId, leadId);
      else await tx.execute(sql`DELETE FROM task_links WHERE workspace_id = ${workspaceId} AND task_id = ${taskId} AND entity_type = 'lead' AND entity_id = ${leadId}`);
      return c.body(null, 204);
    });
  };
  r.put("/leads/:leadId/tasks/:taskId", leadLink(true));
  r.delete("/leads/:leadId/tasks/:taskId", leadLink(false));

  // ----- update, delete -----
  const dayEq = (a: Date | null, b: Date | null) => (a?.getTime() ?? null) === (b?.getTime() ?? null);

  r.patch("/tasks/:taskId", async (c) => {
    const taskId = c.req.param("taskId");
    if (!isUuid(taskId)) return fail(c, 404, "not_found");
    const b = await body(c, UpdateTaskBody);
    if (!b.ok) return b.res;
    const d = b.data;
    const { workspaceId, userId } = wctx(c);
    return withContext(db, wctx(c), async (tx) => {
      const cur = await loadJoined(tx, workspaceId, taskId);
      // A task linked to a deleted contact is read-only history (integrity review M1).
      if (!cur || (cur.t.contactId && !(await loadContact(tx, workspaceId, cur.t.contactId)))) return fail(c, 404, "not_found");
      const t = cur.t;
      if (!mayEdit(c, t)) return forbidden(c);
      if (d.expectedVersion !== undefined && d.expectedVersion !== t.version) return fail(c, 409, "version_conflict", "This task was changed by someone else. Review the latest version and try again.", { current: taskDto(cur) });
      if (d.assigneeUserId && !(await activeMember(tx, workspaceId, d.assigneeUserId))) return fail(c, 400, "invalid_assignee", "The assignee must be a member of this workspace.");
      if (d.contactId && d.contactId !== t.contactId && !(await loadContact(tx, workspaceId, d.contactId))) return fail(c, 400, "invalid_contact", "That contact could not be found.");

      const patch: Partial<typeof schema.tasks.$inferInsert> = {};
      const events: [(typeof schema.TASK_EVENT_KINDS)[number], Record<string, unknown>][] = [];
      const fields: string[] = [];
      const edits: Record<string, unknown> = {};
      if (d.title !== undefined && d.title !== t.title) { patch.title = d.title; fields.push("title"); edits.title = { from: t.title, to: d.title }; }
      if (d.description !== undefined && (d.description ?? null) !== t.description) { patch.description = d.description ?? null; fields.push("description"); }
      if (fields.length) events.push(["updated", { fields, ...edits }]);
      if (d.dueAt !== undefined) {
        const next = d.dueAt ? new Date(d.dueAt) : null;
        if (!dayEq(next, t.dueAt)) { patch.dueAt = next; events.push(["due_date_changed", { from: t.dueAt?.toISOString() ?? null, to: next?.toISOString() ?? null }]); }
      }
      // A reminder only makes sense with a due time; changing it re-arms it (reminded_at cleared). Clearing the due date clears the reminder.
      if (d.remindAt !== undefined || (d.dueAt === null && t.remindAt)) {
        const dueAfter = patch.dueAt !== undefined ? patch.dueAt : t.dueAt;
        const nextRemind = d.remindAt && dueAfter ? new Date(d.remindAt) : d.remindAt === undefined && dueAfter ? t.remindAt : null;
        if ((nextRemind?.getTime() ?? null) !== (t.remindAt?.getTime() ?? null)) { patch.remindAt = nextRemind; patch.remindedAt = null; }
      }
      if (d.priority !== undefined && d.priority !== t.priority) { patch.priority = d.priority; events.push(["priority_changed", { from: t.priority, to: d.priority }]); }
      if (d.assigneeUserId !== undefined && (d.assigneeUserId ?? null) !== t.assigneeUserId) {
        patch.assigneeUserId = d.assigneeUserId ?? null;
        events.push(["assignee_changed", { from: await person(tx, t.assigneeUserId), to: await person(tx, patch.assigneeUserId) }]);
      }
      if (d.contactId !== undefined && (d.contactId ?? null) !== t.contactId) {
        patch.contactId = d.contactId ?? null;
        const name = async (id: string | null) => (id ? { id, name: (await loadContact(tx, workspaceId, id))?.name ?? cur.cn ?? "" } : null);
        events.push(["contact_changed", { from: t.contactId ? { id: t.contactId, name: cur.cn ?? "" } : null, to: await name(patch.contactId) }]);
      }
      const wasActive = t.status === "open" || t.status === "in_progress";
      let activity: "task.completed" | "task.reopened" | "task.cancelled" | null = null;
      if (d.status !== undefined && d.status !== t.status) {
        const nowActive = d.status === "open" || d.status === "in_progress";
        patch.status = d.status;
        patch.completedAt = d.status === "done" ? new Date() : null;
        const kind = d.status === "done" ? "completed" : !wasActive && nowActive ? "reopened" : "status_changed";
        events.push([kind, { from: t.status, to: d.status }]);
        activity = d.status === "done" ? "task.completed" : !wasActive && nowActive ? "task.reopened" : d.status === "cancelled" ? "task.cancelled" : null;
      }
      if (!events.length) return c.json(taskDto(cur)); // nothing changed: no version bump, no history

      const upd = await tx.update(schema.tasks).set({ ...patch, version: sql`${schema.tasks.version} + 1`, updatedAt: new Date() }).where(and(eq(schema.tasks.workspaceId, workspaceId), eq(schema.tasks.id, taskId), eq(schema.tasks.version, t.version))).returning({ id: schema.tasks.id });
      if (!upd.length) return fail(c, 409, "version_conflict", "This task was changed by someone else. Review the latest version and try again.");
      for (const [kind, data] of events) await addEvent(tx, workspaceId, taskId, userId, kind, data);

      // Keep the contact timeline and last_activity_at in step (task.created/completed/reopened existed before this feature).
      const title = patch.title ?? t.title;
      const newContact = patch.contactId !== undefined ? patch.contactId : t.contactId;
      if (patch.assigneeUserId) await emitEvent(tx, { workspaceId, type: "task.assigned", entityType: "task", entityId: taskId, actorUserId: userId, payload: { assigneeUserId: patch.assigneeUserId, title, contactId: newContact ?? null } });
      if (patch.contactId !== undefined) {
        if (t.contactId) await recordActivity(tx, { workspaceId, contactId: t.contactId, kind: "task.unlinked", actorUserId: userId, data: { taskId, title } });
        if (patch.contactId) await recordActivity(tx, { workspaceId, contactId: patch.contactId, kind: "task.linked", actorUserId: userId, data: { taskId, title } });
      }
      if (activity && newContact) await recordActivity(tx, { workspaceId, contactId: newContact, kind: activity, actorUserId: userId, data: { taskId, title } });
      return c.json(taskDto((await loadJoined(tx, workspaceId, taskId))!));
    });
  });

  r.delete("/tasks/:taskId", async (c) => {
    const taskId = c.req.param("taskId");
    if (!isUuid(taskId)) return fail(c, 404, "not_found");
    const { workspaceId, userId } = wctx(c);
    return withContext(db, wctx(c), async (tx) => {
      const cur = await loadJoined(tx, workspaceId, taskId);
      // A task linked to a deleted contact is read-only history (integrity review M1).
      if (!cur || (cur.t.contactId && !(await loadContact(tx, workspaceId, cur.t.contactId)))) return fail(c, 404, "not_found");
      if (!mayEdit(c, cur.t)) return forbidden(c);
      await tx.update(schema.tasks).set({ deletedAt: new Date(), updatedAt: new Date(), version: sql`${schema.tasks.version} + 1` }).where(and(eq(schema.tasks.workspaceId, workspaceId), eq(schema.tasks.id, taskId)));
      await addEvent(tx, workspaceId, taskId, userId, "deleted", { title: cur.t.title });
      if (cur.t.contactId) await recordActivity(tx, { workspaceId, contactId: cur.t.contactId, kind: "task.deleted", actorUserId: userId, data: { taskId, title: cur.t.title } });
      return c.body(null, 204);
    });
  });

  return r;
}
