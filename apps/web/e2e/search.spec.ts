import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { CONTACT_NAMES, seedContacts, signUpAndCreate } from "./helpers";

const SHOTS = (process.env.UPDATE_SCREENSHOTS ? join(__dirname, "../../../docs/design/screenshots/search") : join(__dirname, "../test-results/shots-search")) + "/";
mkdirSync(SHOTS, { recursive: true });

const dialog = (page: Page) => page.getByRole("dialog", { name: "Command menu" });
const input = (page: Page) => dialog(page).getByRole("combobox");
const searchUrl = "**/v1/workspaces/*/search**";

async function setup(page: Page) {
  await page.setViewportSize({ width: 1440, height: 900 });
  const { workspaceId } = await signUpAndCreate(page, "Maya Okafor", "Search Studio");
  const ids = await seedContacts(page, workspaceId, [
    { name: CONTACT_NAMES[0]!, email: "ana.costa@example.com", company: "Costa Foods" },
    { name: "Anabel Reyes", phone: "+1 555 010 7788" },
    { name: "Ben Okafor", email: "ben@example.com" },
  ]);
  await page.goto(`/w/${workspaceId}/contacts`);
  await expect(page.getByRole("heading", { level: 1, name: "Contacts" })).toBeVisible();
  return { workspaceId, ids };
}

test("palette: Ctrl+K, live contact results with page items, keyboard open, focus return, no fake groups", async ({ page }) => {
  const { workspaceId, ids } = await setup(page);
  await page.keyboard.press("Control+k");
  await expect(dialog(page)).toBeVisible();
  await expect(input(page)).toBeFocused();
  await expect(page.getByText("Go to", { exact: true })).toBeVisible();
  // below 2 characters nothing is searched
  const seen: string[] = [];
  page.on("request", (r) => r.url().includes("/search") && seen.push(r.url()));
  await input(page).fill("a");
  await page.waitForTimeout(400);
  expect(seen).toEqual([]);

  await input(page).fill("costa");
  const opt = dialog(page).getByRole("option", { name: /Ana Costa/ });
  await expect(opt).toBeVisible();
  await expect(opt).toContainText("ana.costa@example.com");
  await expect(opt).toContainText("Costa Foods");
  await expect(dialog(page).getByText("Contacts", { exact: true })).toBeVisible();
  for (const fake of ["Tasks", "Conversations", "Pipeline", "Messages"]) await expect(dialog(page).getByText(fake, { exact: true })).toHaveCount(0);
  expect(seen.length).toBe(1);
  expect(seen[0]).toContain("q=costa");
  await page.screenshot({ path: `${SHOTS}palette-results-1440.png` });

  // pages still match alongside contacts
  await input(page).fill("contacts");
  await expect(dialog(page).getByRole("option", { name: "Contacts" }).first()).toBeVisible();

  // keyboard: arrow to the hit and Enter opens it
  await input(page).fill("anabel");
  await expect(dialog(page).getByRole("option", { name: /Anabel Reyes/ })).toBeVisible();
  await page.keyboard.press("Enter");
  await page.waitForURL(new RegExp(`/w/${workspaceId}/contacts/[0-9a-f-]{36}$`));
  expect(ids).toContain(page.url().split("/").pop());
  await page.keyboard.press("Control+k");
  await expect(input(page)).toHaveValue(""); // reset between openings
  await page.keyboard.press("Escape");
  await expect(dialog(page)).toBeHidden();
});

