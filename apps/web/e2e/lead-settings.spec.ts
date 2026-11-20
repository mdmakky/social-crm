import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { addMemberByEmail, register, seedContacts, signUpAndCreate } from "./helpers";

const axe = async (page: Page, label: string) => {
  const r = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
  expect(r.violations.filter((v) => v.impact === "critical" || v.impact === "serious").map((v) => `${label}: ${v.id} ${JSON.stringify(v.nodes.map((n) => n.html.slice(0, 160)))}`)).toEqual([]);
};
const err500 = { status: 500, contentType: "application/json", body: "{}" };
const tabs = (page: Page) => page.getByRole("navigation", { name: "Lead settings tabs" });

test.describe("Lead settings", () => {
  test("tabs are links with deep links, old URLs redirect, no lifecycle anywhere", async ({ page }) => {
    const { workspaceId } = await signUpAndCreate(page, "Tabs Owner", "Tabs Co");
    const base = `/w/${workspaceId}/settings`;
    await page.goto(`${base}/leads`);
    await expect(page.getByRole("heading", { level: 1, name: "Lead settings" })).toBeVisible();
    await expect(page.getByText("Stages, fields and tags for your leads.")).toBeVisible();
    await expect(tabs(page).getByRole("link", { name: /^Stages/ })).toHaveAttribute("aria-current", "page");
    await page.goto(`${base}/leads?tab=fields`);
    await expect(tabs(page).getByRole("link", { name: /^Fields/ })).toHaveAttribute("aria-current", "page");
    await tabs(page).getByRole("link", { name: /^Tags/ }).click();
    await expect(page).toHaveURL(/tab=tags$/);
    await expect(page.getByRole("heading", { name: "Tags", level: 2 })).toBeVisible();
    await page.goBack();
    await expect(page).toHaveURL(/tab=fields$/);
    await page.goto(`${base}/contacts`);
    await expect(page).toHaveURL(/\/settings\/leads\?tab=fields$/);
    await page.goto(`${base}/pipelines`);
    await expect(page).toHaveURL(/\/settings\/leads\?tab=stages$/);
    for (const t of ["stages", "fields", "tags"]) {
      await page.goto(`${base}/leads?tab=${t}`);
      await expect(page.getByRole("heading", { level: 1, name: "Lead settings" })).toBeVisible();
      await expect(page.locator("main").getByText(/lifecycle/i)).toHaveCount(0);
    }
    await expect(page.getByRole("navigation", { name: "Settings sections" }).getByRole("link", { name: "Lead settings" })).toHaveAttribute("aria-current", "page");
  });

  test("fields: add, archive, restore", async ({ page }) => {
    const { workspaceId } = await signUpAndCreate(page, "Field Owner", "Field Co");
    await page.goto(`/w/${workspaceId}/settings/leads?tab=fields`);
    await expect(page.getByText("No custom fields yet.")).toBeVisible();
    await expect(page.getByLabel("Label")).toHaveCount(0); // never an always-open form
    await page.getByRole("button", { name: "Add a field" }).click();
    await page.getByLabel("Label").fill("Budget range");
    await page.getByText("Advanced").click();
    await expect(page.getByLabel("Key")).toHaveValue("budget_range");
    await page.getByRole("button", { name: "Add field", exact: true }).click();
    const row = page.getByRole("listitem").filter({ hasText: "Budget range" });
    await expect(row).toBeVisible();
    await row.getByRole("button", { name: "More actions for Budget range" }).click();
    await page.getByRole("menuitem", { name: "Archive" }).click();
    await expect(row.getByText("Archived")).toBeVisible();
    await expect(page.getByText(/Archiving hides it from forms and keeps the data/)).toBeVisible();
    await row.getByRole("button", { name: "More actions for Budget range" }).click();
    await page.getByRole("menuitem", { name: "Restore" }).click();
    await expect(row.getByText("Archived")).toHaveCount(0);
    await expect(page.getByRole("menu")).toHaveCount(0);
    await axe(page, "fields");
    await page.setViewportSize({ width: 375, height: 800 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  });

  test("tags: add, recolor inline, delete asks first and failures stay in the dialog", async ({ page }) => {
    const { workspaceId } = await signUpAndCreate(page, "Tag Owner", "Tag Co");
    const [id] = await seedContacts(page, workspaceId, [{ name: "Tagged" }]);
    await page.goto(`/w/${workspaceId}/contacts/${id}`);
    await page.getByLabel("Add a tag").fill("Hot");
    await page.getByRole("button", { name: "Add", exact: true }).click();
    await expect(page.getByRole("list", { name: "Tags on this lead" }).getByText("Hot")).toBeVisible();
    await page.goto(`/w/${workspaceId}/settings/leads?tab=tags`);
    await page.getByRole("button", { name: "Add a tag" }).click();
    await page.getByLabel("Tag name").fill("VIP");
    await page.getByRole("radiogroup", { name: "Tag color" }).getByText("Amber").click();
    await page.getByRole("button", { name: "Add tag", exact: true }).click();
    await expect(page.getByRole("listitem").filter({ hasText: "VIP" })).toBeVisible();
    await page.getByRole("button", { name: "More actions for VIP" }).click();
    await page.getByRole("menuitem", { name: /Rename or change color/ }).click();
    await page.getByRole("radiogroup", { name: "Tag color" }).getByText("Green").click();
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByRole("listitem").filter({ hasText: "VIP" }).getByRole("button", { name: "More actions for VIP" })).toBeVisible();
    await axe(page, "tags");
    page.on("dialog", () => { throw new Error("native dialog used"); });
    await page.getByRole("button", { name: "More actions for Hot" }).click();
    await page.getByRole("menuitem", { name: "Delete" }).click();
    const dialog = page.getByRole("dialog", { name: "Delete Hot?" });
    await expect(dialog).toContainText("It will be removed from 1 lead.");
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(page.getByText("Hot", { exact: true })).toBeVisible();
    await page.route("**/tags/*", (r) => (r.request().method() === "DELETE" ? r.fulfill(err500) : r.continue()));
    await page.getByRole("button", { name: "More actions for Hot" }).click();
    await page.getByRole("menuitem", { name: "Delete" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Delete tag" }).click();
    await expect(page.getByRole("dialog").getByRole("alert")).toContainText("Something went wrong");
  });

  test("an agent sees the read-only note and no change controls", async ({ page, browser }) => {
    const { workspaceId } = await signUpAndCreate(page, "RO Owner", "RO Co");
    const ctx = await browser.newContext();
    const agent = await ctx.newPage();
    const email = await register(agent, "Sam Agent");
    await addMemberByEmail(workspaceId, email, "agent");
    await agent.goto(`/w/${workspaceId}/settings/leads?tab=stages`);
    await expect(agent.getByText(/Only owners and admins can change pipelines/)).toBeVisible();
    await expect(agent.getByRole("button", { name: "New pipeline" })).toHaveCount(0);
    for (const t of ["fields", "tags"]) {
      await agent.goto(`/w/${workspaceId}/settings/leads?tab=${t}`);
      await expect(agent.getByText("Only owners and admins can change these settings.")).toBeVisible();
      await expect(agent.getByRole("button", { name: /^Add a (field|tag)$/ })).toHaveCount(0);
    }
    await ctx.close();
  });

  test("no horizontal overflow at 375, 768 and 1440 on any tab", async ({ page }) => {
    const { workspaceId } = await signUpAndCreate(page, "Wide Owner", "Wide Co");
    for (const width of [375, 768, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      for (const t of ["stages", "fields", "tags"]) {
        await page.goto(`/w/${workspaceId}/settings/leads?tab=${t}`);
        await expect(page.getByRole("heading", { level: 1, name: "Lead settings" })).toBeVisible();
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), `${width} ${t}`).toBe(true);
      }
    }
  });
});
