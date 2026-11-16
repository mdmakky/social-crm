import { expect, test, type Browser, type Page } from "@playwright/test";
import { addMemberByEmail, api, createWorkspace, register, signUpAndCreate } from "./helpers";
import { axe } from "./channel-helpers";

// One workspace for the whole file; tests build on each other (rule -> approve -> reject -> ...), so the file is serial.
test.describe.configure({ mode: "serial" });

type Run = { id: string; ruleId: string; entityId: string; status: string; steps: { status: string; actionType: string }[] };
const RULE = "E2E tag and task";
const TAG = "E2E-Approved";
const TASK = "E2E follow up";

let owner: Page, workspaceId = "", W = "";
let ownerA: ReturnType<typeof api>;
let ruleId = "";
const people: Record<string, { page: Page; email: string }> = {};

async function newUser(browser: Browser, name: string) {
  const page = await (await browser.newContext()).newPage();
  return { page, email: await register(page, name) };
}
async function contact(name: string) {
  const res = await ownerA.post(`${W}/contacts`, { name });
  expect(res.status()).toBe(201);
  return (await res.json()).id as string;
}
const runsOf = async (id: string) => ((await (await ownerA.get(`${W}/automations/runs?limit=100`)).json()).items as Run[]).filter((r) => r.entityId === id);
/** Bounded poll until the dispatcher (about 1 s tick) has turned the event into a run in the given status. */
const waitRun = async (id: string, status: string) => {
  await expect.poll(async () => (await runsOf(id))[0]?.status, { timeout: 20_000, intervals: [300] }).toBe(status);
  return (await runsOf(id))[0]!;
};
const tags = async (id: string) => ((await (await ownerA.get(`${W}/contacts/${id}`)).json()).tags as { name: string }[]).map((t) => t.name);
const taskCount = async (id: string) => ((await (await ownerA.get(`${W}/tasks?contactId=${id}`)).json()).items as { title: string }[]).filter((t) => t.title === TASK).length;
const open = async () => { await owner.goto(`/w/${workspaceId}/settings/automations`); await expect(owner.getByRole("heading", { name: "Rules", level: 2 })).toBeVisible(); };

test.beforeAll(async ({ browser }) => {
  owner = await (await browser.newContext()).newPage();
  ({ workspaceId } = await signUpAndCreate(owner, "Olive Owner", "Automation E2E Co"));
  W = `/v1/workspaces/${workspaceId}`;
  ownerA = api(owner);
  for (const role of ["agent", "viewer"]) { people[role] = await newUser(browser, `Pat ${role}`); await addMemberByEmail(workspaceId, people[role]!.email, role); }
  people.other = await newUser(browser, "Otto Outsider");
  await createWorkspace(people.other.page, "Other Co");
});

test("owner builds a rule in the UI (approval on)", async () => {
  await open();
  await expect(owner.getByText("No rules yet")).toBeVisible();
  await owner.getByRole("button", { name: "New rule" }).first().click();
  const d = owner.getByRole("dialog", { name: "New rule" });
  await d.getByLabel("Name", { exact: true }).fill(RULE);
  await d.getByLabel("When", { exact: true }).selectOption("contact.created");
  await d.getByRole("button", { name: "Add condition" }).click();
  await d.getByLabel("Condition 1 field").selectOption("contactName");
  await d.getByLabel("Condition 1 operator").selectOption("contains");
  await d.getByLabel("Condition 1 value").fill("Trig");
  await d.getByLabel("Action 1 tag name").fill(TAG);
  await d.getByRole("button", { name: "Add action" }).click();
  await d.getByLabel("Action 2 type").selectOption("create_task");
  await d.getByLabel("Action 2 task title").fill(TASK);
  await expect(d.getByLabel("Require approval for every run")).toBeChecked();
  await d.getByLabel("Enabled", { exact: true }).check();
  await d.getByRole("button", { name: "Create rule" }).click();
  await expect(d).toBeHidden();
  const row = owner.getByRole("listitem").filter({ hasText: RULE });
  await expect(row.getByText("Needs approval")).toBeVisible();
  ruleId = ((await (await ownerA.get(`${W}/automations/rules`)).json()) as { id: string; name: string }[]).find((r) => r.name === RULE)!.id;
});

test("approve: run waits, owner approves in UI, tag and task exist, step log shows both", async () => {
  const id = await contact("Trig Approve");
  await waitRun(id, "awaiting_approval");
  expect(await tags(id)).not.toContain(TAG); // nothing happens before approval
  expect(await taskCount(id)).toBe(0);
  await open();
  await expect(owner.getByText("Needs approval", { exact: true }).first()).toBeVisible();
  await axe(owner, "automation-approvals-list");
  await owner.getByRole("button", { name: `Approve run of ${RULE}` }).click();
  await expect(owner.getByText("Succeeded", { exact: true })).toBeVisible({ timeout: 20_000 });
  expect((await waitRun(id, "succeeded")).steps.map((s) => s.status)).toEqual(["succeeded", "succeeded"]);
  expect(await tags(id)).toContain(TAG);
  expect(await taskCount(id)).toBe(1);
});

