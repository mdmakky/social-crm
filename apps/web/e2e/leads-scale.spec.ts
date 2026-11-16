import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { addMemberByEmail, api, register, seedContacts } from "./helpers";

// Leads-only slice: Leads is the one place for sales opportunities, built to stay usable with thousands of rows.
const TOTAL = 130;
const IN_QUALIFIED = 25;
const ws = (id: string, path = "") => `/v1/workspaces/${id}${path}`;
const axe = async (page: Page) => expect((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze()).violations.map((v) => `${v.id}: ${v.nodes[0]?.target}`)).toEqual([]);
const noOverflow = async (page: Page) => expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);

test.describe.configure({ mode: "serial" });

let workspaceId = "";
let owner: { ctx: BrowserContext; page: Page };
let viewer: { ctx: BrowserContext; page: Page };
let qualifiedId = "";
let newId = "";

async function newUser(browser: Browser, name: string) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const email = await register(page, name);
  return { ctx, page, email };
}

test.beforeAll(async ({ browser }) => {
  test.setTimeout(240_000);
  owner = await newUser(browser, "Olive Owner");
  workspaceId = await (async () => {
    await owner.page.getByLabel("Workspace name").fill("Scale Co");
    await owner.page.getByRole("button", { name: "Create workspace" }).click();
    await owner.page.waitForURL(/\/w\/[0-9a-f-]{36}$/);
    return owner.page.url().split("/w/")[1]!;
  })();
  const v = await newUser(browser, "Vera Viewer");
  await addMemberByEmail(workspaceId, v.email, "viewer");
  viewer = v;
  const [contactId] = await seedContacts(owner.page, workspaceId, [{ name: "Ana Costa" }]);
  const cfg = await (await api(owner.page).get(ws(workspaceId, "/pipelines"))).json();
  const stages = cfg.pipelines[0].stages as { id: string; name: string; kind: string }[];
  newId = stages.find((s) => s.name === "New")!.id;
  qualifiedId = stages.find((s) => s.name === "Qualified")!.id;
  const ids: string[] = [];
  for (let i = 0; i < TOTAL; i += 10) {
    const batch = await Promise.all(Array.from({ length: Math.min(10, TOTAL - i) }, async (_, k) => {
      const r = await api(owner.page).post(ws(workspaceId, "/leads"), { title: `Scale lead ${String(i + k).padStart(3, "0")}`, primaryContactId: contactId, allowDuplicate: true });
      if (r.status() !== 201) throw new Error(`seed lead failed: ${r.status()} ${await r.text()}`);
      return (await r.json()).id as string;
    }));
    ids.push(...batch);
  }
  const moved = await api(owner.page).post(ws(workspaceId, "/leads/bulk-stage"), { leadIds: ids.slice(0, IN_QUALIFIED), stageId: qualifiedId });
  expect(moved.status()).toBe(200);
});
test.afterAll(async () => { await owner?.ctx.close(); await viewer?.ctx.close(); });

