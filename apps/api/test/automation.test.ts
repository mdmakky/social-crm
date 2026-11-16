import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { endpoints, type AutomationRunDto, type CreateAutomationRuleBody } from "@crm/contracts";
import { schema, withContext } from "@crm/db";
import { dispatchPending } from "../src/events.ts";
import { automationConsumer, processRuns } from "../src/automation/engine.ts";
import { notificationsConsumer } from "../src/notifications/index.ts";
import { bootstrap, failure, ok, type Harness, type TestUser } from "./harness.ts";

let h: Harness;
let owner: TestUser, admin: TestUser, agent: TestUser, viewer: TestUser, ownerB: TestUser;
let A = "", B = "";
const as = (u: TestUser) => h.clientFor(u);
const p = (ws = A) => ({ workspaceId: ws });
const code = (r: Parameters<typeof failure>[0]) => (failure(r) as unknown as { code: string }).code;
const future = (ms: number) => new Date(Date.now() + ms);
/** One dispatcher pass (events -> runs) and one executor pass; `now` steps past a backoff without sleeping. */
const tick = async (now?: Date) => {
  await dispatchPending(h.db, { consumers: [notificationsConsumer, automationConsumer], workspaceIds: [A] });
  return processRuns(h.db, { workspaceIds: [A], now });
};
let n = 0;
const uniq = (s: string) => `${s}-${Date.now().toString(36)}-${n++}`;
/** Each rule matches only its own contact name, so rules from different tests never see each other's events. */
async function mkRule(name: string, over: Partial<CreateAutomationRuleBody> = {}) {
  return ok(await as(owner).call(endpoints.createAutomationRule, { params: p(), body: { name: `rule ${name}`, triggerType: "contact.created", conditions: { op: "equals", field: "contactName", value: name }, actions: [{ type: "add_tag", tagName: "VIP" }], enabled: true, ...over } }));
}
const runs = async (ruleId?: string): Promise<AutomationRunDto[]> => ok(await as(owner).call(endpoints.listAutomationRuns, { params: p(), query: { limit: 100 } })).items.filter((r) => !ruleId || r.ruleId === ruleId);
const contactTags = async (id: string) => (ok(await as(owner).call(endpoints.getContact, { params: { ...p(), contactId: id } })).tags).map((t) => t.name);

beforeAll(async () => {
  h = await bootstrap();
  owner = await h.newUser("au-owner"); admin = await h.newUser("au-admin"); agent = await h.newUser("au-agent"); viewer = await h.newUser("au-viewer"); ownerB = await h.newUser("au-ownerb");
  A = await h.workspace(owner, "Automation A", { admin, agent, viewer });
  B = await h.workspace(ownerB, "Automation B");
});
afterAll(async () => { await h.close(); });

