import AxeBuilder from "@axe-core/playwright";
import { devices, expect, test, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { api, seedContacts, signUpAndCreate } from "./helpers";

const SHOTS = (process.env.UPDATE_SCREENSHOTS ? join(__dirname, "../../../docs/design/screenshots/tasks") : join(__dirname, "../test-results/shots-tasks")) + "/";
mkdirSync(SHOTS, { recursive: true });
const SIZES = [{ name: "375", width: 375, height: 812 }, { name: "768", width: 768, height: 1024 }, { name: "1440", width: 1440, height: 900 }] as const;
const DAY = 86_400_000;
const inDays = (d: number) => new Date(Date.now() + d * DAY).toISOString();

const axe = async (page: Page, label: string) => {
  const r = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
  expect(r.violations.map((v) => `${label}: ${v.id} ${JSON.stringify(v.nodes[0]?.target)} ${v.nodes[0]?.html.slice(0, 100)}`)).toEqual([]);
};
const noPageOverflow = async (page: Page, label: string) => {
  const w = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }));
  expect(w.scroll, `${label}: page scrolls sideways`).toBeLessThanOrEqual(w.client);
  const clipped = await page.evaluate(() => Array.from(document.querySelectorAll<HTMLElement>(".overflow-x-auto:not([data-scroll=allowed])")).filter((e) => e.clientWidth > 0 && e.scrollWidth > e.clientWidth + 1).length);
  expect(clipped, `${label}: a container needs its own scrollbar`).toBe(0);
};

async function seed(page: Page, workspaceId: string) {
  const [ana, ben] = await seedContacts(page, workspaceId, [{ name: "Ana Costa", email: "ana@example.com" }, { name: "Ben Okafor-Thomasson" }]);
  const post = (body: Record<string, unknown>) => api(page).post(`/v1/workspaces/${workspaceId}/tasks`, body);
  await post({ title: "Send the revised quote and onboarding schedule to the whole Costa team", dueAt: inDays(-2), priority: "urgent", contactId: ana, description: "They asked for training for twelve people and a start date in January." });
  await post({ title: "Prepare the renewal deck", dueAt: inDays(3), priority: "high", contactId: ben });
  await post({ title: "Tidy the shared inbox", priority: "low", assigneeUserId: null });
  for (let i = 0; i < 4; i++) await post({ title: `Follow up with lead ${i + 1}`, dueAt: inDays(i + 1) });
  return ana;
}

