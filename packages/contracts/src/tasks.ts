import { z } from "zod";
import { endpoint } from "./endpoint.ts";

const uuid = z.string().uuid();
const iso = z.string();
const W = "/v1/workspaces/:workspaceId";

/** open and in_progress are active; done and cancelled are closed. Only done sets completedAt. */
export const TASK_STATUSES = ["open", "in_progress", "done", "cancelled"] as const;
export const TaskStatus = z.enum(TASK_STATUSES);
export type TaskStatus = z.infer<typeof TaskStatus>;
export const ACTIVE_TASK_STATUSES = ["open", "in_progress"] as const;
/** Ordered low to urgent; the API sorts by this order. */
export const TASK_PRIORITIES = ["low", "normal", "high", "urgent"] as const;
export const TaskPriority = z.enum(TASK_PRIORITIES);
export type TaskPriority = z.infer<typeof TaskPriority>;
/** Segment views. overdue: active and due before now. today: active and due inside today's calendar day in `tz`. upcoming: active and due now or later. no_date: active without a due date. completed: done. */
export const TASK_VIEWS = ["all", "overdue", "today", "upcoming", "no_date", "completed"] as const;
export const TaskView = z.enum(TASK_VIEWS);
export const TASK_SORTS = ["due", "priority", "created", "updated"] as const;
export const TaskSort = z.enum(TASK_SORTS);
export const TASK_EVENT_KINDS = ["created", "updated", "status_changed", "completed", "reopened", "assignee_changed", "due_date_changed", "priority_changed", "contact_changed", "deleted"] as const;

const title = z.string().trim().min(1, "Title is required").max(200, "Use at most 200 characters");
const description = z.string().trim().max(4000, "Use at most 4000 characters").nullish().transform((v) => (v ? v : null));
// Offset ISO timestamps only; the year bound rejects typos such as 0202 or 20266.
const dueAt = z.string().datetime({ offset: true }).refine((v) => { const y = new Date(v).getUTCFullYear(); return y >= 2000 && y <= 2100; }, "Pick a due date between 2000 and 2100").nullish();

export const Task = z.object({
  id: uuid,
  /** null when the task is not related to a contact. */
  contactId: uuid.nullable(),
  title: z.string(),
  description: z.string().nullable(),
  dueAt: iso.nullable(),
  status: TaskStatus,
  priority: TaskPriority,
  assignee: z.object({ id: z.string(), name: z.string() }).nullable(),
  contact: z.object({ id: uuid, name: z.string() }).nullable(),
  createdBy: z.object({ id: z.string(), name: z.string() }).nullable(),
  completedAt: iso.nullable(),
  createdAt: iso,
  updatedAt: iso,
  version: z.number().int(),
});
export type Task = z.infer<typeof Task>;

export const CreateTaskBody = z.object({ title, description: description.optional(), dueAt, assigneeUserId: z.string().nullish(), priority: TaskPriority.optional() });
export const CreateWorkspaceTaskBody = CreateTaskBody.extend({ contactId: uuid.nullish() });
export type CreateWorkspaceTaskBody = z.input<typeof CreateWorkspaceTaskBody>;
/** expectedVersion is optional only so older clients keep working; when sent it is enforced (409 version_conflict). */
export const UpdateTaskBody = z
  .object({ title: title.optional(), description: description.optional(), dueAt, status: TaskStatus.optional(), priority: TaskPriority.optional(), assigneeUserId: z.string().nullish(), contactId: uuid.nullish(), expectedVersion: z.number().int().min(1).optional() })
  .refine((v) => Object.keys(v).some((k) => k !== "expectedVersion"), "Nothing to update");
export type UpdateTaskBody = z.input<typeof UpdateTaskBody>;