test("reject: run is cancelled and nothing happens", async () => {
  const id = await contact("Trig Reject");
  await waitRun(id, "awaiting_approval");
  await open();
  await owner.getByRole("button", { name: `Reject run of ${RULE}` }).click();
  await expect(owner.getByText("Rejected", { exact: true })).toBeVisible({ timeout: 20_000 });
  const r = await waitRun(id, "cancelled");
  expect(r.steps).toHaveLength(0);
  await expect(owner.getByRole("button", { name: /Approve run of/ })).toHaveCount(0);
  // several executor ticks later a cancelled run must still be inert
  await expect.poll(async () => [await tags(id), await taskCount(id), (await runsOf(id))[0]!.status], { timeout: 3_000, intervals: [1000] }).toEqual([[], 0, "cancelled"]);
});

test("permissions: agent and viewer cannot see or call; outsider gets 404", async () => {
  const id = await contact("Trig Perms");
  const run = await waitRun(id, "awaiting_approval");
  for (const k of ["agent", "viewer"]) {
    const p = people[k]!.page, a = api(p);
    await p.goto(`/w/${workspaceId}/settings/automations`);
    await expect(p.getByText("Only owners and admins can manage automations")).toBeVisible();
    await expect(p.getByRole("button", { name: /Approve run|Reject run|New rule/ })).toHaveCount(0);
    expect((await a.post(`${W}/automations/runs/${run.id}/approve`, {})).status()).toBe(403);
    expect((await a.post(`${W}/automations/runs/${run.id}/reject`, {})).status()).toBe(403);
    expect((await a.post(`${W}/automations/rules`, { name: "x", triggerType: "contact.created", actions: [{ type: "add_tag", tagName: "x" }] })).status()).toBe(403);
    expect((await a.patch(`${W}/automations/rules/${ruleId}`, { enabled: false })).status()).toBe(403);
    expect((await a.get(`${W}/automations/runs`)).status()).toBe(403);
  }
  const o = api(people.other!.page);
  for (const r of [await o.post(`${W}/automations/runs/${run.id}/approve`, {}), await o.post(`${W}/automations/runs/${run.id}/reject`, {}), await o.get(`${W}/automations/runs`), await o.patch(`${W}/automations/rules/${ruleId}`, { enabled: false })]) expect(r.status()).toBe(404);
  expect((await runsOf(id))[0]!.status).toBe("awaiting_approval"); // untouched by all of the above
  expect(await tags(id)).not.toContain(TAG);
});

test("kill switch: approve is blocked, new triggers create no run, resume restores", async () => {
  // the awaiting run from the permissions test is still open
  await open();
  await owner.getByRole("button", { name: "Pause all automations" }).click();
  await expect(owner.getByText("Automations are paused.")).toBeVisible();
  await expect(owner.getByRole("button", { name: /Approve run of/ })).toBeDisabled();
  const pending = ((await (await ownerA.get(`${W}/automations/runs?status=awaiting_approval`)).json()).items as Run[])[0]!;
  const blocked = await ownerA.post(`${W}/automations/runs/${pending.id}/approve`, {});
  expect(blocked.status()).toBe(409);
  expect(JSON.stringify(await blocked.json())).toContain("kill_switch_on");

  const id = await contact("Trig Paused");
  // A negative can only be shown over a window: 4 s is about four dispatcher ticks (1 s each); the event is consumed and dropped while paused.
  await owner.waitForTimeout(4_000);
  expect(await runsOf(id)).toHaveLength(0);
  await owner.getByRole("button", { name: "Resume automations" }).click();
  await expect(owner.getByRole("button", { name: "Pause all automations" })).toBeVisible();
  expect(await runsOf(id)).toHaveLength(0); // the paused trigger is not replayed after resume
  await owner.getByRole("button", { name: `Reject run of ${RULE}` }).click(); // clean up the open run
  await expect(owner.getByRole("button", { name: /Approve run of/ })).toHaveCount(0);
});

test("idempotency: approving twice executes once", async () => {
  const id = await contact("Trig Twice");
  const run = await waitRun(id, "awaiting_approval");
  const [a, b] = await Promise.all([ownerA.post(`${W}/automations/runs/${run.id}/approve`, {}), ownerA.post(`${W}/automations/runs/${run.id}/approve`, {})]);
  expect([a.status(), b.status()].sort()).toEqual([200, 409]);
  const done = await waitRun(id, "succeeded");
  expect((await ownerA.post(`${W}/automations/runs/${run.id}/approve`, {})).status()).toBe(409);
  expect((await ownerA.post(`${W}/automations/runs/${run.id}/reject`, {})).status()).toBe(409);
  await expect.poll(() => taskCount(id), { timeout: 3_000, intervals: [1000] }).toBe(1);
  expect(done.steps).toHaveLength(2);
  expect(await tags(id)).toEqual([TAG]);
  await open();
  await expect(owner.getByText("Succeeded", { exact: true }).first()).toBeVisible();
  await expect(owner.getByRole("button", { name: /Approve run of/ })).toHaveCount(0);
});