test("tasks screens hold at 375, 768 and 1440: no overflow, no axe violations, purpose-built mobile layout", async ({ page }) => {
  test.setTimeout(240_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  const { workspaceId } = await signUpAndCreate(page, "Maya Okafor", "Northwind Studio");
  await page.goto(`/w/${workspaceId}/tasks`);
  await expect(page.getByText("No open tasks")).toBeVisible();
  for (const s of SIZES) {
    await page.setViewportSize({ width: s.width, height: s.height });
    await page.goto(`/w/${workspaceId}/tasks`);
    await expect(page.getByRole("heading", { level: 1, name: "Tasks" })).toBeVisible();
    await noPageOverflow(page, `empty@${s.name}`);
    await axe(page, `empty@${s.name}`);
    await page.screenshot({ path: `${SHOTS}empty-${s.name}.png` });
  }
  const ana = await seed(page, workspaceId);

  for (const s of SIZES) {
    await page.setViewportSize({ width: s.width, height: s.height });
    for (const [key, path] of [["list", ""], ["overdue", "?view=overdue"], ["completed", "?view=completed"], ["no-match", "?q=zzzz"]] as const) {
      await page.goto(`/w/${workspaceId}/tasks${path}`);
      await expect(page.getByRole("heading", { level: 1, name: "Tasks" })).toBeVisible();
      if (key !== "no-match" && key !== "completed") await expect(page.getByRole("button", { name: /^(Prepare the renewal deck|Send the revised quote)/ }).first()).toBeVisible();
      await noPageOverflow(page, `${key}@${s.name}`);
      await axe(page, `${key}@${s.name}`);
      await page.screenshot({ path: `${SHOTS}${key}-${s.name}.png`, fullPage: key === "list" });
    }
  }

  // phones get cards, desktops get the table
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto(`/w/${workspaceId}/tasks`);
  await expect(page.getByRole("table")).toBeHidden();
  await expect(page.getByRole("list", { name: "Tasks" })).toBeVisible();
  const card = page.getByRole("button", { name: /Send the revised quote/ }).first();
  expect((await card.boundingBox())!.height).toBeGreaterThanOrEqual(56);
  await expect(page.getByLabel("Assignee", { exact: true })).toBeHidden();
  await page.getByRole("button", { name: "Filters" }).click();
  await expect(page.getByLabel("Assignee", { exact: true })).toBeVisible();
  await axe(page, "filters-open@375");
  await page.screenshot({ path: `${SHOTS}filters-open-375.png` });
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(page.getByRole("table")).toBeVisible();
  await expect(page.getByRole("columnheader")).toHaveCount(6);

  // overlays at every size
  for (const s of SIZES) {
    await page.setViewportSize({ width: s.width, height: s.height });
    await page.goto(`/w/${workspaceId}/tasks`);
    await page.getByRole("button", { name: "New task" }).first().click();
    const dlg = page.getByRole("dialog", { name: "New task" });
    await dlg.getByPlaceholder("Search leads by name, email or phone").focus();
    await expect(dlg.getByRole("option", { name: /Ana Costa/ })).toBeVisible();
    await axe(page, `new-task-picker@${s.name}`);
    await page.screenshot({ path: `${SHOTS}new-task-${s.name}.png` });
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");
    await expect(dlg).toBeHidden();
    await page.getByRole("button", { name: /Send the revised quote/ }).first().click();
    const detail = page.getByRole("dialog", { name: /Send the revised quote/ });
    await expect(detail.getByRole("list", { name: /Task history/ })).toBeVisible();
    await axe(page, `task-detail@${s.name}`);
    await page.screenshot({ path: `${SHOTS}task-detail-${s.name}.png` });
    await detail.getByRole("button", { name: "Edit" }).click();
    await expect(page.getByRole("dialog", { name: "Edit task" })).toBeVisible();
    await axe(page, `edit-task@${s.name}`);
    if (s.name === "1440") await page.screenshot({ path: `${SHOTS}edit-task-${s.name}.png` });
    await page.keyboard.press("Escape");
  }
  void ana;
});

const { defaultBrowserType: _browser, ...pixel7 } = devices["Pixel 7"];
test.describe("touch", () => {
  test.use(pixel7);
  test("task controls are comfortable to tap", async ({ page }) => {
    test.setTimeout(120_000);
    const { workspaceId } = await signUpAndCreate(page, "Touch Tasks", "Touch Tasks Co");
    await seed(page, workspaceId);
    await page.goto(`/w/${workspaceId}/tasks`);
    for (const name of ["New task", "Filters"]) expect((await page.getByRole("button", { name, exact: name === "Filters" }).first().boundingBox())!.height, name).toBeGreaterThanOrEqual(44);
    for (const v of ["Open", "Overdue", "Upcoming", "No date", "Completed"]) expect((await page.getByRole("group", { name: "Task views" }).getByRole("button", { name: new RegExp(`^${v}`) }).boundingBox())!.height, v).toBeGreaterThanOrEqual(44);
    expect((await page.getByLabel("Search tasks").boundingBox())!.height).toBeGreaterThanOrEqual(44);
    expect(await page.getByLabel("Search tasks").evaluate((e) => getComputedStyle(e).fontSize)).toBe("16px");
    expect((await page.getByLabel("Sort by").boundingBox())!.height).toBeGreaterThanOrEqual(44);
    const check = await page.getByRole("checkbox", { name: /Mark done: Prepare the renewal deck/ }).boundingBox();
    expect(check!.height).toBeGreaterThanOrEqual(44);
    expect(check!.width).toBeGreaterThanOrEqual(44);
    await page.getByRole("button", { name: "Filters" }).click();
    for (const label of ["Assignee", "Priority"]) expect((await page.getByLabel(label, { exact: true }).boundingBox())!.height, label).toBeGreaterThanOrEqual(44);
    await page.getByRole("button", { name: "New task" }).first().click();
    const dlg = page.getByRole("dialog", { name: "New task" });
    await page.waitForTimeout(400); // let the open animation (a small scale) finish before measuring
    for (const label of ["Title", "Description", "Assignee", "Priority", "Due"]) expect((await dlg.getByLabel(label, { exact: true }).boundingBox())!.height, label).toBeGreaterThanOrEqual(44);
    expect((await dlg.getByPlaceholder("Search leads by name, email or phone").boundingBox())!.height).toBeGreaterThanOrEqual(44);
    expect((await dlg.getByRole("button", { name: "Create task" }).boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await dlg.getByPlaceholder("Search leads by name, email or phone").focus();
    await expect(dlg.getByRole("listbox", { name: "Matching leads" }).getByRole("option").first()).toBeVisible();
    const opt = await dlg.getByRole("listbox", { name: "Matching leads" }).getByRole("option").first().boundingBox();
    expect(opt!.height).toBeGreaterThanOrEqual(44);
  });
});
