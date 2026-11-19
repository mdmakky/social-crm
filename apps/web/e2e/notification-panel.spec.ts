import AxeBuilder from "@axe-core/playwright";
import { devices, expect, test, type Page } from "@playwright/test";
import { api, signUpAndCreate } from "./helpers";

// The bell opens a panel in place (tasks on the left, updates on the right); a reminder really arrives; the follow-up picker sets one.
const MIN = 60_000;
const at = (min: number) => new Date(Date.now() + min * MIN).toISOString();
const bell = (p: Page) => p.getByRole("button", { name: /^Notifications/ });
const panel = (p: Page) => p.getByRole("dialog", { name: "Notifications" });
const post = (p: Page, w: string, body: Record<string, unknown>) => api(p).post(`/v1/workspaces/${w}/tasks`, body);

test("the bell opens a panel instead of navigating; tasks can be finished and snoozed from it", async ({ page }) => {
  test.setTimeout(120_000);
  const { workspaceId } = await signUpAndCreate(page, "Panel Tasks", "Panel Tasks Co");
  await post(page, workspaceId, { title: "Call MRB Tours", dueAt: at(48) });
  await post(page, workspaceId, { title: "Send the quote", dueAt: at(-120) });
  await post(page, workspaceId, { title: "Plan next month", dueAt: at(3 * 1440) });
  await page.goto(`/w/${workspaceId}`);
  const url = page.url();
  await bell(page).click();
  await expect(panel(page)).toBeVisible();
  expect(page.url()).toBe(url);
  const tasks = panel(page).getByTestId("panel-task");
  await expect(tasks).toHaveCount(3);
  await expect(panel(page).getByRole("region", { name: "Today" })).toContainText("Send the quote");
  await expect(panel(page).getByRole("region", { name: "Upcoming" })).toContainText("Plan next month");
  await expect(tasks.filter({ hasText: "Send the quote" })).toContainText("Overdue");

  await tasks.filter({ hasText: "Call MRB Tours" }).getByRole("button", { name: "Done" }).click();
  await expect(tasks).toHaveCount(2);
  await panel(page).getByRole("button", { name: "Undo" }).click();
  await expect(tasks).toHaveCount(3);

  const quote = tasks.filter({ hasText: "Send the quote" });
  await quote.getByRole("button", { name: "Snooze" }).click();
  await quote.getByRole("group", { name: "Snooze for" }).getByRole("button", { name: "1 hour" }).click();
  await expect(quote).toContainText("in 1 h");

  await panel(page).getByRole("link", { name: "View all notifications" }).click();
  await expect(page).toHaveURL(new RegExp(`/w/${workspaceId}/notifications$`));
  await expect(page.getByRole("heading", { level: 1, name: "Notifications" })).toBeVisible();
  await bell(page).click();
  await page.keyboard.press("Escape");
  await expect(panel(page)).toBeHidden();
  await expect(bell(page)).toBeFocused();
});

test("a task reminder arrives as an update, with the right filter", async ({ page }) => {
  test.setTimeout(120_000);
  const { workspaceId } = await signUpAndCreate(page, "Panel Remind", "Panel Remind Co");
  await post(page, workspaceId, { title: "Follow up: Rafiq", dueAt: at(10), remindAt: at(-1) });
  await expect.poll(async () => (await (await api(page).get(`/v1/workspaces/${workspaceId}/notifications/unread-count`)).json()).count, { timeout: 30_000 }).toBeGreaterThanOrEqual(1);
  await page.goto(`/w/${workspaceId}`);
  await bell(page).click();
  const updates = panel(page).getByTestId("panel-update");
  await expect(updates.filter({ hasText: "Reminder: Follow up: Rafiq" })).toHaveCount(1);
  await expect(updates.filter({ hasText: "Reminder: Follow up: Rafiq" })).toHaveAttribute("data-unread", "true");
  await panel(page).getByRole("group", { name: "Filter updates" }).getByRole("button", { name: /^Leads/ }).click();
  await expect(updates).toHaveCount(0);
  await panel(page).getByRole("group", { name: "Filter updates" }).getByRole("button", { name: /^Reminders/ }).click();
  await expect(updates).toHaveCount(1);
  await panel(page).getByRole("button", { name: "Mark all read" }).click();
  await expect(updates.first()).toHaveAttribute("data-unread", "false");
  await expect(page.getByTestId("unread-badge")).toHaveCount(0);
});