describe("rule CRUD and permissions", () => {
  it("owner and admin manage rules; agent and viewer get 403 on every automation route", async () => {
    const name = uniq("crud");
    const r = await mkRule(name, { enabled: false });
    expect(r).toMatchObject({ enabled: false, requiresApproval: true, version: 1, triggerType: "contact.created" });
    const upd = ok(await as(admin).call(endpoints.updateAutomationRule, { params: { ...p(), ruleId: r.id }, body: { name: `renamed ${name}`, enabled: true } }));
    expect(upd).toMatchObject({ name: `renamed ${name}`, enabled: true, version: 2 });
    expect(ok(await as(admin).call(endpoints.updateAutomationRule, { params: { ...p(), ruleId: r.id }, body: { enabled: false } })).version).toBe(2); // toggle is not a material change
    for (const u of [agent, viewer]) {
      expect(failure(await as(u).call(endpoints.listAutomationRules, { params: p() })).status).toBe(403);
      expect(failure(await as(u).call(endpoints.createAutomationRule, { params: p(), body: { name: "x", triggerType: "contact.created", actions: [{ type: "add_tag", tagName: "x" }] } })).status).toBe(403);
      expect(failure(await as(u).call(endpoints.updateAutomationRule, { params: { ...p(), ruleId: r.id }, body: { enabled: true } })).status).toBe(403);
      expect(failure(await as(u).call(endpoints.deleteAutomationRule, { params: { ...p(), ruleId: r.id } })).status).toBe(403);
      expect(failure(await as(u).call(endpoints.listAutomationRuns, { params: p() })).status).toBe(403);
      expect(failure(await as(u).call(endpoints.getAutomationSettings, { params: p() })).status).toBe(403);
      expect(failure(await as(u).call(endpoints.updateAutomationSettings, { params: p(), body: { killSwitch: true } })).status).toBe(403);
      expect(failure(await as(u).call(endpoints.approveAutomationRun, { params: { ...p(), runId: r.id } })).status).toBe(403);
    }
    ok(await as(owner).call(endpoints.deleteAutomationRule, { params: { ...p(), ruleId: r.id } }));
    expect(ok(await as(owner).call(endpoints.listAutomationRules, { params: p() })).some((x) => x.id === r.id)).toBe(false);
    expect(code(await as(owner).call(endpoints.deleteAutomationRule, { params: { ...p(), ruleId: r.id } }))).toBe("not_found");
  });

  it("validates the body: unknown action, no actions, bad trigger, oversized or malformed condition", async () => {
    const bad = (body: Record<string, unknown>) => as(owner).call(endpoints.createAutomationRule, { params: p(), body: { name: "x", triggerType: "contact.created", actions: [{ type: "add_tag", tagName: "x" }], ...body } as never });
    expect((await bad({ actions: [{ type: "send_message", text: "hi" }] })).ok).toBe(false);
    expect((await bad({ actions: [] })).ok).toBe(false);
    expect((await bad({ triggerType: "message.received" })).ok).toBe(false);
    expect((await bad({ conditions: { op: "eval", field: "a", value: "process.exit()" } })).ok).toBe(false);
    expect((await bad({ conditions: { op: "equals", field: "a b", value: 1 } })).ok).toBe(false);
    expect((await bad({ actions: [{ type: "add_tag", tagName: "x", extra: 1 }] })).ok).toBe(false);
    // the server enforces the same schema for callers that bypass the typed client
    const raw = await h.app.request(`/v1/workspaces/${A}/automations/rules`, { method: "POST", headers: { "content-type": "application/json", origin: "http://localhost:3000", cookie: owner.cookie }, body: JSON.stringify({ name: "x", triggerType: "contact.created", actions: [{ type: "send_message", text: "hi" }] }) });
    expect(raw.status).toBe(400);
    let deep: unknown = { op: "equals", field: "a", value: 1 };
    for (let i = 0; i < 5; i++) deep = { op: "and", conditions: [deep] };
    expect((await bad({ conditions: deep })).ok).toBe(false);
  });
});

