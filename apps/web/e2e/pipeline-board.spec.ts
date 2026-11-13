import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Browser, type Page } from "@playwright/test";
import { addMemberByEmail, api, register, seedContacts, signUpAndCreate } from "./helpers";

const ws = (id: string, path = "") => `/v1/workspaces/${id}${path}`;
async function seed(page: Page, workspaceId: string, titles: string[], extra: Record<string, unknown> = {}) {
  const contacts = await seedContacts(page, workspaceId, titles.map((t) => ({ name: `Contact ${t}` })));
  const ids: string[] = [];
  for (const [i, t] of titles.entries()) {
    const r = await api(page).post(ws(workspaceId, "/leads"), { title: t, primaryContactId: contacts[i], ...extra });
    if (r.status() !== 201) throw new Error(`seed failed ${r.status()} ${await r.text()}`);
    ids.push((await r.json()).id);
  }
  return ids;
}
const col = (page: Page, name: string) => page.locator(`section[aria-label^="${name},"]`);
async function drag(page: Page, from: ReturnType<Page["locator"]>, to: ReturnType<Page["locator"]>, y?: number) {
  const a = await from.boundingBox();
  const b = await to.boundingBox();
  if (!a || !b) throw new Error("no box");
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move(a.x + a.width / 2 + 12, a.y + a.height / 2 + 12, { steps: 4 });
  await page.mouse.move(b.x + b.width / 2, b.y + (y ?? Math.min(b.height - 10, 120)), { steps: 12 });
  await page.mouse.up();
}

test("drag a card to another stage, persist, see value, and drop on Lost with a reason", async ({ page }) => {
  test.setTimeout(150_000);
  const { workspaceId } = await signUpAndCreate(page, "Olive Owner", "Board Co");
  await seed(page, workspaceId, ["Alpha", "Beta", "Gamma"], { valueMinor: 100000, currency: "USD" });
  await page.goto(`/w/${workspaceId}/pipeline`);
  await expect(page.getByRole("heading", { level: 1, name: "Pipeline" })).toBeVisible();
  await expect(col(page, "New")).toContainText("Alpha");
  await expect(col(page, "New")).toContainText("$3,000.00");

  await drag(page, page.getByRole("button", { name: /^Move Alpha\./ }), col(page, "Qualified"));
  await expect(col(page, "Qualified")).toContainText("Alpha");
  await expect(col(page, "New")).not.toContainText("Alpha");
  await expect(page.getByRole("status").filter({ hasText: "Moved to Qualified." }).first()).toBeVisible();
  await page.reload();
  await expect(col(page, "Qualified")).toContainText("Alpha"); // persisted by the server

  // reorder inside a column: drop Gamma above Beta
  const before = await col(page, "New").locator("[data-card-id]").allInnerTexts();
  expect(before[0]).toContain("Beta");
  await drag(page, page.getByRole("button", { name: /^Move Gamma\./ }), col(page, "New").locator("[data-card-id]").first(), 3);
  await expect.poll(async () => (await col(page, "New").locator("[data-card-id]").first().innerText())).toContain("Gamma");
  await page.reload();
  expect(await col(page, "New").locator("[data-card-id]").first().innerText()).toContain("Gamma");

  await drag(page, page.getByRole("button", { name: /^Move Beta\./ }), page.locator('section[aria-label^="Lost"]'));
  const dlg = page.getByRole("dialog");
  await expect(dlg).toContainText("Mark as lost");
  await dlg.getByLabel("Reason").selectOption({ label: "Not a fit" });
  await dlg.getByRole("button", { name: "Mark as lost" }).click();
  await expect(page.getByText("Contact Beta")).toHaveCount(0);
  await expect(page.getByRole("status").filter({ hasText: "marked as lost" }).first()).toBeVisible();
});

test("keyboard and touch alternative: Move to menu; a failed move rolls the card back", async ({ page }) => {
  test.setTimeout(120_000);
  const { workspaceId } = await signUpAndCreate(page, "Olive Owner", "Board Menu Co");
  await seed(page, workspaceId, ["Delta"]);
  await page.goto(`/w/${workspaceId}/pipeline`);
  await page.getByRole("button", { name: "Move Delta to another stage" }).focus();
  await page.keyboard.press("Enter");
  await page.getByRole("menuitem", { name: "Proposal" }).click();
  await expect(col(page, "Proposal")).toContainText("Delta");

  await page.route("**/leads/*/move", (r) => r.abort());
  await page.getByRole("button", { name: "Move Delta to another stage" }).click();
  await page.getByRole("menuitem", { name: "Negotiation" }).click();
  await expect(page.getByRole("alert").filter({ hasText: /./ }).first()).toBeVisible();
  await expect(col(page, "Proposal")).toContainText("Delta"); // rolled back
  await expect(col(page, "Negotiation")).not.toContainText("Delta");
});

test("viewers see the board read-only", async ({ page, browser }: { page: Page; browser: Browser }) => {
  test.setTimeout(120_000);
  const { workspaceId } = await signUpAndCreate(page, "Olive Owner", "Board RO Co");
  await seed(page, workspaceId, ["Epsilon"], { valueMinor: 5000, currency: "USD" });
  const ctx = await browser.newContext();
  const v = await ctx.newPage();
  const email = await register(v, "Vic Viewer");
  await addMemberByEmail(workspaceId, email, "viewer");
  await v.goto(`/w/${workspaceId}/pipeline`);
  await expect(v.getByText("You can view the pipeline but not move cards.")).toBeVisible();
  await expect(v.getByRole("button", { name: /^Move Epsilon/ })).toHaveCount(0);
  await expect(v.getByText("Hidden").first()).toBeVisible();
  await expect(v.getByRole("button", { name: /New deal/ })).toHaveCount(0);
});

test("board is accessible and has no horizontal page overflow at 375, 768, 1024 and 1440", async ({ page }) => {
  test.setTimeout(150_000);
  const { workspaceId } = await signUpAndCreate(page, "Olive Owner", "Board Responsive Co");
  await seed(page, workspaceId, ["Zeta with a long long title that should wrap inside the card", "Eta"], { valueMinor: 1000, currency: "USD" });
  for (const width of [375, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`/w/${workspaceId}/pipeline`);
    await expect(page.getByRole("heading", { level: 1, name: "Pipeline" })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    const r = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
    expect(r.violations.map((v) => `${v.id}: ${v.nodes[0]?.target}`)).toEqual([]);
  }
});