test("finishing a task with a follow-up saves the chosen time and reminder", async ({ page }) => {
  test.setTimeout(120_000);
  const { workspaceId } = await signUpAndCreate(page, "Panel Follow", "Panel Follow Co");
  await post(page, workspaceId, { title: "Call about the quote", dueAt: at(60) });
  await page.goto(`/w/${workspaceId}/tasks`);
  await page.getByRole("list", { name: "Tasks", exact: true }).getByRole("button").filter({ hasText: /Call about the quote/ }).first().click();
  const p = page.getByRole("region", { name: "Task detail" });
  await p.getByRole("group", { name: "Day" }).getByRole("button").nth(2).click();
  await p.getByRole("button", { name: "Other time" }).click();
  await expect(p.getByTestId("follow-up-time-grid")).toBeVisible();
  await p.getByRole("group", { name: "Hour" }).getByRole("button", { name: "3", exact: true }).click();
  await p.getByRole("group", { name: "Minute" }).getByRole("button", { name: "45" }).click();
  await p.getByRole("group", { name: "AM or PM" }).getByRole("button", { name: "PM" }).click();
  await p.getByRole("group", { name: "When to remind" }).getByRole("button", { name: "1 hour before" }).click();
  await expect(p).toContainText("3:45 PM");
  await expect(p).toContainText("You will get a notification");
  await p.getByRole("button", { name: "More" }).click();
  await expect(p.getByTestId("follow-up-calendar")).toBeVisible();
  await p.getByTestId("follow-up-calendar").getByRole("button", { name: /^Next month$/ }).click();
  await p.getByTestId("follow-up-calendar").getByRole("button", { name: /15/ }).first().click();
  await p.getByRole("button", { name: "Mark done" }).click();
  await expect(page.getByText(/Follow up: Call about the quote/).first()).toBeVisible();
  const list = await (await api(page).get(`/v1/workspaces/${workspaceId}/tasks?status=open&limit=20`)).json();
  const fu = list.items.find((t: { title: string }) => t.title === "Follow up: Call about the quote");
  expect(fu.dueAt).toBeTruthy();
  const due = new Date(fu.dueAt);
  expect([due.getHours(), due.getMinutes()]).toEqual([15, 45]);
  expect(due.getDate()).toBe(15);
  expect(new Date(fu.dueAt).getTime() - new Date(fu.remindAt).getTime()).toBe(60 * MIN);
});

const { defaultBrowserType: _browser, ...pixel7 } = devices["Pixel 7"];
test.describe("phone", () => {
  test.use(pixel7);
  test("the panel is a bottom sheet with tabs and 44px targets, and passes axe", async ({ page }) => {
    test.setTimeout(120_000);
    const { workspaceId } = await signUpAndCreate(page, "Panel Phone", "Panel Phone Co");
    await post(page, workspaceId, { title: "Call MRB Tours", dueAt: at(48) });
    await page.goto(`/w/${workspaceId}`);
    await bell(page).click();
    const sheet = panel(page);
    await expect(sheet).toBeVisible();
    const box = (await sheet.boundingBox())!;
    expect(box.width).toBeGreaterThanOrEqual(page.viewportSize()!.width - 1);
    await expect(sheet.getByRole("tab", { name: /^My tasks/ })).toHaveAttribute("aria-selected", "true");
    await expect(sheet.getByTestId("panel-task")).toHaveCount(1);
    await sheet.getByRole("tab", { name: /^Updates/ }).click();
    await expect(sheet.getByTestId("panel-task")).toBeHidden();
    await sheet.getByRole("tab", { name: /^My tasks/ }).click();
    for (const name of ["Done", "Snooze", "Close", "Mark all read"]) {
      const b = (await sheet.getByRole("button", { name, exact: true }).first().boundingBox())!;
      expect(b.height, name).toBeGreaterThanOrEqual(44);
    }
    const r = await new AxeBuilder({ page }).include('[role="dialog"]').withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
    expect(r.violations.map((v) => `${v.id} ${JSON.stringify(v.nodes[0]?.target)}`)).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  });
});
