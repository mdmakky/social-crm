import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { endpoints } from "@crm/contracts";
import { sweepTaskReminders } from "../src/notifications/index.ts";
import { bootstrap, ok, type Harness, type TestUser } from "./harness.ts";

// A task with remindAt notifies its assignee once, when the time has come, and only while the task is open.
let h: Harness;
let owner: TestUser, agent: TestUser;
let W: string;
const o = () => h.clientFor(owner);
const p = () => ({ workspaceId: W });
const mine = async (u: TestUser) => ok(await h.clientFor(u).call(endpoints.listNotifications, { params: p() })).items.filter((n) => n.kind === "task.reminder");
const at = (min: number) => new Date(Date.now() + min * 60_000).toISOString();
const mk = async (body: Record<string, unknown>) => ok(await o().call(endpoints.createWorkspaceTask, { params: p(), body: body as never }));

beforeAll(async () => {
  h = await bootstrap();
  owner = await h.newUser("rm-owner"); agent = await h.newUser("rm-agent");
  W = await h.workspace(owner, "Reminder Co", { agent });
});
afterAll(async () => h.close());

describe("task reminders", () => {
  it("stores remindAt only with a due time and returns it", async () => {
    const withDue = await mk({ title: "A", dueAt: at(60), remindAt: at(45) });
    expect(withDue.remindAt).toBeTruthy();
    const noDue = await mk({ title: "B", remindAt: at(45) });
    expect(noDue.remindAt).toBeNull();
  });
  it("sends one reminder to the assignee when remindAt has passed, never twice", async () => {
    const t = await mk({ title: "Call Rafiq", dueAt: at(30), remindAt: at(-1), assigneeUserId: agent.id });
    expect(await sweepTaskReminders(h.db)).toBeGreaterThanOrEqual(1);
    const got = (await mine(agent)).filter((n) => n.entityId === t.id);
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ title: "Reminder: Call Rafiq", entityType: "task" });
    await sweepTaskReminders(h.db);
    expect((await mine(agent)).filter((n) => n.entityId === t.id)).toHaveLength(1);
  });
  it("does not remind before the time, or for a finished task", async () => {
    const later = await mk({ title: "Later", dueAt: at(120), remindAt: at(90), assigneeUserId: agent.id });
    const done = await mk({ title: "Done already", dueAt: at(30), remindAt: at(-1), assigneeUserId: agent.id });
    ok(await o().call(endpoints.updateTask, { params: { ...p(), taskId: done.id }, body: { status: "done" } }));
    await sweepTaskReminders(h.db);
    const ids = (await mine(agent)).map((n) => n.entityId);
    expect(ids).not.toContain(later.id);
    expect(ids).not.toContain(done.id);
  });
  it("changing remindAt re-arms the reminder; clearing the due date clears it", async () => {
    const t = await mk({ title: "Re-arm", dueAt: at(30), remindAt: at(-1), assigneeUserId: agent.id });
    await sweepTaskReminders(h.db);
    const again = ok(await o().call(endpoints.updateTask, { params: { ...p(), taskId: t.id }, body: { dueAt: at(40), remindAt: at(-0.5) } }));
    expect(again.remindAt).toBeTruthy();
    await sweepTaskReminders(h.db);
    expect((await mine(agent)).filter((n) => n.entityId === t.id)).toHaveLength(2);
    const cleared = ok(await o().call(endpoints.updateTask, { params: { ...p(), taskId: t.id }, body: { dueAt: null } }));
    expect(cleared.remindAt).toBeNull();
  });
  it("respects a muted preference", async () => {
    ok(await h.clientFor(agent).call(endpoints.updateNotificationPreferences, { params: p(), body: { preferences: [{ kind: "task.reminder", inApp: false }] } }));
    const t = await mk({ title: "Muted", dueAt: at(30), remindAt: at(-1), assigneeUserId: agent.id });
    await sweepTaskReminders(h.db);
    expect((await mine(agent)).filter((n) => n.entityId === t.id)).toHaveLength(0);
  });
});
