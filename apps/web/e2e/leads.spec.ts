import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Browser, type Page } from "@playwright/test";
import { addMemberByEmail, api, register, seedContacts, signUpAndCreate } from "./helpers";

const ws = (id: string, path = "") => `/v1/workspaces/${id}${path}`;
async function newUser(browser: Browser, name: string) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const email = await register(page, name);
  return { ctx, page, email };
}
async function seedLead(page: Page, workspaceId: string, body: Record<string, unknown>) {
  const r = await api(page).post(ws(workspaceId, "/leads"), body);
  if (r.status() !== 201) throw new Error(`seed lead failed: ${r.status()} ${await r.text()}`);
  return (await r.json()) as { id: string; version: number };
}
const noOverflow = async (page: Page) => expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
const axe = async (page: Page) => expect((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze()).violations.map((v) => `${v.id}: ${v.nodes[0]?.target}`)).toEqual([]);

test("pipeline settings: add, rename, reorder with buttons, archive a stage with a move target", async ({ page }) => {
  test.setTimeout(120_000);
  const { workspaceId } = await signUpAndCreate(page, "Olive Owner", "Pipelines Co");
  await page.goto(`/w/${workspaceId}/settings/pipelines`);
  await expect(page.getByRole("heading", { level: 1, name: "Pipeline settings" })).toBeVisible();
  const stages = page.getByRole("list", { name: "Sales stages" });
  await expect(stages.getByRole("listitem")).toHaveCount(7);

  await page.getByRole("button", { name: "Add stage" }).click();
  await page.getByLabel("Stage name").fill("Demo");
  await page.getByLabel("Probability %").fill("55");
  await page.getByRole("button", { name: "Add", exact: true }).and(page.locator(":enabled")).click();
  await expect(page.getByRole("status").filter({ hasText: "Stage added." }).first()).toBeVisible();
  await expect(stages.getByRole("listitem").nth(5)).toContainText("Demo");

  await page.getByRole("button", { name: "Move Demo up" }).click();
  await expect(stages.getByRole("listitem").nth(4)).toContainText("Demo");
  await page.reload();
  await expect(page.getByRole("list", { name: "Sales stages" }).getByRole("listitem").nth(4)).toContainText("Demo"); // persisted

  await page.getByRole("button", { name: "Edit Demo" }).click();
  await page.getByLabel("Name of stage Demo").fill("Demo call");
  await page.getByRole("button", { name: "Save stage" }).click();
  await expect(stages.getByRole("listitem").nth(4)).toContainText("Demo call");

  await page.getByRole("button", { name: "Archive Demo call" }).click();
  const dlg = page.getByRole("dialog");
  await expect(dlg).toContainText("Leads in this stage move to the stage you choose");
  await dlg.getByRole("button", { name: "Archive stage" }).click();
  await expect(stages).toContainText("Archived");
  await expect(page.getByRole("button", { name: "Move Demo call up" })).toHaveCount(0);

  await page.getByRole("button", { name: "New pipeline" }).click();
  await page.getByRole("dialog").getByLabel("Name").fill("Inbound");
  await page.getByRole("dialog").getByLabel("Type").selectOption("lead");
  await page.getByRole("dialog").getByRole("button", { name: "Create pipeline" }).click();
  await expect(page.getByRole("heading", { name: "Inbound" })).toBeVisible();
  await page.getByRole("button", { name: "Archive pipeline Inbound" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Archive", exact: true }).click();
  await expect(page.getByRole("button", { name: /Show archived pipelines \(1\)/ })).toBeVisible();
});

test("lead lifecycle in the UI: create, filter, move, edit, lose with a reason, history", async ({ page }) => {
  test.setTimeout(150_000);
  const { workspaceId } = await signUpAndCreate(page, "Olive Owner", "Leads Co");
  await seedContacts(page, workspaceId, [{ name: "Ana Costa", email: "ana@example.com" }]);
  await page.goto(`/w/${workspaceId}/leads`);
  await expect(page.getByRole("heading", { level: 1, name: "Leads" })).toBeVisible();
  await expect(page.getByText("No open leads")).toBeVisible();

  await page.getByRole("button", { name: /New deal/ }).first().click();
  const dlg = page.getByRole("dialog");
  await dlg.getByLabel("Title").fill("Annual contract");
  await dlg.getByLabel("Primary contact").fill("Ana");
  await dlg.getByRole("option", { name: /Ana Costa/ }).click();
  await dlg.getByLabel("Value").fill("2,500.50");
  await dlg.getByRole("button", { name: "Create deal" }).click();

  await expect(page.getByRole("heading", { level: 1, name: "Annual contract" })).toBeVisible();
  await expect(page.getByText("$2,500.50")).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Stage" }).getByRole("button", { name: /^New/ })).toHaveAttribute("aria-current", "step");

  await page.getByRole("navigation", { name: "Stage" }).getByRole("button", { name: /^Qualified/ }).click();
  await expect(page.getByRole("navigation", { name: "Stage" }).getByRole("button", { name: /^Qualified/ })).toHaveAttribute("aria-current", "step");
  await expect(page.getByLabel("Stage history")).toContainText("New → Qualified");

  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await page.getByLabel("Probability (%)").fill("70");
  await page.getByRole("dialog").getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("Manual", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: /Reset to 40%/ }).click();
  await expect(page.getByText("Manual", { exact: true })).toHaveCount(0);

  await page.getByRole("button", { name: "Lost", exact: true }).click();
  await page.getByRole("dialog").getByLabel("Reason").selectOption({ label: "Timing" });
  await page.getByRole("dialog").getByRole("button", { name: "Mark as lost" }).click();
  await expect(page.getByText("Lost", { exact: true }).first()).toBeVisible();
  await expect(page.getByLabel("Stage history")).toContainText("Timing");

  await page.goto(`/w/${workspaceId}/leads`);
  await expect(page.getByText("No open leads")).toBeVisible(); // default filter is Open; the lost one is not listed
  await page.getByLabel("Status").selectOption("lost");
  await expect(page.getByRole("link", { name: "Annual contract" })).toBeVisible();
  await page.getByLabel("Search leads by title").fill("zzz");
  await expect(page.getByText("No leads match these filters")).toBeVisible();
  await page.getByRole("button", { name: "Clear filters" }).click();
  await expect(page.getByText("No open leads")).toBeVisible(); // back to the default Open filter
});

test("deal value is restricted for agents: not in the page, the API response or the list; a grant opens it", async ({ page, browser }) => {
  test.setTimeout(150_000);
  const { workspaceId } = await signUpAndCreate(page, "Olive Owner", "Value Co");
  const agent = await newUser(browser, "Sam Agent");
  await addMemberByEmail(workspaceId, agent.email, "agent");
  const [contactId] = await seedContacts(page, workspaceId, [{ name: "Ana Costa" }]);
  const lead = await seedLead(page, workspaceId, { title: "Secret deal", primaryContactId: contactId, valueMinor: 987654, currency: "USD" });

  await agent.page.goto(`/w/${workspaceId}/leads`);
  await expect(agent.page.getByRole("link", { name: "Secret deal" })).toBeVisible();
  await expect(agent.page.getByText("Hidden").first()).toBeVisible();
  await agent.page.goto(`/w/${workspaceId}/leads/${lead.id}`);
  await expect(agent.page.getByText("Restricted")).toBeVisible();
  expect(await agent.page.content()).not.toContain("9,876.54");
  expect(await agent.page.content()).not.toContain("987654");
  const raw = await agent.page.request.get(ws(workspaceId, `/leads/${lead.id}`));
  expect((await raw.json()).valueMinor).toBeNull();
  await expect(agent.page.getByText("Deal value access")).toHaveCount(0);

  await page.goto(`/w/${workspaceId}/leads/${lead.id}`);
  await expect(page.getByText("$9,876.54")).toBeVisible();
  await page.getByLabel("Grant access to").selectOption({ label: "Sam Agent" });
  await page.getByRole("button", { name: "Grant" }).click();
  await expect(page.getByRole("combobox", { name: "Access for Sam Agent" })).toBeVisible();
  await agent.page.reload();
  await expect(agent.page.getByText("$9,876.54")).toBeVisible();
});

test("responsive and accessible: list, detail and pipeline settings at 375, 768, 1024 and 1440", async ({ page }) => {
  test.setTimeout(180_000);
  const { workspaceId } = await signUpAndCreate(page, "Olive Owner", "Responsive Leads Co");
  const [contactId] = await seedContacts(page, workspaceId, [{ name: "Ana Costa" }]);
  const lead = await seedLead(page, workspaceId, { title: "Responsive deal with a rather long title to test wrapping on narrow screens", primaryContactId: contactId, valueMinor: 100000, currency: "USD" });
  for (const width of [375, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    for (const path of ["/leads", `/leads/${lead.id}`, "/settings/pipelines"]) {
      await page.goto(`/w/${workspaceId}${path}`);
      await expect(page.getByRole("heading", { level: 1 }).first()).toBeVisible();
      await noOverflow(page);
      await axe(page);
    }
  }
  await page.setViewportSize({ width: 375, height: 800 });
  await page.goto(`/w/${workspaceId}/leads`);
  await expect(page.getByRole("list", { name: "Leads" }).getByRole("link")).toHaveCount(1); // cards, not a squeezed table
  await expect(page.getByRole("table")).toBeHidden();
});
