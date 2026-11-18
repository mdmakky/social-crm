import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { addMemberByEmail, api, register } from "./helpers";

// One contact, one lead (D260): the Contacts list is the one place for stages, built to stay usable with thousands of rows. Formerly the Leads list scale spec; the same scenarios, ported to Contacts.
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
  const cfg = await (await api(owner.page).get(ws(workspaceId, "/pipelines"))).json();
  const stages = cfg.pipelines[0].stages as { id: string; name: string; kind: string }[];
  newId = stages.find((s) => s.name === "New")!.id;
  qualifiedId = stages.find((s) => s.name === "Qualified")!.id;
  const ids: string[] = [];
  for (let i = 0; i < TOTAL; i += 10) {
    const batch = await Promise.all(Array.from({ length: Math.min(10, TOTAL - i) }, async (_, k) => {
      const r = await api(owner.page).post(ws(workspaceId, "/contacts"), { name: `Scale contact ${String(i + k).padStart(3, "0")}`, phone: `+8801700${String(i + k).padStart(6, "0")}` });
      if (r.status() !== 201) throw new Error(`seed contact failed: ${r.status()} ${await r.text()}`);
      return (await r.json()).id as string;
    }));
    ids.push(...batch);
  }
  // Only these get a lead (created by the bulk move); the other 105 stay lead-less and count as the first stage.
  const moved = await api(owner.page).post(ws(workspaceId, "/contacts/bulk-stage"), { contactIds: ids.slice(0, IN_QUALIFIED), stageId: qualifiedId });
  expect(moved.status()).toBe(200);
  expect(((await moved.json()) as { results: { code: string }[] }).results.every((r) => r.code === "created")).toBe(true);
});
test.afterAll(async () => { await owner?.ctx.close(); await viewer?.ctx.close(); });

test("stage chips show server counts and filter the list; the filter lives in the URL; Load more appends", async () => {
  test.setTimeout(120_000);
  const { page } = owner;
  await page.goto(`/w/${workspaceId}/contacts`);
  await expect(page.getByRole("heading", { level: 1, name: "Leads" })).toBeVisible();
  const chips = page.getByRole("group", { name: "Filter by stage" });
  await expect(chips.getByRole("button", { name: `All ${TOTAL}` })).toHaveAttribute("aria-pressed", "true");
  await expect(chips.getByRole("button", { name: `New ${TOTAL - IN_QUALIFIED}` })).toBeVisible(); // lead-less contacts count as the first stage
  await expect(chips.getByRole("button", { name: `Qualified ${IN_QUALIFIED}` })).toBeVisible();
  await expect(chips.getByRole("button", { name: "Won 0" })).toBeVisible();

  // paging: 25 per page, visible count, appended rows
  await expect(page.getByText(new RegExp(`Showing 25 of ${TOTAL}$`))).toBeVisible();
  await page.getByRole("button", { name: "Load more" }).click();
  await expect(page.getByText(new RegExp(`Showing 50 of ${TOTAL}$`))).toBeVisible();

  // chip -> stage filter in the URL
  await chips.getByRole("button", { name: `Qualified ${IN_QUALIFIED}` }).click();
  await expect(page).toHaveURL(new RegExp(`contacts\\?stageId=${qualifiedId}`));
  await expect(page.getByText(new RegExp(`Showing ${IN_QUALIFIED} of ${IN_QUALIFIED}$`))).toBeVisible();
  await expect(chips.getByRole("button", { name: `Qualified ${IN_QUALIFIED}` })).toHaveAttribute("aria-pressed", "true");
  // survives a reload (server renders the same state) and shows the same counts
  await page.reload();
  await expect(chips.getByRole("button", { name: `Qualified ${IN_QUALIFIED}` })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByText(new RegExp(`Showing ${IN_QUALIFIED} of ${IN_QUALIFIED}$`))).toBeVisible();
  // other filters narrow the counts but not each other: searching keeps every chip
  await page.getByLabel("Search leads").fill("Scale contact 00");
  await expect(page).toHaveURL(/search=Scale\+contact\+00/);
  await expect(chips.getByRole("button", { name: "Qualified 10" })).toBeVisible();
  await page.getByLabel("Search leads").fill("");
});

test("owner filter works with the stage filter, and the screen never says deal", async () => {
  const { page } = owner;
  await page.goto(`/w/${workspaceId}/contacts`);
  await page.getByRole("button", { name: "Agent" }).click(); // Agent is a multi-select menu now (D303)
  await page.getByRole("menuitem", { name: "Me", exact: true }).click();
  await expect(page.getByText("No leads match these filters")).toBeVisible(); // nothing is assigned yet
  await page.getByRole("button", { name: "Clear filters" }).click();
  await expect(page.getByText(new RegExp(`Showing 25 of ${TOTAL}$`))).toBeVisible();
  expect(await page.locator("body").innerText()).not.toMatch(/\bdeals?\b/i);
});

