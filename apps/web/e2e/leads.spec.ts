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
const noOverflow = async (page: Page, where = "") => expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), `horizontal overflow ${where}`).toBe(true);
const axe = async (page: Page) => expect((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze()).violations.map((v) => `${v.id}: ${v.nodes[0]?.target}`)).toEqual([]);

test("pipeline settings: add, rename, reorder with buttons, archive a stage with a move target", async ({ page }) => {
  test.setTimeout(120_000);
  const { workspaceId } = await signUpAndCreate(page, "Olive Owner", "Pipelines Co");
  await page.goto(`/w/${workspaceId}/settings/pipelines`);
  await expect(page.getByRole("heading", { level: 1, name: "Lead stages" })).toBeVisible();
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
  await expect(page.getByRole("status").filter({ hasText: "Stage order saved." }).first()).toBeVisible(); // the move is optimistic; reload only after the save finished
  await page.reload();
  await expect(page.getByRole("list", { name: "Sales stages" }).getByRole("listitem").nth(4)).toContainText("Demo"); // persisted

  await page.getByRole("button", { name: "Edit Demo" }).click();
  await page.getByLabel("Name of stage Demo").fill("Demo call");
  await page.getByRole("button", { name: "Save stage" }).click();
  await expect(stages.getByRole("listitem").nth(4)).toContainText("Demo call");

  await page.getByRole("button", { name: "Archive Demo call" }).click();
  const dlg = page.getByRole("dialog");
  await expect(dlg).toContainText("Its leads move to the stage you choose");
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

test("one contact, one stage: set a value, move it, lose it with a reason, find it by stage, search and clear", async ({ page }) => {
  test.setTimeout(150_000);
  const { workspaceId } = await signUpAndCreate(page, "Olive Owner", "Leads Co");
  const [contactId] = await seedContacts(page, workspaceId, [{ name: "Ana Costa", email: "ana@example.com" }]);
  await page.goto(`/w/${workspaceId}/contacts`);
  await expect(page.getByRole("heading", { level: 1, name: "Leads" })).toBeVisible();
  // no lead yet: shown as the first stage, nothing written
  await expect(page.getByRole("button", { name: "Stage of Ana Costa: New. Change stage" })).toBeVisible();
  expect(((await (await page.request.get(ws(workspaceId, "/leads"))).json()) as { items: unknown[] }).items).toHaveLength(0);

  await page.getByRole("link", { name: "Ana Costa" }).first().click();
  await expect(page.getByRole("heading", { level: 1, name: "Ana Costa" })).toBeVisible();
  // no lead yet: the first stage is current (nothing written); value and stage autosave, there is no Update button (D307)
  await expect(page.getByRole("button", { name: "Set stage to New" })).toHaveAttribute("aria-current", "step");
  await expect(page.getByRole("button", { name: "Update", exact: true })).toHaveCount(0);
  await page.getByLabel("Value", { exact: true }).fill("2,500.50");
  await page.getByLabel("Value", { exact: true }).blur();
  await expect(page.getByRole("status").filter({ hasText: "Saved" })).toBeVisible();
  const created = (await (await page.request.get(ws(workspaceId, "/leads"))).json()) as { items: { valueMinor: number; title: string }[] };
  expect(created.items).toHaveLength(1); // the first write created the lead
  expect(created.items[0]).toMatchObject({ valueMinor: 250050, title: "Ana Costa" });

  await page.getByRole("button", { name: "Set stage to Qualified" }).click();
  await expect(page.getByRole("button", { name: "Set stage to Qualified" })).toHaveAttribute("aria-current", "step");
  await page.reload();
  await expect(page.getByLabel("Value", { exact: true })).toHaveValue("2500.50");
  await expect(page.getByRole("button", { name: "Set stage to Qualified" })).toHaveAttribute("aria-current", "step");
  await expect(page.locator('main :text-is("Qualified"):visible')).toHaveCount(1); // the stage is shown once, not in a header chip and a form

  await page.getByRole("button", { name: "Lost", exact: true }).click();
  await page.getByLabel("Why was it lost?").selectOption({ label: "Timing" });
  await page.getByRole("dialog").getByRole("button", { name: "Mark as lost" }).click();
  await expect(page.getByRole("button", { name: "Lost", exact: true })).toHaveAttribute("aria-pressed", "true");

  await page.goto(`/w/${workspaceId}/contacts`);
  await expect(page.getByRole("button", { name: "Stage of Ana Costa: Lost. Change stage" })).toBeVisible();
  await expect(page.getByText("$2,500.50").filter({ visible: true })).toBeVisible(); // the table and the phone cards both carry it; one is shown
  await page.getByRole("group", { name: "Filter by stage" }).getByRole("button", { name: /^Lost/ }).click();
  await expect(page.getByRole("link", { name: "Ana Costa" }).first()).toBeVisible();
  await page.getByRole("group", { name: "Filter by stage" }).getByRole("button", { name: /^New/ }).click();
  await expect(page.getByText("No leads match these filters")).toBeVisible();
  await page.getByRole("button", { name: "Clear filters" }).click();
  await expect(page.getByRole("link", { name: "Ana Costa" }).first()).toBeVisible();
  await page.getByLabel("Search leads").fill("zzz");
  await expect(page.getByText("No leads match these filters")).toBeVisible();
  await page.getByRole("button", { name: "Clear filters" }).click();
  await expect(page.getByRole("link", { name: "Ana Costa" }).first()).toBeVisible();
  expect(contactId).toBeTruthy();
});

test("lead value is restricted for agents: not in the page, the API response or the list", async ({ page, browser }) => {
  test.setTimeout(150_000);
  const { workspaceId } = await signUpAndCreate(page, "Olive Owner", "Value Co");
  const agent = await newUser(browser, "Sam Agent");
  await addMemberByEmail(workspaceId, agent.email, "agent");
  const [contactId] = await seedContacts(page, workspaceId, [{ name: "Ana Costa" }]);
  await seedLead(page, workspaceId, { title: "Secret", primaryContactId: contactId, valueMinor: 987654, currency: "USD" });

  await agent.page.goto(`/w/${workspaceId}/contacts`);
  await expect(agent.page.getByRole("link", { name: "Ana Costa" }).first()).toBeVisible();
  await expect(agent.page.getByText("Hidden").first()).toBeVisible();
  await expect(agent.page.getByRole("button", { name: "Highest value" })).toHaveCount(0);
  await agent.page.goto(`/w/${workspaceId}/contacts/${contactId}`);
  await expect(agent.page.getByText("Value is hidden for your role.")).toBeVisible();
  expect(await agent.page.content()).not.toContain("9,876.54");
  expect(await agent.page.content()).not.toContain("987654");
  const raw = await agent.page.request.get(ws(workspaceId, `/contacts/${contactId}/lead`));
  expect(await raw.json()).toMatchObject({ lead: { valueMinor: null, valueHidden: true } });
  expect((await agent.page.request.get(ws(workspaceId, "/contacts?sort=value"))).status()).toBe(403);

  await page.goto(`/w/${workspaceId}/contacts`);
  await expect(page.getByText("$9,876.54").filter({ visible: true })).toBeVisible();
});

test("responsive and accessible: contacts, contact and stage settings at 375, 768, 1024 and 1440", async ({ page }) => {
  test.setTimeout(180_000);
  const { workspaceId } = await signUpAndCreate(page, "Olive Owner", "Responsive Leads Co");
  const [contactId] = await seedContacts(page, workspaceId, [{ name: "Ana Costa" }]);
  await seedLead(page, workspaceId, { title: "Responsive lead with a rather long title to test wrapping on narrow screens", primaryContactId: contactId, valueMinor: 100000, currency: "USD" });
  for (const width of [375, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    for (const path of ["/contacts", `/contacts/${contactId}`, "/settings/pipelines"]) {
      await page.goto(`/w/${workspaceId}${path}`);
      await expect(page.getByRole("heading", { level: 1 }).first()).toBeVisible();
      await noOverflow(page, `${width} ${path}`);
      await axe(page);
    }
  }
  await page.setViewportSize({ width: 375, height: 800 });
  await page.goto(`/w/${workspaceId}/contacts`);
  await expect(page.locator("ul.t-cards").getByRole("link")).toHaveCount(1); // cards, not a squeezed table
  await expect(page.getByRole("table")).toBeHidden();
});