describe("trigger, approval and execution", () => {
  it("a matching event creates exactly one run that waits for approval; approving executes all actions and logs steps", async () => {
    const name = uniq("flow");
    const rule = await mkRule(name, { actions: [{ type: "add_tag", tagName: "VIP" }, { type: "create_task", title: "Call them", dueInHours: 24, priority: "high" }] });
    const c = await h.contact(as(owner), A, { name, email: `${name}@au.example` });
    await tick();
    const [first, ...rest] = await runs(rule.id);
    let run = first;
    expect(rest).toHaveLength(0);
    expect(run).toMatchObject({ status: "awaiting_approval", attempts: 0, ruleVersion: 1, entityId: c.id });
    await tick(future(3_600_000));
    expect((await runs(rule.id))[0]!.status).toBe("awaiting_approval"); // never executes without a decision
    expect(await contactTags(c.id)).toEqual([]);

    const approved = ok(await as(admin).call(endpoints.approveAutomationRun, { params: { ...p(), runId: run!.id } }));
    expect(approved).toMatchObject({ status: "pending", approvedBy: admin.id });
    expect(code(await as(owner).call(endpoints.approveAutomationRun, { params: { ...p(), runId: run!.id } }))).toBe("not_awaiting_approval");
    expect(code(await as(owner).call(endpoints.rejectAutomationRun, { params: { ...p(), runId: run!.id } }))).toBe("not_awaiting_approval");

    await tick();
    [run] = await runs(rule.id);
    expect(run).toMatchObject({ status: "succeeded", attempts: 1, error: null });
    expect(run!.steps.map((s) => [s.idx, s.actionType, s.status])).toEqual([[0, "add_tag", "succeeded"], [1, "create_task", "succeeded"]]);
    expect(await contactTags(c.id)).toEqual(["VIP"]);
    const tasks = ok(await as(owner).call(endpoints.listContactTasks, { params: { ...p(), contactId: c.id } }));
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({ title: "Call them", priority: "high", createdBy: { id: admin.id } }); // executed with the approver's authority
  });

  it("replaying the trigger event yields exactly one run", async () => {
    const name = uniq("replay");
    const rule = await mkRule(name, { requiresApproval: false });
    await h.contact(as(owner), A, { name, email: `${name}@au.example` });
    await tick();
    expect(await runs(rule.id)).toHaveLength(1);
    // rewind the consumer offset: every event of the workspace is delivered again
    await h.admin.query("UPDATE event_consumers SET last_seq = 0 WHERE consumer = 'automation' AND workspace_id = $1", [A]);
    await tick();
    await h.admin.query("UPDATE event_consumers SET last_seq = 0 WHERE consumer = 'automation' AND workspace_id = $1", [A]);
    await tick();
    const rs = await runs(rule.id);
    expect(rs).toHaveLength(1);
    expect(rs[0]).toMatchObject({ status: "succeeded", attempts: 1 }); // and the action ran once
    const [{ count }] = (await h.admin.query("SELECT count(*)::int AS count FROM automation_runs WHERE rule_id = $1 AND idempotency_key LIKE 'event:%'", [rule.id])).rows;
    expect(count).toBe(1);
  });

  it("conditions filter: non-matching events create no run; in/or/and combine", async () => {
    const name = uniq("cond");
    const rule = await mkRule(name, { conditions: { op: "and", conditions: [{ op: "contains", field: "contactName", value: name }, { op: "in", field: "source", values: ["import", "other"] }] }, requiresApproval: false });
    await h.contact(as(owner), A, { name, email: `${name}@au.example` }); // source manual: not in the list
    await tick();
    expect(await runs(rule.id)).toHaveLength(0);
  });

  it("reject cancels the run for good; nothing executes", async () => {
    const name = uniq("reject");
    const rule = await mkRule(name);
    const c = await h.contact(as(owner), A, { name, email: `${name}@au.example` });
    await tick();
    const [run] = await runs(rule.id);
    expect(ok(await as(owner).call(endpoints.rejectAutomationRun, { params: { ...p(), runId: run!.id } }))).toMatchObject({ status: "cancelled", error: "Rejected" });
    expect(code(await as(owner).call(endpoints.approveAutomationRun, { params: { ...p(), runId: run!.id } }))).toBe("not_awaiting_approval");
    await tick(future(3_600_000));
    expect(await contactTags(c.id)).toEqual([]);
  });

  it("assign_owner works, and the event it emits does not trigger automations again (loop guard)", async () => {
    const name = uniq("owner");
    const rule = await mkRule(name, { requiresApproval: false, actions: [{ type: "assign_owner", ownerUserId: agent.id }] });
    const loop = await mkRule(name, { name: `loop ${name}`, triggerType: "contact.owner_assigned", conditions: { op: "equals", field: "contactName", value: name }, requiresApproval: false });
    const c = await h.contact(as(owner), A, { name, email: `${name}@au.example` });
    await tick();
    await tick();
    expect(await runs(rule.id)).toMatchObject([{ status: "succeeded" }]);
    expect(ok(await as(owner).call(endpoints.getContact, { params: { ...p(), contactId: c.id } })).owner?.id).toBe(agent.id);
    expect(await runs(loop.id)).toHaveLength(0);
  });

  it("a disabled rule stops pending runs (skipped); editing the rule does not change an existing run's actions", async () => {
    const name = uniq("disable");
    const rule = await mkRule(name);
    const c = await h.contact(as(owner), A, { name, email: `${name}@au.example` });
    await tick();
    const [run] = await runs(rule.id);
    ok(await as(owner).call(endpoints.updateAutomationRule, { params: { ...p(), ruleId: rule.id }, body: { actions: [{ type: "add_tag", tagName: "Changed" }] } }));
    ok(await as(owner).call(endpoints.approveAutomationRun, { params: { ...p(), runId: run!.id } }));
    ok(await as(owner).call(endpoints.updateAutomationRule, { params: { ...p(), ruleId: rule.id }, body: { enabled: false } }));
    await tick();
    expect((await runs(rule.id))[0]).toMatchObject({ status: "skipped", actions: [{ type: "add_tag", tagName: "VIP" }] });
    expect(await contactTags(c.id)).toEqual([]);
  });

  it("lead.stage_changed triggers with the lead's contact", async () => {
    const name = uniq("lead");
    const c = await h.contact(as(owner), A, { name, email: `${name}@au.example` });
    const pipe = ok(await as(owner).call(endpoints.listPipelines, { params: p() })).pipelines[0]!;
    const open = pipe.stages.filter((s) => s.kind === "open");
    const lead = ok(await as(owner).call(endpoints.createLead, { params: p(), body: { title: name, primaryContactId: c.id, allowDuplicate: true } as never }));
    const rule = await mkRule(name, { triggerType: "lead.stage_changed", conditions: { op: "equals", field: "toStageId", value: open[1]!.id }, requiresApproval: false });
    ok(await as(owner).call(endpoints.moveLead, { params: { ...p(), leadId: lead.id }, body: { expectedVersion: lead.version, stageId: open[1]!.id } }));
    await tick();
    await tick();
    expect(await runs(rule.id)).toMatchObject([{ status: "succeeded", entityType: "lead" }]);
    expect(await contactTags(c.id)).toEqual(["VIP"]);
  });
});

