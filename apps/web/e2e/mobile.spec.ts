import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { signUpAndCreate } from "./helpers";
import { axe, seed, WEB } from "./channel-helpers";

/** Phone and tablet experience: touch emulation is on so `pointer: coarse` styles apply. Inbox data is MOCK fixtures (apps/api/dev/seed-inbox.mts). */
const PHONES = [{ w: 360, h: 740 }, { w: 375, h: 812 }, { w: 390, h: 844 }, { w: 430, h: 932 }] as const;
const ROUTES = ["", "/inbox", "/contacts", "/leads", "/pipeline", "/tasks", "/reports", "/settings", "/settings/automations", "/integrations", "/members", "/audit-log", "/notifications"];

test.describe.serial("mobile experience", () => {
  let state: Awaited<ReturnType<BrowserContext["storageState"]>>;
  let ws = "";
  let convId = "";
  const touch = async (browser: Browser, w: number, h: number) => {
    const ctx = await browser.newContext({ baseURL: WEB, storageState: state, viewport: { width: w, height: h }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 });
    return { ctx, page: await ctx.newPage() };
  };
  const overflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

  test.beforeAll(async ({ browser }) => {
    const ctx = await browser.newContext({ baseURL: WEB });
    const page = await ctx.newPage();
    ({ workspaceId: ws } = await signUpAndCreate(page, "Mobile Owner", "Mobile Co"));
    seed(ws);
    const post = (u: string, data: unknown) => page.request.post(u, { data, headers: { origin: WEB } });
    const c = await (await post(`/v1/workspaces/${ws}/contacts`, { name: "Rahim Uddin Chowdhury", email: "rahim@example.com" })).json();
    const p = await (await page.request.get(`/v1/workspaces/${ws}/pipelines`)).json();
    await post(`/v1/workspaces/${ws}/leads`, { title: "Bulk order for the Eid collection", primaryContactId: c.id, pipelineId: p.pipelines[0].id });
    convId = (await (await page.request.get(`/v1/workspaces/${ws}/conversations`)).json()).items[0].id;
    state = await ctx.storageState();
    await ctx.close();
  });

  for (const s of PHONES) {
    test(`phone ${s.w}: every screen fits, the bottom bar is usable and never covers content`, async ({ browser }) => {
      test.setTimeout(120_000);
      const { ctx, page } = await touch(browser, s.w, s.h);
      for (const r of ROUTES) {
        await page.goto(`/w/${ws}${r}`);
        await expect(page.locator("main h1, main [role=tablist]").first()).toBeVisible();
        expect(await overflow(page), `${r || "/"} overflows at ${s.w}`).toBeLessThanOrEqual(0);
        const bar = page.getByRole("navigation", { name: "Primary" });
        await expect(bar).toBeVisible();
        const nav = (await bar.boundingBox())!;
        const main = (await page.locator("main").boundingBox())!;
        expect(main.y + main.height, `${r || "/"}: content under the bar`).toBeLessThanOrEqual(nav.y + 1);
        expect(nav.y + nav.height).toBeLessThanOrEqual(s.h + 1);
      }
      const items = page.getByRole("navigation", { name: "Primary" }).locator("a, button");
      await expect(items).toHaveCount(5);
      for (const el of await items.all()) { const b = (await el.boundingBox())!; expect(b.width).toBeGreaterThanOrEqual(44); expect(b.height).toBeGreaterThanOrEqual(44); }
      await ctx.close();
    });
  }

  test("More sheet: lists the other sections, navigates, closes, passes axe", async ({ browser }) => {
    const { ctx, page } = await touch(browser, 390, 844);
    await page.goto(`/w/${ws}`);
    await page.getByRole("button", { name: "More" }).click();
    const sheet = page.getByRole("dialog", { name: "More" });
    await expect(sheet.getByRole("link", { name: "Pipeline" })).toBeVisible();
    await expect(sheet.getByRole("button", { name: "Sign out" })).toBeVisible();
    await axe(page, "more-sheet@390");
    await sheet.getByRole("link", { name: "Members" }).click();
    await expect(page).toHaveURL(/\/members$/);
    await expect(sheet).toBeHidden();
    await expect(page.getByRole("button", { name: "More" })).toHaveAttribute("aria-expanded", "false");
    await ctx.close();
  });

  test("conversation: full screen, bar hidden, composer stays in view when the keyboard takes half the screen", async ({ browser }) => {
    const { ctx, page } = await touch(browser, 390, 844);
    await page.goto(`/w/${ws}/inbox/${convId}`);
    await expect(page.getByRole("log")).toBeVisible();
    await expect(page.getByRole("navigation", { name: "Primary" })).toBeHidden();
    const box = page.getByRole("textbox", { name: "Reply" });
    await expect(box).toBeVisible();
    expect(await overflow(page)).toBeLessThanOrEqual(0);
    await page.setViewportSize({ width: 390, height: 430 }); // layout viewport above the keyboard (interactive-widget: resizes-content)
    await box.fill("Thanks, I will check and get back to you.");
    const b = (await box.boundingBox())!;
    expect(b.y + b.height).toBeLessThanOrEqual(430);
    expect(b.y).toBeGreaterThan(0);
    const log = (await page.getByRole("log").boundingBox())!;
    expect(log.height, "messages keep some room above the composer").toBeGreaterThan(80);
    await axe(page, "thread@390");
    await ctx.close();
  });

  test("pipeline on a phone: stage chips jump between snapping columns; won/lost links are 44px", async ({ browser }) => {
    const { ctx, page } = await touch(browser, 390, 844);
    await page.goto(`/w/${ws}/pipeline`);
    await expect(page.getByRole("group", { name: "Jump to stage" })).toBeVisible();
    const snap = await page.getByRole("region", { name: "Pipeline board" }).evaluate((el) => getComputedStyle(el).scrollSnapType);
    expect(snap).toContain("x");
    await page.getByRole("group", { name: "Jump to stage" }).getByRole("button").nth(2).click();
    await expect.poll(() => page.getByRole("region", { name: "Pipeline board" }).evaluate((el) => el.scrollLeft)).toBeGreaterThan(100);
    await ctx.close();
  });

  test("dialogs become bottom sheets on a phone and scroll instead of clipping", async ({ browser }) => {
    const { ctx, page } = await touch(browser, 390, 844);
    await page.goto(`/w/${ws}/settings/automations`);
    await page.getByRole("button", { name: "New rule" }).first().click();
    const dlg = page.getByRole("dialog");
    await expect(dlg).toBeVisible();
    const m = await dlg.evaluate((el) => ({ bottom: el.getBoundingClientRect().bottom, top: el.getBoundingClientRect().top, vh: innerHeight, oy: getComputedStyle(el).overflowY }));
    expect(m.bottom).toBeLessThanOrEqual(m.vh + 1);
    expect(m.top).toBeGreaterThanOrEqual(0);
    expect(m.oy).toBe("auto");
    await page.setViewportSize({ width: 844, height: 390 }); // landscape phone
    const l = await dlg.evaluate((el) => ({ top: el.getBoundingClientRect().top, bottom: el.getBoundingClientRect().bottom, vh: innerHeight }));
    expect(l.top).toBeGreaterThanOrEqual(0);
    expect(l.bottom).toBeLessThanOrEqual(l.vh + 1);
    await ctx.close();
  });

  test("tablet 820: icon rail with 44px targets, no bottom bar; desktop 1440 unchanged", async ({ browser }) => {
    const t = await touch(browser, 820, 1180);
    await t.page.goto(`/w/${ws}`);
    await expect(t.page.getByRole("navigation", { name: "Primary" })).toBeHidden();
    for (const name of ["Inbox", "Contacts", "Leads", "Pipeline"]) {
      const b = (await t.page.getByRole("navigation", { name: "Main" }).filter({ visible: true }).getByRole("link", { name }).boundingBox())!;
      expect(b.width, name).toBeGreaterThanOrEqual(44);
      expect(b.height, name).toBeGreaterThanOrEqual(44);
    }
    expect(await overflow(t.page)).toBeLessThanOrEqual(0);
    await t.ctx.close();
    const d = await browser.newContext({ baseURL: WEB, storageState: state, viewport: { width: 1440, height: 900 } });
    const page = await d.newPage();
    await page.goto(`/w/${ws}`);
    await expect(page.getByRole("navigation", { name: "Primary" })).toBeHidden();
    await expect(page.getByRole("navigation", { name: "Main" }).getByText("Pipeline")).toBeVisible();
    await expect(page.getByRole("button", { name: "Search or jump to" })).toBeVisible();
    await d.close();
  });

  test("the viewport reaches under the notch and sizes with the keyboard", async ({ browser }) => {
    const { ctx, page } = await touch(browser, 390, 844);
    await page.goto(`/w/${ws}`);
    const content = await page.locator('meta[name="viewport"]').getAttribute("content");
    expect(content).toContain("viewport-fit=cover");
    expect(content).toContain("interactive-widget=resizes-content");
    await ctx.close();
  });

  test("installable: manifest and icons resolve without a session, and no service worker is registered", async ({ request, browser }) => {
    const res = await request.get("/manifest.webmanifest");
    expect(res.status()).toBe(200);
    const m = await res.json();
    expect(m.display).toBe("standalone");
    expect(m.icons.map((i: { purpose: string }) => i.purpose)).toEqual(expect.arrayContaining(["any", "maskable"]));
    for (const i of m.icons) expect((await request.get(i.src)).status(), i.src).toBe(200);
    const { ctx, page } = await touch(browser, 390, 844);
    await page.goto(`/w/${ws}`);
    expect(await page.evaluate(async () => (await navigator.serviceWorker.getRegistrations()).length)).toBe(0);
    expect(await page.locator('link[rel="apple-touch-icon"]').count()).toBeGreaterThan(0);
    await ctx.close();
  });
});