test("bulk change stage: select on the page, confirm, counts refresh, failures are not silent", async () => {
  test.setTimeout(120_000);
  const { page } = owner;
  await page.goto(`/w/${workspaceId}/contacts?stageId=${newId}`);
  const chips = page.getByRole("group", { name: "Filter by stage" });
  await expect(page.getByText(new RegExp(`Showing 25 of ${TOTAL - IN_QUALIFIED}$`))).toBeVisible();
  await page.getByRole("checkbox", { name: "Select all on this page" }).check();
  await expect(page.getByText("25 selected")).toBeVisible();
  await page.getByRole("checkbox", { name: "Select all on this page" }).uncheck();
  await expect(page.getByRole("region", { name: "Bulk actions" })).toHaveCount(0);
  const boxes = page.getByRole("checkbox", { name: /^Select Scale contact/ });
  const names: string[] = [];
  for (const i of [0, 1, 2]) { const b = boxes.nth(i); names.push((await b.getAttribute("aria-label"))!.replace("Select ", "")); await b.check(); }
  await expect(page.getByText("3 selected")).toBeVisible();
  const n = 3;
  await page.getByRole("button", { name: "Change stage", exact: true }).first().click();
  const dlg = page.getByRole("dialog");
  await expect(dlg.getByRole("button", { name: `Move ${n} leads` })).toBeDisabled(); // nothing chosen yet
  await dlg.getByLabel("New stage").selectOption({ label: "Qualified" });
  await dlg.getByRole("button", { name: `Move ${n} leads` }).click();
  await expect(dlg).toBeHidden();
  await expect(chips.getByRole("button", { name: `Qualified ${IN_QUALIFIED + n}` })).toBeVisible(); // server counts refetched
  await expect(chips.getByRole("button", { name: `New ${TOTAL - IN_QUALIFIED - n}` })).toBeVisible();
  await expect(page.getByRole("link", { name: names[0]! })).toHaveCount(0); // gone from the New list

  // a contact deleted by someone else meanwhile is reported, not skipped silently
  const row = boxes.first();
  const label = (await row.getAttribute("aria-label"))!.replace("Select ", "");
  const list = await (await api(page).get(ws(workspaceId, `/contacts?search=${encodeURIComponent(label)}`))).json();
  const target = list.items[0] as { id: string };
  await row.check();
  const del = await page.request.delete(ws(workspaceId, `/contacts/${target.id}`), { headers: { origin: `http://localhost:${process.env.E2E_WEB_PORT ?? "3217"}` } });
  expect(del.status()).toBe(204);
  await page.getByRole("button", { name: "Change stage", exact: true }).first().click();
  await page.getByRole("dialog").getByLabel("New stage").selectOption({ label: "Qualified" });
  await page.getByRole("dialog").getByRole("button", { name: "Move 1 lead" }).click();
  await expect(page.getByRole("dialog").getByText(/1 not moved: 1 no longer exist/)).toBeVisible();
});

test("/pipeline and /leads redirect to the Leads list, the sidebar has Leads but no Pipeline, and Settings > Lead stages stays", async () => {
  const { page } = owner;
  await page.goto(`/w/${workspaceId}/pipeline`);
  await expect(page).toHaveURL(new RegExp(`/w/${workspaceId}/contacts$`));
  await page.goto(`/w/${workspaceId}/leads`);
  await expect(page).toHaveURL(new RegExp(`/w/${workspaceId}/contacts$`));
  await expect(page.getByRole("heading", { level: 1, name: "Leads" })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Pipeline" })).toHaveCount(0);
  await expect(page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Leads" })).toHaveCount(1);
  await page.goto(`/w/${workspaceId}/settings/pipelines`);
  await expect(page.getByRole("heading", { level: 1, name: "Lead stages" })).toBeVisible();
});

test("a viewer sees the list and chips but cannot select, bulk move or sort by value", async () => {
  const { page } = viewer;
  await page.goto(`/w/${workspaceId}/contacts`);
  await expect(page.getByRole("group", { name: "Filter by stage" })).toBeVisible();
  await expect(page.getByRole("link", { name: /^Scale contact/ }).first()).toBeVisible();
  await expect(page.getByRole("checkbox")).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^Stage of / })).toHaveCount(0); // read-only stage, no menu
  const r = await api(page).post(ws(workspaceId, "/contacts/bulk-stage"), { contactIds: ["00000000-0000-4000-8000-000000000001"], stageId: qualifiedId });
  expect(r.status()).toBe(403);
});

test("375, 768 and 1440: cards on phones, no overflow, accessible", async () => {
  test.setTimeout(120_000);
  const { page } = owner;
  for (const [width, height] of [[375, 800], [768, 900], [1440, 900]] as const) {
    await page.setViewportSize({ width, height });
    await page.goto(`/w/${workspaceId}/contacts`);
    await expect(page.getByRole("group", { name: "Filter by stage" })).toBeVisible();
    await expect(page.getByText(/Showing \d+ of \d+$/)).toBeVisible();
    await noOverflow(page);
    if (width === 375) await expect(page.getByRole("table")).toBeHidden();
    await axe(page);
  }
});