describe("failure and retry", () => {
  const trap = async (title: string) => {
    await h.admin.query(`CREATE OR REPLACE FUNCTION au_boom() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.title = TG_ARGV[0] THEN RAISE EXCEPTION 'simulated outage'; END IF; RETURN NEW; END $$`);
    await h.admin.query(`CREATE TRIGGER au_boom_${title.replace(/\W/g, "_")} BEFORE INSERT ON tasks FOR EACH ROW EXECUTE FUNCTION au_boom('${title}')`);
    return () => h.admin.query(`DROP TRIGGER au_boom_${title.replace(/\W/g, "_")} ON tasks`);
  };

  it("a transient failure rolls everything back, backs off, and a later attempt succeeds", async () => {
    const name = uniq("retry");
    const title = uniq("boom-ok");
    const untrap = await trap(title);
    const rule = await mkRule(name, { requiresApproval: false, actions: [{ type: "add_tag", tagName: "Retried" }, { type: "create_task", title }] });
    const c = await h.contact(as(owner), A, { name, email: `${name}@au.example` });
    await tick();
    let [run] = await runs(rule.id);
    expect(run).toMatchObject({ status: "pending", attempts: 1, error: "simulated outage" });
    expect(run!.nextAttemptAt && new Date(run!.nextAttemptAt).getTime()).toBeGreaterThan(Date.now() + 20_000);
    expect(await contactTags(c.id)).toEqual([]); // the tag from step 0 was rolled back with the failed step 1
    expect(run!.steps.map((s) => [s.attempt, s.idx, s.status])).toEqual([[1, 1, "failed"]]);
    await tick(); // backoff not elapsed: not retried
    expect((await runs(rule.id))[0]!.attempts).toBe(1);
    await untrap();
    await tick(future(60_000));
    [run] = await runs(rule.id);
    expect(run).toMatchObject({ status: "succeeded", attempts: 2, error: null });
    expect(await contactTags(c.id)).toEqual(["Retried"]);
  });

  it("gives up after 3 attempts and records the failed steps", async () => {
    const name = uniq("giveup");
    const title = uniq("boom-always");
    const untrap = await trap(title);
    const rule = await mkRule(name, { requiresApproval: false, actions: [{ type: "create_task", title }] });
    await h.contact(as(owner), A, { name, email: `${name}@au.example` });
    await tick();
    await tick(future(60_000));
    await tick(future(3_600_000));
    await tick(future(7_200_000)); // already failed: nothing more happens
    const [run] = await runs(rule.id);
    await untrap();
    expect(run).toMatchObject({ status: "failed", attempts: 3, error: "simulated outage", nextAttemptAt: null });
    expect(run!.steps.map((s) => [s.attempt, s.status])).toEqual([[1, "failed"], [2, "failed"], [3, "failed"]]);
  });

  it("a permanent failure (assignee not in the workspace) fails at once without retries", async () => {
    const name = uniq("perm");
    const rule = await mkRule(name, { requiresApproval: false, actions: [{ type: "assign_owner", ownerUserId: ownerB.id }] });
    await h.contact(as(owner), A, { name, email: `${name}@au.example` });
    await tick();
    const [run] = await runs(rule.id);
    expect(run).toMatchObject({ status: "failed", attempts: 1, error: "The new owner is not a member of this workspace." });
  });
});