const csv = <T extends string>(item: z.ZodType<T, T>) => z.string().transform((s) => s.split(",").map((x) => x.trim()).filter(Boolean)).pipe(z.array(item).min(1).max(10));
const instant = z.string().datetime({ offset: true });
export const TaskFilterFields = {
  view: TaskView.optional(),
  status: csv(TaskStatus).optional(),
  priority: csv(TaskPriority).optional(),
  /** "me", "unassigned", or a member's user id. Omitted means anyone. */
  assignee: z.string().min(1).max(100).optional(),
  contactId: uuid.optional(),
  dueFrom: instant.optional(),
  dueTo: instant.optional(),
  search: z.string().trim().max(100).optional(),
  /** IANA time zone that defines "today". Defaults to UTC. */
  tz: z.string().max(64).optional(),
  /** Treat this instant as "now" for the views. Defaults to the server clock. */
  asOf: instant.optional(),
};
export const TaskListQuery = z.object({ ...TaskFilterFields, sort: TaskSort.optional(), dir: z.enum(["asc", "desc"]).optional(), cursor: z.string().max(500).optional(), limit: z.coerce.number().int().min(1).max(100).optional() });
export type TaskListQuery = z.input<typeof TaskListQuery>;
export const TaskPage = z.object({ items: z.array(Task), total: z.number().int(), nextCursor: z.string().nullable() });
export type TaskPage = z.infer<typeof TaskPage>;

export const TaskSummaryQuery = z.object({ assignee: TaskFilterFields.assignee, contactId: TaskFilterFields.contactId, tz: TaskFilterFields.tz, asOf: TaskFilterFields.asOf });
export const TaskSummary = z.object({ overdue: z.number().int(), today: z.number().int(), upcoming: z.number().int(), noDate: z.number().int(), completed: z.number().int(), active: z.number().int() });
export type TaskSummary = z.infer<typeof TaskSummary>;

export const TaskEvent = z.object({ id: uuid, kind: z.enum(TASK_EVENT_KINDS), actor: z.object({ id: z.string(), name: z.string() }).nullable(), data: z.record(z.string(), z.unknown()), occurredAt: iso });
export type TaskEvent = z.infer<typeof TaskEvent>;
export const TaskEventPage = z.object({ items: z.array(TaskEvent), nextCursor: z.string().nullable() });
export const TaskEventsQuery = z.object({ cursor: uuid.optional(), limit: z.coerce.number().int().min(1).max(100).optional() });

export const tasksEndpoints = {
  listTasks: endpoint({ method: "GET", path: `${W}/tasks`, query: TaskListQuery, response: TaskPage }),
  taskSummary: endpoint({ method: "GET", path: `${W}/tasks/summary`, query: TaskSummaryQuery, response: TaskSummary }),
  createWorkspaceTask: endpoint({ method: "POST", path: `${W}/tasks`, body: CreateWorkspaceTaskBody, response: Task }),
  getTask: endpoint({ method: "GET", path: `${W}/tasks/:taskId`, response: Task }),
  listTaskEvents: endpoint({ method: "GET", path: `${W}/tasks/:taskId/events`, query: TaskEventsQuery, response: TaskEventPage }),
  // Contact-scoped endpoints (pre-existing; kept for compatibility).
  listContactTasks: endpoint({ method: "GET", path: `${W}/contacts/:contactId/tasks`, response: z.array(Task) }),
  createTask: endpoint({ method: "POST", path: `${W}/contacts/:contactId/tasks`, body: CreateTaskBody, response: Task }),
  updateTask: endpoint({ method: "PATCH", path: `${W}/tasks/:taskId`, body: UpdateTaskBody, response: Task }),
  deleteTask: endpoint({ method: "DELETE", path: `${W}/tasks/:taskId`, response: z.undefined() }),
  // Lead-scoped: a task may be linked to a lead (and independently to its contact via contactId).
  listLeadTasks: endpoint({ method: "GET", path: `${W}/leads/:leadId/tasks`, response: z.array(Task) }),
  createLeadTask: endpoint({ method: "POST", path: `${W}/leads/:leadId/tasks`, body: CreateWorkspaceTaskBody, response: Task }),
  linkLeadTask: endpoint({ method: "PUT", path: `${W}/leads/:leadId/tasks/:taskId`, response: z.undefined() }),
  unlinkLeadTask: endpoint({ method: "DELETE", path: `${W}/leads/:leadId/tasks/:taskId`, response: z.undefined() }),
} as const;
