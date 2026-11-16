import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { addMemberByEmail, api, register, seedContacts, signUpAndCreate } from "./helpers";

const ws = (id: string, path = "") => `/v1/workspaces/${id}${path}`;
async function post(page: Page, url: string, data: unknown) {
  const r = await api(page).post(url, data);
  if (!r.ok()) throw new Error(`${url} -> ${r.status()} ${await r.text()}`);
  return r.json();
}
/** One workspace with open, won (USD) and lost leads. */
async function seedPipeline(page: Page, workspaceId: string) {
  const contacts = await seedContacts(page, workspaceId, ["Ana", "Ben", "Cy", "Di"].map((name) => ({ name })));
  const cfg = await (await page.request.get(ws(workspaceId, "/pipelines"))).json();
  const stages = cfg.pipelines[0].stages as { id: string; kind: string }[];
  const won = stages.find((s) => s.kind === "won")!.id;
  const lost = stages.find((s) => s.kind === "lost")!.id;
  const a = await post(page, ws(workspaceId, "/leads"), { title: "Open deal", primaryContactId: contacts[0], valueMinor: 120000, currency: "USD", expectedCloseDate: "2020-01-01" });
  const b = await post(page, ws(workspaceId, "/leads"), { title: "Won deal", primaryContactId: contacts[1], valueMinor: 345600, currency: "USD" });
  const c = await post(page, ws(workspaceId, "/leads"), { title: "Lost deal", primaryContactId: contacts[2], valueMinor: 50000, currency: "USD" });
  await post(page, ws(workspaceId, `/leads/${b.id}/move`), { expectedVersion: b.version, stageId: won });
  await post(page, ws(workspaceId, `/leads/${c.id}/move`), { expectedVersion: c.version, stageId: lost, lostReasonId: cfg.lostReasons[0].id });
  return { open: a.id as string, won: b.id as string };
}
const axe = async (page: Page) => expect((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze()).violations.map((v) => `${v.id}: ${v.nodes[0]?.target}`)).toEqual([]);

test("reports: owner sees counts and amounts; an agent sees counts only and no amount in the page", async ({ page, browser }) => {
  test.setTimeout(150_000);
  const { workspaceId } = await signUpAndCreate(page, "Olive Owner", "Reports Co");
  await seedPipeline(page, workspaceId);
  await page.goto(`/w/${workspaceId}/reports`);
  await expect(page.getByRole("heading", { level: 1, name: "Reports" })).toBeVisible();
  await expect(page.getByText("$3,456.00").first()).toBeVisible();
  await expect(page.getByText("50%").first()).toBeVisible(); // win rate: 1 won, 1 lost
  await expect(page.getByRole("list", { name: "Expected closing" })).toContainText("Overdue");

  const ctx = await browser.newContext();
  const agent = await ctx.newPage();
  const email = await register(agent, "Sam Agent");
  await addMemberByEmail(workspaceId, email, "agent");
  await agent.goto(`/w/${workspaceId}/reports`);
  await expect(agent.getByText("Lead values are only shown to owners and admins")).toBeVisible();
  const html = await agent.content();
  for (const n of ["3,456", "1,200", "345600", "120000"]) expect(html).not.toContain(n);
  await expect(agent.getByText("50%").first()).toBeVisible();
});

test("reports: loading state, error state with retry, period change", async ({ page }) => {
  test.setTimeout(120_000);
  const { workspaceId } = await signUpAndCreate(page, "Olive Owner", "Reports States Co");
  await seedPipeline(page, workspaceId);
  await page.goto(`/w/${workspaceId}/reports`);
  await page.route("**/lead-reports/overview*", async (r) => { await new Promise((res) => setTimeout(res, 800)); await r.fulfill({ status: 500, body: "{}" , contentType: "application/json" }); });
  await page.getByLabel("Period").selectOption("30");
  await expect(page.locator('[aria-busy="true"]').first()).toBeVisible(); // stale content stays visible, dimmed, while loading
  await expect(page.getByRole("heading", { name: "Something went wrong" })).toBeVisible();
  await page.unroute("**/lead-reports/overview*");
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(page.getByText("$3,456.00").first()).toBeVisible();
});

test("Won and Lost chips list the closed leads, links open them, and the status filter still works", async ({ page }) => {
  test.setTimeout(120_000);
  const { workspaceId } = await signUpAndCreate(page, "Olive Owner", "Closed Leads Co");
  const ids = await seedPipeline(page, workspaceId);
  await page.goto(`/w/${workspaceId}/leads`);
  await expect(page.getByRole("link", { name: "Open deal" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Won deal" })).toHaveCount(0); // the default list is open leads
  await page.getByRole("button", { name: "Won 1 lead" }).click();
  await expect(page).toHaveURL(/leads\?stage=/);
  await expect(page.getByRole("button", { name: "Won 1 lead" })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("link", { name: "Won deal" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Open deal" })).toHaveCount(0);
  await page.getByRole("link", { name: "Won deal" }).click();
  await expect(page).toHaveURL(new RegExp(`/leads/${ids.won}$`));
  await page.goBack();
  await expect(page.getByRole("button", { name: "Won 1 lead" })).toHaveAttribute("aria-pressed", "true"); // the chip filter survives Back
  await page.getByRole("button", { name: "Lost 1 lead" }).click();
  await expect(page.getByRole("link", { name: "Lost deal" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Won deal" })).toHaveCount(0);
});

test("reduced motion: transitions and animations are effectively off on leads screens", async ({ page }) => {
  test.setTimeout(120_000);
  const { workspaceId } = await signUpAndCreate(page, "Olive Owner", "Motion Co");
  const ids = await seedPipeline(page, workspaceId);
  await page.emulateMedia({ reducedMotion: "reduce" });
  for (const path of ["/leads", `/leads/${ids.open}`, "/reports"]) {
    await page.goto(`/w/${workspaceId}${path}`);
    await expect(page.getByRole("heading", { level: 1 }).first()).toBeVisible();
    const slow = await page.evaluate(() => [...document.querySelectorAll("*")].filter((el) => { const s = getComputedStyle(el); return parseFloat(s.transitionDuration) > 0.05 || (s.animationName !== "none" && parseFloat(s.animationDuration) > 0.05); }).length);
    expect(slow).toBe(0);
  }
});

test("375 and 768 layouts of reports, list and settings have no overflow and pass axe", async ({ page }) => {
  test.setTimeout(180_000);
  const { workspaceId } = await signUpAndCreate(page, "Olive Owner", "Layout Co");
  const ids = await seedPipeline(page, workspaceId);
  for (const width of [375, 768]) {
    await page.setViewportSize({ width, height: 900 });
    for (const path of ["/reports", "/leads", "/settings/pipelines", `/leads/${ids.open}`]) {
      await page.goto(`/w/${workspaceId}${path}`);
      await expect(page.getByRole("heading", { level: 1 }).first()).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
      await axe(page);
      if (width === 375) await page.screenshot({ path: `/tmp/claude-1000/shots/final-${path.replace(/\W+/g, "_")}-${width}.png`, fullPage: true });
    }
  }
});