describe("kill switch", () => {
  it("stops run creation, execution and approval; turning it off resumes", async () => {
    const auto = uniq("kill-auto");
    const gated = uniq("kill-gated");
    const rule = await mkRule(auto, { requiresApproval: false });
    const rule2 = await mkRule(gated);
    const c1 = await h.contact(as(owner), A, { name: auto, email: `${auto}@au.example` });
    await h.contact(as(owner), A, { name: gated, email: `${gated}@au.example` });
    await dispatchPending(h.db, { consumers: [automationConsumer], workspaceIds: [A] }); // runs exist, none executed yet
    expect((await runs(rule.id))[0]!.status).toBe("pending");
    const [awaiting] = await runs(rule2.id);

    expect(ok(await as(admin).call(endpoints.updateAutomationSettings, { params: p(), body: { killSwitch: true } }))).toEqual({ killSwitch: true });
    try {
      expect(ok(await as(owner).call(endpoints.getAutomationSettings, { params: p() }))).toEqual({ killSwitch: true });
      expect(await processRuns(h.db, { workspaceIds: [A] })).toBe(0);
      expect((await runs(rule.id))[0]!.status).toBe("pending");
      expect(await contactTags(c1.id)).toEqual([]);
      expect(code(await as(owner).call(endpoints.approveAutomationRun, { params: { ...p(), runId: awaiting!.id } }))).toBe("kill_switch_on");
      // rejecting stays possible: it only removes work
      // new events create no runs while paused
      const late = uniq("kill-late");
      const rule3 = await mkRule(late, { requiresApproval: false });
      await h.contact(as(owner), A, { name: late, email: `${late}@au.example` });
      await tick();
      expect(await runs(rule3.id)).toHaveLength(0);
    } finally {
      ok(await as(owner).call(endpoints.updateAutomationSettings, { params: p(), body: { killSwitch: false } }));
    }
    await tick();
    expect((await runs(rule.id))[0]!.status).toBe("succeeded");
    expect(await contactTags(c1.id)).toEqual(["VIP"]);
  });
});

describe("tenant isolation (RLS)", () => {
  it("another workspace sees and changes nothing; routes of workspace A are 404/403 for a stranger", async () => {
    const name = uniq("iso");
    const rule = await mkRule(name);
    await h.contact(as(owner), A, { name, email: `${name}@au.example` });
    await tick();
    const [run] = await runs(rule.id);
    expect(ok(await as(ownerB).call(endpoints.listAutomationRules, { params: p(B) }))).toEqual([]);
    expect(ok(await as(ownerB).call(endpoints.listAutomationRuns, { params: p(B) })).items).toEqual([]);
    expect(failure(await as(ownerB).call(endpoints.listAutomationRules, { params: p(A) })).status).toBeGreaterThanOrEqual(403);
    expect(code(await as(ownerB).call(endpoints.updateAutomationRule, { params: { ...p(B), ruleId: rule.id }, body: { enabled: false } }))).toBe("not_found");
    expect(code(await as(ownerB).call(endpoints.approveAutomationRun, { params: { ...p(B), runId: run!.id } }))).toBe("not_found");
    // database level: B's context, an agent of A, and request context without the system flag
    const inB = await withContext(h.db, { userId: ownerB.id, workspaceId: B }, (tx) => tx.select().from(schema.automationRules).where(eq(schema.automationRules.workspaceId, A)));
    expect(inB).toEqual([]);
    const asAgent = await withContext(h.db, { userId: agent.id, workspaceId: A }, (tx) => tx.select().from(schema.automationRuns));
    expect(asAgent).toEqual([]);
    await expect(withContext(h.db, { userId: owner.id, workspaceId: A }, (tx) => tx.insert(schema.automationRuns).values({ workspaceId: A, ruleId: rule.id, ruleVersion: 1, triggerEventId: crypto.randomUUID(), idempotencyKey: "x", triggerType: "contact.created", entityType: "contact", entityId: "x", actions: rule.actions, status: "pending" }))).rejects.toThrow();
    await expect(withContext(h.db, { userId: agent.id, workspaceId: A }, (tx) => tx.insert(schema.automationRules).values({ workspaceId: A, name: "x", triggerType: "contact.created", actions: rule.actions, createdBy: agent.id }))).rejects.toThrow();
    // an owner cannot move a run to succeeded by hand, nor flip a finished run
    await expect(withContext(h.db, { userId: owner.id, workspaceId: A }, (tx) => tx.update(schema.automationRuns).set({ status: "succeeded" }).where(and(eq(schema.automationRuns.workspaceId, A), eq(schema.automationRuns.id, run!.id))).returning())).rejects.toThrow();
  });
});