test("palette: no results, API error with retry, and the permission-free empty state", async ({ page }) => {
  await setup(page);
  await page.keyboard.press("Control+k");
  await input(page).fill("zzzzqq");
  await expect(dialog(page).getByText("No results for “zzzzqq”.")).toBeVisible();
  await page.screenshot({ path: `${SHOTS}palette-no-results-1440.png` });

  let fail = true;
  await page.route(searchUrl, (route) => (fail ? route.fulfill({ status: 500, json: { error: { code: "internal" } } }) : route.continue()));
  await input(page).fill("costa");
  await expect(dialog(page).getByText(/Search failed/)).toBeVisible();
  await expect(input(page)).toBeFocused();
  await page.screenshot({ path: `${SHOTS}palette-error-1440.png` });
  fail = false;
  await dialog(page).getByRole("button", { name: "Retry" }).click();
  await expect(dialog(page).getByRole("option", { name: /Ana Costa/ })).toBeVisible();
  // network failure also lands in the error state
  await page.route(searchUrl, (route) => route.abort());
  await input(page).fill("costb");
  await expect(dialog(page).getByText(/Search failed/)).toBeVisible();
});

test("palette: a slow stale response never overwrites the latest results", async ({ page }) => {
  await setup(page);
  await page.route(searchUrl, async (route) => {
    const q = new URL(route.request().url()).searchParams.get("q");
    const hit = (title: string) => ({ groups: [{ type: "contacts", label: "Contacts", hits: [{ id: "00000000-0000-4000-8000-000000000001", type: "contacts", title, href: "/x" }] }] });
    if (q === "ana") { await new Promise((r) => setTimeout(r, 1500)); return route.fulfill({ json: hit("STALE RESULT") }); }
    return route.fulfill({ json: hit("FRESH RESULT") });
  });
  await page.keyboard.press("Control+k");
  await input(page).fill("ana");
  await page.waitForTimeout(350); // the slow request is now in flight
  await input(page).fill("anab");
  await expect(dialog(page).getByRole("option", { name: /FRESH RESULT/ })).toBeVisible();
  await page.waitForTimeout(1600);
  await expect(dialog(page).getByText("STALE RESULT")).toHaveCount(0);
  await expect(dialog(page).getByRole("option", { name: /FRESH RESULT/ })).toBeVisible();
});

test("palette: focus returns to the trigger, axe clean, no overflow at 375/768/1440, touch targets", async ({ page }) => {
  test.setTimeout(120_000);
  await setup(page);
  for (const s of [{ n: "1440", w: 1440, h: 900 }, { n: "768", w: 768, h: 1024 }, { n: "375", w: 375, h: 812 }]) {
    await page.setViewportSize({ width: s.w, height: s.h });
    const trigger = page.getByRole("button", { name: s.w < 640 ? "Open command menu" : /Search or jump to/ }).first();
    await trigger.focus();
    await trigger.click();
    await expect(dialog(page)).toBeVisible();
    await input(page).fill("ana");
    await expect(dialog(page).getByRole("option", { name: /Ana Costa/ })).toBeVisible();
    const r = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
    expect(r.violations.map((v) => `${s.n}: ${v.id} ${JSON.stringify(v.nodes[0]?.target)}`)).toEqual([]);
    const w = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }));
    expect(w.scroll).toBeLessThanOrEqual(w.client);
    const box = (await dialog(page).getByRole("option", { name: /Ana Costa/ }).boundingBox())!;
    expect(box.height).toBeGreaterThanOrEqual(36);
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(s.w);
    await page.screenshot({ path: `${SHOTS}palette-${s.n}.png` });
    await page.keyboard.press("Escape");
    await expect(dialog(page)).toBeHidden();
    await expect(trigger).toBeFocused();
  }
});

test("palette: touch tap opens a contact", async ({ browser, baseURL }) => {
  const ctx = await browser.newContext({ baseURL, hasTouch: true, isMobile: true, viewport: { width: 375, height: 812 } });
  const page = await ctx.newPage();
  const { workspaceId } = await setup(page);
  await page.setViewportSize({ width: 375, height: 812 });
  await page.getByRole("button", { name: "Open command menu" }).tap();
  await input(page).fill("ben");
  await dialog(page).getByRole("option", { name: /Ben Okafor/ }).tap();
  await page.waitForURL(new RegExp(`/w/${workspaceId}/contacts/[0-9a-f-]{36}$`));
  await ctx.close();
});
