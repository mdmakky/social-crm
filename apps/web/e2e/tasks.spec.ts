import { expect, test, type Browser, type Page } from "@playwright/test";
import { addMemberByEmail, api, register, seedContacts, signUpAndCreate } from "./helpers";

const DAY = 86_400_000;
const inDays = (d: number) => new Date(Date.now() + d * DAY).toISOString();
const localInput = (d: number) => {
  const x = new Date(Date.now() + d * DAY);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${x.getFullYear()}-${p(x.getMonth() + 1)}-${p(x.getDate())}T10:00`;
};
const ws = (id: string, path = "") => `/v1/workspaces/${id}${path}`;
async function seedTask(page: Page, workspaceId: string, body: Record<string, unknown>) {
  const r = await api(page).post(ws(workspaceId, "/tasks"), body);
  if (r.status() !== 201) throw new Error(`seed task failed: ${r.status()} ${await r.text()}`);
  return (await r.json()) as { id: string; version: number };
}
const rowOf = (page: Page, title: string) => page.getByRole("row", { name: new RegExp(title) });
const tab = (page: Page, name: string) => page.getByRole("group", { name: "Task views" }).getByRole("button", { name: new RegExp(`^${name}`) });

test("create, edit, complete, reopen and see the history; the task shows on its contact", async ({ page }) => {
  test.setTimeout(120_000);
  const { workspaceId } = await signUpAndCreate(page, "Olive Owner", "Tasks Co");
  const [contactId] = await seedContacts(page, workspaceId, [{ name: "Ana Costa", email: "ana@example.com" }]);
  await page.goto(`/w/${workspaceId}/tasks`);
  await expect(page.getByRole("heading", { level: 1, name: "Tasks" })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Main" }).first().getByRole("link", { name: "Tasks" })).toBeVisible();
  await expect(page.getByText("No open tasks")).toBeVisible();

  // create
  await page.getByRole("button", { name: "New task" }).first().click();
  const dlg = page.getByRole("dialog", { name: "New task" });
  await dlg.getByRole("button", { name: "Create task" }).click();
  await expect(dlg.getByText("Give the task a title.")).toBeVisible();
  await dlg.getByLabel("Title").fill("Send the revised quote");
  await dlg.getByLabel("Description").fill("Include onboarding and training for twelve people.");
  await dlg.getByLabel("Priority").selectOption("high");
  await dlg.getByLabel("Due").fill(localInput(5));
  await dlg.getByPlaceholder("Search contacts by name, email or phone").fill("Ana");
  await dlg.getByRole("option", { name: /Ana Costa/ }).click();
  await dlg.getByRole("button", { name: "Create task" }).click();
  await expect(dlg).toBeHidden();
  await expect(page.getByRole("status").filter({ hasText: "Saved: Send the revised quote" })).toBeVisible();
  const row = rowOf(page, "Send the revised quote");
  await expect(row).toContainText("High");
  await expect(row).toContainText("Ana Costa");
  await expect(row).toContainText("Olive Owner");
  await expect(tab(page, "Open")).toContainText("1");

  // complete with the keyboard, undo, complete again
  const box = page.getByRole("checkbox", { name: "Mark done: Send the revised quote" });
  await box.focus();
  await page.keyboard.press("Space");
  await expect(page.getByText("Marked done: Send the revised quote")).toBeVisible();
  await expect(page.getByText("No open tasks")).toBeVisible();
  await page.getByRole("button", { name: "Undo" }).click();
  await expect(page.getByText("Restored: Send the revised quote")).toBeVisible();
  await expect(row).toBeVisible();
  await page.getByRole("checkbox", { name: "Mark done: Send the revised quote" }).click();
  await tab(page, "Completed").click();
  await expect(page).toHaveURL(/view=completed/);
  await expect(page.getByRole("checkbox", { name: "Reopen: Send the revised quote" })).toBeVisible();

  // detail and history
  await rowOf(page, "Send the revised quote").getByRole("button", { name: "Send the revised quote", exact: true }).click();
  const detail = page.getByRole("dialog", { name: "Send the revised quote" });
  await expect(detail.getByText("Done", { exact: true }).first()).toBeVisible();
  await expect(detail.getByRole("link", { name: "Ana Costa" })).toHaveAttribute("href", `/w/${workspaceId}/contacts/${contactId}`);
  const history = detail.getByRole("list", { name: /Task history/ });
  await expect(history.getByRole("listitem")).toHaveCount(4); // created, completed, reopened, completed
  await expect(history.getByRole("listitem").first()).toContainText("Olive Owner marked the task done");
  await expect(history.getByRole("listitem").last()).toContainText("Olive Owner created the task");

  // reopen from the detail, then edit
  await detail.getByRole("button", { name: "Reopen" }).click();
  await expect(history.getByRole("listitem").first()).toContainText("reopened the task");
  await detail.getByRole("button", { name: "Edit" }).click();
  const edit = page.getByRole("dialog", { name: "Edit task" });
  await edit.getByLabel("Title").fill("Send the revised quote and schedule");
  await edit.getByLabel("Status").selectOption("in_progress");
  await edit.getByRole("button", { name: "Save changes" }).click();
  await expect(edit).toBeHidden();
  await tab(page, "Open").click();
  await expect(rowOf(page, "Send the revised quote and schedule")).toContainText("In progress");
  await rowOf(page, "Send the revised quote and schedule").getByRole("button", { name: "Send the revised quote and schedule", exact: true }).click();
  const again = page.getByRole("dialog", { name: "Send the revised quote and schedule" });
  await expect(again.getByRole("list", { name: /Task history/ })).toContainText("edited the title");
  await expect(again.getByRole("list", { name: /Task history/ })).toContainText("changed the status from Open to In progress");
  await page.keyboard.press("Escape");

  // the contact page shows the task and its timeline
  await page.goto(`/w/${workspaceId}/contacts/${contactId}`);
  await expect(page.getByText("Send the revised quote and schedule")).toBeVisible();
  await expect(page.getByText(/completed the task "Send the revised quote"/).first()).toBeVisible();
  await expect(page.getByText(/reopened the task/).first()).toBeVisible();

  // delete
  await page.goto(`/w/${workspaceId}/tasks`);
  await rowOf(page, "Send the revised quote and schedule").getByRole("button", { name: "Send the revised quote and schedule", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Delete" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Delete" }).click();
  await expect(page.getByText("No open tasks")).toBeVisible();
});

test("a task created on a contact page appears in the workspace list, and a stale edit is caught", async ({ page }) => {
  const { workspaceId } = await signUpAndCreate(page, "Nora Owner", "Contact Link Co");
  const [contactId] = await seedContacts(page, workspaceId, [{ name: "Ben Okafor" }]);
  await api(page).post(ws(workspaceId, `/contacts/${contactId}/tasks`), { title: "Call Ben about the invoice", dueAt: inDays(2) });
  await page.goto(`/w/${workspaceId}/tasks`);
  await expect(rowOf(page, "Call Ben about the invoice")).toContainText("Ben Okafor");

  // someone else edits while this dialog is open
  await rowOf(page, "Call Ben about the invoice").getByRole("button", { name: "Call Ben about the invoice", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Edit" }).click();
  const edit = page.getByRole("dialog", { name: "Edit task" });
  const id = (await (await api(page).get(ws(workspaceId, `/contacts/${contactId}/tasks`))).json())[0].id as string;
  await api(page).patch(ws(workspaceId, `/tasks/${id}`), { priority: "urgent" });
  await edit.getByLabel("Title").fill("Call Ben about the unpaid invoice");
  await edit.getByRole("button", { name: "Save changes" }).click();
  await expect(edit.getByText("Someone else changed this task while you were editing.")).toBeVisible();
  await edit.getByRole("button", { name: "Load the latest version" }).click();
  await expect(edit.getByLabel("Priority")).toHaveValue("urgent");
  await edit.getByLabel("Title").fill("Call Ben about the unpaid invoice");
  await edit.getByRole("button", { name: "Save changes" }).click();
  await expect(edit).toBeHidden();
  await expect(rowOf(page, "Call Ben about the unpaid invoice")).toContainText("Urgent");
});

test("views, counts, filters, sorting, paging and a shareable URL", async ({ page }) => {
  test.setTimeout(150_000);
  const { workspaceId } = await signUpAndCreate(page, "Fran Filter", "Filter Co");
  const [ana, ben] = await seedContacts(page, workspaceId, [{ name: "Ana Costa" }, { name: "Ben Okafor" }]);
  await seedTask(page, workspaceId, { title: "Chase the late payment", dueAt: inDays(-2), priority: "urgent", assigneeUserId: null, contactId: ana });
  await seedTask(page, workspaceId, { title: "Prepare the renewal deck", dueAt: inDays(3), priority: "high", contactId: ben });
  await seedTask(page, workspaceId, { title: "Tidy the shared inbox", priority: "low", assigneeUserId: null });
  const done = await seedTask(page, workspaceId, { title: "Book the venue", dueAt: inDays(1) });
  await api(page).patch(ws(workspaceId, `/tasks/${done.id}`), { status: "done" });

  await page.goto(`/w/${workspaceId}/tasks`);
  await expect(tab(page, "Open")).toContainText("3");
  await expect(tab(page, "Overdue")).toContainText("1");
  await expect(tab(page, "Upcoming")).toContainText("1");
  await expect(tab(page, "No date")).toContainText("1");
  await expect(tab(page, "Completed")).toContainText("1");
  await expect(page.getByRole("row")).toHaveCount(4); // header + 3

  // views
  await tab(page, "Overdue").click();
  await expect(rowOf(page, "Chase the late payment")).toContainText("Overdue");
  await expect(page.getByRole("row")).toHaveCount(2);
  await tab(page, "Upcoming").click();
  await expect(rowOf(page, "Prepare the renewal deck")).toBeVisible();
  await expect(page.getByRole("row")).toHaveCount(2);
  await tab(page, "No date").click();
  await expect(rowOf(page, "Tidy the shared inbox")).toBeVisible();
  await tab(page, "Completed").click();
  await expect(rowOf(page, "Book the venue")).toBeVisible();
  await expect(page.getByRole("row")).toHaveCount(2);
  await tab(page, "Open").click();

  // filters
  await page.getByLabel("Search tasks").fill("renewal");
  await expect(page.getByRole("row")).toHaveCount(2);
  await page.getByLabel("Search tasks").fill("");
  await page.getByLabel("Assignee", { exact: true }).selectOption("unassigned");
  await expect(page.getByRole("row")).toHaveCount(3);
  await page.getByLabel("Assignee", { exact: true }).selectOption("me");
  await expect(page.getByRole("row")).toHaveCount(2); // the renewal deck (default assignee: creator)
  await expect(rowOf(page, "Prepare the renewal deck")).toBeVisible();
  await page.getByLabel("Assignee", { exact: true }).selectOption("");
  await page.getByLabel("Priority", { exact: true }).selectOption("urgent");
  await expect(rowOf(page, "Chase the late payment")).toBeVisible();
  await expect(page.getByRole("row")).toHaveCount(2);
  await page.getByLabel("Priority", { exact: true }).selectOption("");
  await page.getByLabel("Status", { exact: true }).selectOption("any");
  await expect(page.getByRole("row")).toHaveCount(5);
  await page.getByLabel("Status", { exact: true }).selectOption("");
  await page.getByLabel("Filter by contact").fill("Ben");
  await page.getByRole("option", { name: /Ben Okafor/ }).click();
  await expect(page.getByRole("row")).toHaveCount(2);
  await expect(rowOf(page, "Prepare the renewal deck")).toBeVisible();
  await page.getByRole("button", { name: "Remove contact Ben Okafor" }).click();
  await page.getByLabel("Search tasks").fill("nothing matches this");
  await expect(page.getByText("No tasks match these filters")).toBeVisible();
  await page.getByRole("button", { name: "Clear filters" }).click();
  await expect(page.getByRole("row")).toHaveCount(4);

  // due range
  await page.getByLabel("Due from").fill(localInput(2).slice(0, 10));
  await expect(page.getByRole("row")).toHaveCount(2);
  await expect(rowOf(page, "Prepare the renewal deck")).toBeVisible();
  await page.getByRole("button", { name: "Clear" }).click();

  // sorting
  const titles = () => page.locator("tbody tr td:nth-child(2) > button").allInnerTexts();
  await page.getByLabel("Sort by").selectOption("priority:desc");
  await expect.poll(async () => (await titles())[0]).toContain("Chase the late payment");
  await page.getByLabel("Sort by").selectOption("priority:asc");
  await expect.poll(async () => (await titles())[0]).toContain("Tidy the shared inbox");
  await page.getByLabel("Sort by").selectOption("due:asc");
  await expect.poll(async () => (await titles())[0]).toContain("Chase the late payment");
  await expect.poll(async () => (await titles()).at(-1)).toContain("Tidy the shared inbox"); // no date sorts last

  // URL is shareable
  await tab(page, "Overdue").click();
  await expect(page).toHaveURL(/view=overdue/);
  await page.reload();
  await expect(tab(page, "Overdue")).toHaveAttribute("aria-pressed", "true");
  await expect(rowOf(page, "Chase the late payment")).toBeVisible();
});

test("paging: 25 at a time, then Load more", async ({ page }) => {
  test.setTimeout(150_000);
  const { workspaceId } = await signUpAndCreate(page, "Paige Pager", "Paging Co");
  for (let i = 0; i < 28; i++) await seedTask(page, workspaceId, { title: `Task number ${String(i).padStart(2, "0")}`, dueAt: inDays(i + 1) });
  await page.goto(`/w/${workspaceId}/tasks`);
  await expect(page.getByText("Showing 25 of 28")).toBeVisible();
  await page.getByRole("button", { name: "Load more" }).click();
  await expect(page.getByText("Showing 28 of 28")).toBeVisible();
  await expect(page.getByRole("button", { name: "Load more" })).toHaveCount(0);
});

test("errors are shown with a way to retry", async ({ page }) => {
  const { workspaceId } = await signUpAndCreate(page, "Erin Error", "Error Co");
  await seedTask(page, workspaceId, { title: "Existing task" });
  await page.goto(`/w/${workspaceId}/tasks`);
  await page.route(/\/v1\/workspaces\/[^/]+\/tasks\?/, (r) => r.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: { code: "internal", message: "boom" } }) }));
  await page.getByLabel("Search tasks").fill("zzz");
  await expect(page.getByText("Tasks could not be loaded").or(page.getByRole("alert")).first()).toBeVisible();
  await page.unroute(/\/v1\/workspaces\/[^/]+\/tasks\?/);
  await page.getByLabel("Search tasks").fill("");
  await expect(rowOf(page, "Existing task")).toBeVisible();
});

async function newUser(browser: Browser, name: string) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const email = await register(page, name);
  return { ctx, page, email };
}

test("permissions per role: viewers read only, agents change only their own, owners and admins everything", async ({ page, browser }) => {
  test.setTimeout(180_000);
  const { workspaceId } = await signUpAndCreate(page, "Olive Owner", "Perm Tasks Co");
  const admin = await newUser(browser, "Dana Admin");
  const agent = await newUser(browser, "Sam Agent");
  const viewer = await newUser(browser, "Vic Viewer");
  await addMemberByEmail(workspaceId, admin.email, "admin");
  await addMemberByEmail(workspaceId, agent.email, "agent");
  await addMemberByEmail(workspaceId, viewer.email, "viewer");
  const members = (await (await api(page).get(ws(workspaceId, "/members"))).json()) as { userId: string; email: string }[];
  const agentId = members.find((m) => m.email === agent.email)!.userId;
  const adminId = members.find((m) => m.email === admin.email)!.userId;
  await seedTask(page, workspaceId, { title: "Assigned to Sam", assigneeUserId: agentId });
  await seedTask(page, workspaceId, { title: "Owner only follow up", assigneeUserId: adminId });

  // viewer: sees everything, changes nothing
  await viewer.page.goto(`/w/${workspaceId}/tasks`);
  await expect(rowOf(viewer.page, "Assigned to Sam")).toBeVisible();
  await expect(viewer.page.getByRole("button", { name: "New task" })).toHaveCount(0);
  await expect(viewer.page.getByRole("checkbox", { name: "Mark done: Assigned to Sam" })).toHaveAttribute("aria-disabled", "true");
  await rowOf(viewer.page, "Assigned to Sam").getByRole("button", { name: "Assigned to Sam", exact: true }).click();
  const vd = viewer.page.getByRole("dialog", { name: "Assigned to Sam" });
  await expect(vd.getByText(/You can view this task but not change it/)).toBeVisible();
  await expect(vd.getByRole("button", { name: "Edit" })).toHaveCount(0);
  await expect(vd.getByRole("list", { name: /Task history/ })).toBeVisible(); // history is readable
  const id = (await (await api(page).get(ws(workspaceId, "/tasks?search=Assigned"))).json()).items[0].id as string;
  expect((await api(viewer.page).patch(ws(workspaceId, `/tasks/${id}`), { status: "done" })).status()).toBe(403);

  // agent: own task yes, someone else's no
  await agent.page.goto(`/w/${workspaceId}/tasks`);
  await expect(agent.page.getByRole("button", { name: "New task" })).toBeVisible();
  await expect(agent.page.getByRole("checkbox", { name: "Mark done: Assigned to Sam" })).toHaveAttribute("aria-disabled", "false");
  await expect(agent.page.getByRole("checkbox", { name: "Mark done: Owner only follow up" })).toHaveAttribute("aria-disabled", "true");
  await rowOf(agent.page, "Owner only follow up").getByRole("button", { name: "Owner only follow up", exact: true }).click();
  await expect(agent.page.getByRole("dialog").getByText(/You can view this task but not change it/)).toBeVisible();
  await agent.page.keyboard.press("Escape");
  await agent.page.getByRole("checkbox", { name: "Mark done: Assigned to Sam" }).click();
  await expect(agent.page.getByText("Marked done: Assigned to Sam")).toBeVisible();
  await agent.page.getByRole("button", { name: "New task" }).click();
  await agent.page.getByRole("dialog").getByLabel("Title").fill("Sam's own task");
  await agent.page.getByRole("dialog").getByRole("button", { name: "Create task" }).click();
  await expect(rowOf(agent.page, "Sam's own task")).toBeVisible();
  await expect(rowOf(agent.page, "Sam's own task")).toContainText("Sam Agent");

  // admin and owner change anything
  await admin.page.goto(`/w/${workspaceId}/tasks`);
  await expect(admin.page.getByRole("checkbox", { name: "Mark done: Sam's own task" })).toHaveAttribute("aria-disabled", "false");
  await admin.page.getByRole("checkbox", { name: "Mark done: Sam's own task" }).click();
  await expect(admin.page.getByText("Marked done: Sam's own task")).toBeVisible();
  await page.goto(`/w/${workspaceId}/tasks`);
  await expect(page.getByRole("checkbox", { name: "Mark done: Owner only follow up" })).toHaveAttribute("aria-disabled", "false");

  // the history shows who did what
  await tab(page, "Completed").click();
  await rowOf(page, "Sam's own task").getByRole("button", { name: "Sam's own task", exact: true }).click();
  const hist = page.getByRole("dialog").getByRole("list", { name: /Task history/ });
  await expect(hist).toContainText("Dana Admin marked the task done");
  await expect(hist).toContainText("Sam Agent created the task");
});