test("stage chips show server counts and filter the list; the filter lives in the URL; Load more appends", async () => {
  test.setTimeout(120_000);
  const { page } = owner;
  await page.goto(`/w/${workspaceId}/leads`);
  await expect(page.getByRole("heading", { level: 1, name: "Leads" })).toBeVisible();
  const chips = page.getByRole("group", { name: "Filter by stage" });
  await expect(chips.getByRole("button", { name: `All ${TOTAL} open leads` })).toHaveAttribute("aria-pressed", "true");
  await expect(chips.getByRole("button", { name: `New ${TOTAL - IN_QUALIFIED} leads` })).toBeVisible();
  await expect(chips.getByRole("button", { name: `Qualified ${IN_QUALIFIED} leads` })).toBeVisible();
  await expect(chips.getByRole("button", { name: "Won 0 leads" })).toBeVisible();

  // paging: 50 per page, visible count, appended rows
  await expect(page.getByText(`Showing 50 of ${TOTAL}`)).toBeVisible();
  await page.getByRole("button", { name: "Load more" }).click();
  await expect(page.getByText(`Showing 100 of ${TOTAL}`)).toBeVisible();
  await page.getByRole("button", { name: "Load more" }).click();
  await expect(page.getByText(`Showing ${TOTAL} of ${TOTAL}`)).toBeVisible();
  await expect(page.getByRole("button", { name: "Load more" })).toHaveCount(0);

  // chip -> stage filter in the URL
  await chips.getByRole("button", { name: `Qualified ${IN_QUALIFIED} leads` }).click();
  await expect(page).toHaveURL(new RegExp(`leads\\?stage=${qualifiedId}`));
  await expect(page.getByText(`Showing ${IN_QUALIFIED} of ${IN_QUALIFIED}`)).toBeVisible();
  await expect(chips.getByRole("button", { name: `Qualified ${IN_QUALIFIED} leads` })).toHaveAttribute("aria-pressed", "true");
  // survives a reload (server renders the same state) and shows the same counts
  await page.reload();
  await expect(chips.getByRole("button", { name: `Qualified ${IN_QUALIFIED} leads` })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByText(`Showing ${IN_QUALIFIED} of ${IN_QUALIFIED}`)).toBeVisible();
  // other filters narrow the counts but not each other: searching keeps every chip
  await page.getByLabel("Search leads by title").fill("Scale lead 00");
  await expect(page).toHaveURL(/q=Scale\+lead\+00/);
  await expect(chips.getByRole("button", { name: `Qualified 10 leads` })).toBeVisible();
  await page.getByLabel("Search leads by title").fill("");
  // Back returns to the previous chip state
  await page.getByRole("button", { name: /^All \d+ open leads/ }).click();
  await expect(page).not.toHaveURL(/stage=/);
  await page.goBack();
  await expect(chips.getByRole("button", { name: `Qualified ${IN_QUALIFIED} leads` })).toHaveAttribute("aria-pressed", "true");
});

test("My leads toggle, last-activity and value filters exist, and the leads UI never says deal", async () => {
  const { page } = owner;
  await page.goto(`/w/${workspaceId}/leads`);
  await expect(page.getByRole("button", { name: "My leads" })).toHaveAttribute("aria-pressed", "false");
  await page.getByRole("button", { name: "My leads" }).click();
  await expect(page.getByRole("button", { name: "My leads" })).toHaveAttribute("aria-pressed", "true");
  await expect(page).toHaveURL(/owner=/);
  await expect(page.getByText("No leads match these filters")).toBeVisible(); // nothing is assigned yet
  await page.getByRole("button", { name: "My leads" }).click();
  await page.getByLabel("Last activity").selectOption("7");
  await expect(page).toHaveURL(/active=7/);
  await expect(page.getByText(`Showing 50 of ${TOTAL}`)).toBeVisible();
  await page.getByLabel("Minimum value").fill("1");
  await expect(page).toHaveURL(/min=1/);
  await expect(page.getByText("No leads match these filters")).toBeVisible(); // no lead has a value
  await page.getByRole("button", { name: "Clear filters" }).click();
  await expect(page.getByText(`Showing 50 of ${TOTAL}`)).toBeVisible();
  expect(await page.locator("body").innerText()).not.toMatch(/\bdeals?\b/i);
  await page.getByRole("button", { name: "New lead", exact: true }).first().click();
  expect(await page.getByRole("dialog").innerText()).not.toMatch(/\bdeals?\b/i);
  await page.keyboard.press("Escape");
});

