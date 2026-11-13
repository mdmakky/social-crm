import { writeFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { endpoints, type TaskListQuery } from "@crm/contracts";
import { bootstrap, ok, type Harness, type TestUser } from "./harness.ts";

/**
 * Track B gate: with 10,000 tasks in one workspace, list p95 < 300 ms for every sort, view and filter.
 * Measured in-process against local Postgres as an agent (so RLS runs the role helpers), bounding database and query cost only.
 */
let h: Harness;
let owner: TestUser, agent: TestUser;
let W: string;
let contactId: string;
const ROWS = 10_000;
const timings: Record<string, number> = {};

const p95 = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.ceil(xs.length * 0.95) - 1]!;
async function measure(label: string, fn: () => Promise<unknown>, runs = 30) {
  await fn();
  const out: number[] = [];
  for (let i = 0; i < runs; i++) {
    const t = performance.now();
    await fn();
    out.push(performance.now() - t);
  }
  timings[label] = p95(out);
  return timings[label]!;
}

beforeAll(async () => {
  h = await bootstrap();
  owner = await h.newUser("tperfowner");
  agent = await h.newUser("tperfagent");
  W = await h.workspace(owner, "Task Perf Co", { agent });
  contactId = (await h.contact(h.clientFor(owner), W, { name: "Perf Contact" })).id;
  await h.admin.query(
    `INSERT INTO tasks (workspace_id, contact_id, title, description, due_at, status, priority, assignee_user_id, created_by, completed_at, created_at, updated_at)
     SELECT $1, CASE WHEN g % 20 = 0 THEN $4::uuid END, 'Follow up with customer ' || g || ' ' || (ARRAY['quote','renewal','invoice','onboarding'])[1 + g % 4],
            CASE WHEN g % 3 = 0 THEN 'Notes for task ' || g END,
            CASE WHEN g % 7 = 0 THEN NULL ELSE now() + ((g % 400) - 200 || ' hours')::interval END,
            (ARRAY['open','open','in_progress','done','cancelled'])[1 + g % 5]::task_status,
            (ARRAY['low','normal','high','urgent'])[1 + g % 4]::task_priority,
            CASE g % 3 WHEN 0 THEN $2 WHEN 1 THEN $3 END, $2, CASE WHEN g % 5 = 3 THEN now() END,
            now() - (g || ' minutes')::interval, now() - (g || ' seconds')::interval
     FROM generate_series(1, $5) g`,
    [W, owner.id, agent.id, contactId, ROWS],
  );
  await h.admin.query("ANALYZE tasks");
}, 120_000);
afterAll(async () => h.close());

describe(`performance with ${ROWS} tasks`, () => {
  const c = () => h.clientFor(agent);
  const list = (query: TaskListQuery) => async () => ok(await c().call(endpoints.listTasks, { params: { workspaceId: W }, query }));
  const cases: [string, TaskListQuery][] = [
    ["default (due asc)", {}],
    ["due desc", { sort: "due", dir: "desc" }],
    ["priority", { sort: "priority", dir: "desc" }],
    ["created", { sort: "created", dir: "desc" }],
    ["updated", { sort: "updated", dir: "desc" }],
    ["overdue view", { view: "overdue" }],
    ["today view", { view: "today", tz: "Europe/Berlin" }],
    ["upcoming view", { view: "upcoming" }],
    ["no date view", { view: "no_date" }],
    ["completed view", { view: "completed", sort: "updated", dir: "desc" }],
    ["assignee me", { assignee: "me" }],
    ["unassigned + priority", { assignee: "unassigned", priority: "urgent,high" as never }],
    ["contact filter", { contactId }],
    ["search", { search: "renewal 77" }],
    ["limit 100", { limit: 100 }],
  ];
  it.each(cases)("list p95 under 300 ms: %s", async (label, q) => {
    expect(await measure(label, list(q))).toBeLessThan(300);
  });
  it("a deep page by cursor stays fast (keyset, not offset)", async () => {
    let cursor: string | undefined;
    for (let i = 0; i < 20; i++) {
      const page = ok(await c().call(endpoints.listTasks, { params: { workspaceId: W }, query: { sort: "created", dir: "desc", limit: 100, cursor } }));
      cursor = page.nextCursor ?? undefined;
    }
    expect(await measure("deep page (page 21)", list({ sort: "created", dir: "desc", limit: 100, cursor }))).toBeLessThan(300);
  });
  it("summary counts p95 under 300 ms", async () => {
    expect(await measure("summary", async () => ok(await c().call(endpoints.taskSummary, { params: { workspaceId: W } })))).toBeLessThan(300);
  });
  it("writes the timings to TASK_PERF_OUT for the report", () => {
    const out = JSON.stringify(Object.fromEntries(Object.entries(timings).map(([k, v]) => [k, Math.round(v * 10) / 10])), null, 1);
    if (process.env.TASK_PERF_OUT) writeFileSync(process.env.TASK_PERF_OUT, out);
  });
});