test("bulk change stage: select on the page, confirm, counts refresh, failures are not silent", async () => {
  test.setTimeout(120_000);
  const { page } = owner;
  await page.goto(`/w/${workspaceId}/leads?stage=${newId}`);
  const chips = page.getByRole("group", { name: "Filter by stage" });
  await expect(page.getByText(`Showing 50 of ${TOTAL - IN_QUALIFIED}`)).toBeVisible();
  await page.getByRole("checkbox", { name: "Select all on this page" }).check();
  await expect(page.getByText("50 selected")).toBeVisible();
  await page.getByRole("checkbox", { name: "Select all on this page" }).uncheck();
  await expect(page.getByRole("region", { name: "Bulk actions" })).toHaveCount(0);
  for (const t of ["125", "126", "127"]) await page.getByRole("checkbox", { name: `Select Scale lead ${t}` }).check(); // newest first: these are on page 1
  await expect(page.getByText("3 selected")).toBeVisible();
  const n = 3;
  await page.getByRole("button", { name: "Change stage", exact: true }).first().click();
  const dlg = page.getByRole("dialog");
  await expect(dlg.getByRole("button", { name: `Move ${n} leads` })).toBeDisabled(); // nothing chosen yet
  await dlg.getByLabel("New stage").selectOption({ label: "Qualified" });
  await dlg.getByRole("button", { name: `Move ${n} leads` }).click();
  await expect(dlg).toBeHidden();
  await expect(chips.getByRole("button", { name: `Qualified ${IN_QUALIFIED + n} leads` })).toBeVisible(); // server counts refetched
  await expect(chips.getByRole("button", { name: `New ${TOTAL - IN_QUALIFIED - n} leads` })).toBeVisible();
  await expect(page.getByRole("link", { name: "Scale lead 125" })).toHaveCount(0); // gone from the New list

  // a lead deleted by someone else meanwhile is reported, not skipped silently
  const row = page.getByRole("checkbox", { name: /^Select Scale lead 12[89]$/ }).first();
  const label = (await row.getAttribute("aria-label"))!.replace("Select ", "");
  const list = await (await api(page).get(ws(workspaceId, `/leads?q=${encodeURIComponent(label)}`))).json();
  const target = list.items[0] as { id: string; version: number };
  await row.check();
  expect((await api(page).post(ws(workspaceId, `/leads/${target.id}/move`), { expectedVersion: target.version, stageId: qualifiedId })).status()).toBe(200);
  const del = await page.request.delete(ws(workspaceId, `/leads/${target.id}?expectedVersion=${target.version + 1}`), { headers: { origin: `http://localhost:${process.env.E2E_WEB_PORT ?? "3217"}` } });
  expect(del.status()).toBe(200);
  await page.getByRole("button", { name: "Change stage", exact: true }).first().click();
  await page.getByRole("dialog").getByLabel("New stage").selectOption({ label: "Qualified" });
  await page.getByRole("dialog").getByRole("button", { name: "Move 1 lead" }).click();
  await expect(page.getByRole("dialog").getByText(/1 not moved: 1 no longer exist/)).toBeVisible();
});

test("/pipeline redirects to /leads, the sidebar has no Pipeline, and Settings > Pipelines stays", async () => {
  const { page } = owner;
  await page.goto(`/w/${workspaceId}/pipeline`);
  await expect(page).toHaveURL(new RegExp(`/w/${workspaceId}/leads$`));
  await expect(page.getByRole("heading", { level: 1, name: "Leads" })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Pipeline" })).toHaveCount(0);
  await expect(page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Leads" })).toBeVisible();
  await page.goto(`/w/${workspaceId}/settings/pipelines`);
  await expect(page.getByRole("heading", { level: 1, name: "Pipeline settings" })).toBeVisible();
});

test("a viewer sees the list and chips but cannot select or bulk move", async () => {
  const { page } = viewer;
  await page.goto(`/w/${workspaceId}/leads`);
  await expect(page.getByRole("group", { name: "Filter by stage" })).toBeVisible();
  await expect(page.getByRole("link", { name: /^Scale lead/ }).first()).toBeVisible();
  await expect(page.getByRole("checkbox")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "New lead", exact: true })).toHaveCount(0);
  await expect(page.getByLabel("Minimum value")).toHaveCount(0); // viewers never see values, so no value-range probing
  const r = await api(page).post(ws(workspaceId, "/leads/bulk-stage"), { leadIds: ["00000000-0000-4000-8000-000000000001"], stageId: qualifiedId });
  expect(r.status()).toBe(403);
});

test("375, 768 and 1440: cards on phones with selectable rows, no overflow, accessible", async () => {
  test.setTimeout(120_000);
  const { page } = owner;
  for (const [width, height] of [[375, 800], [768, 900], [1440, 900]] as const) {
    await page.setViewportSize({ width, height });
    await page.goto(`/w/${workspaceId}/leads`);
    await expect(page.getByRole("group", { name: "Filter by stage" })).toBeVisible();
    await expect(page.getByText(/^Showing \d+ of \d+$/)).toBeVisible();
    await noOverflow(page);
    if (width === 375) {
      await expect(page.getByRole("table")).toBeHidden();
      const card = page.getByRole("list", { name: "Leads" }).getByRole("checkbox").first();
      const box = (await card.locator("xpath=..").boundingBox())!;
      expect(box.width).toBeGreaterThanOrEqual(44);
      expect(box.height).toBeGreaterThanOrEqual(44);
      await card.check();
      await expect(page.getByText("1 selected")).toBeVisible();
      await noOverflow(page);
    }
    await axe(page);
  }
});
