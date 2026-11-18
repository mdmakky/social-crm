import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { addMemberByEmail, register, signUpAndCreate } from "./helpers";
import { axe, WEB } from "./channel-helpers";

/** The Leads list and the lead page on phones and tablets (touch emulation on, so `pointer: coarse` styles apply). Seeded through the API; mock-free. */
test.describe.serial("leads on phones", () => {
  let state: Awaited<ReturnType<BrowserContext["storageState"]>>;
  let ws = "";
  let sam = "";
  let anaId = "";
  let lastStageName = "";
  const LONG = "Waiting for the customer to confirm the delivery address";
  const touch = async (browser: Browser, w: number, h: number) => {
    const ctx = await browser.newContext({ baseURL: WEB, storageState: state, viewport: { width: w, height: h }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 });
    return { ctx, page: await ctx.newPage() };
  };
  /** Neither the page nor the scrolling content area may be wider than the screen. */
  const overflow = (page: Page) => page.evaluate(() => Math.max(document.documentElement.scrollWidth - document.documentElement.clientWidth, (document.querySelector("main")?.scrollWidth ?? 0) - (document.querySelector("main")?.clientWidth ?? 0)));
  const list = (page: Page, q = "") => page.goto(`/w/${ws}/contacts${q}`).then(() => expect(page.getByRole("heading", { level: 1, name: "Leads" })).toBeVisible());

  test.beforeAll(async ({ browser }) => {
    const ctx = await browser.newContext({ baseURL: WEB });
    const page = await ctx.newPage();
    ({ workspaceId: ws } = await signUpAndCreate(page, "Lead Mobile Owner", "Lead Mobile Co"));
    const post = (u: string, data: unknown) => page.request.post(u, { data, headers: { origin: WEB } });
    const put = (u: string, data: unknown) => page.request.put(u, { data, headers: { origin: WEB } });
    // a second person so the Agent filter has something to pick
    const p2 = await (await browser.newContext()).newPage();
    const email = await register(p2, "Sam Agent");
    await addMemberByEmail(ws, email, "agent");
    const members = await (await page.request.get(`/v1/workspaces/${ws}/members`)).json();
    sam = (members.items ?? members).find((m: { name: string }) => m.name === "Sam Agent").userId;
    // 12 stages in total, one with a very long name
    const cfg = await (await page.request.get(`/v1/workspaces/${ws}/pipelines`)).json();
    const pipe = cfg.pipelines[0];
    for (let i = pipe.stages.length; i < 12; i++) {
      const r = await post(`/v1/workspaces/${ws}/pipelines/${pipe.id}/stages`, { name: i === 8 ? LONG : `Extra stage ${i}`, defaultProbability: 50 });
      expect(r.status()).toBe(201);
    }
    const stages = (await (await page.request.get(`/v1/workspaces/${ws}/pipelines`)).json()).pipelines[0].stages.filter((s: { archived: boolean }) => !s.archived);
    lastStageName = stages.at(-1).name;
    const names = ["Ana Costa", "Ben Okafor", "Chloe Park", "Dev Patel", "Eli Moreau", "Fatima Noor", "Gus Hall", "Hana Sato"];
    for (const [i, name] of names.entries()) {
      const c = await (await post(`/v1/workspaces/${ws}/contacts`, { name, company: `${name.split(" ")[1]} & Co`, email: `m${i}@leads.example`, ownerUserId: i % 2 ? sam : undefined })).json();
      if (i === 0) anaId = c.id;
      await put(`/v1/workspaces/${ws}/contacts/${c.id}/lead`, { stageId: stages[Math.min(i, stages.length - 1)].id, valueMinor: 100000 * (i + 1), currency: "USD" });
    }
    state = await ctx.storageState();
    await ctx.close();
  });

  for (const w of [375, 320]) {
    test(`${w}px: the list and the lead page never scroll sideways; header, search and Add lead are reachable`, async ({ browser }) => {
      const { ctx, page } = await touch(browser, w, 740);
      await list(page);
      expect(await overflow(page), "list overflows").toBeLessThanOrEqual(0);
      await expect(page.getByRole("button", { name: "Add lead" })).toBeVisible();
      await expect(page.getByLabel("Search leads")).toBeVisible();
      const search = (await page.getByLabel("Search leads").boundingBox())!;
      expect(search.width).toBeGreaterThan(w * 0.4);
      expect(await page.getByLabel("Search leads").evaluate((el) => parseFloat(getComputedStyle(el).fontSize))).toBeGreaterThanOrEqual(16); // no iOS zoom
      await page.getByRole("link", { name: "Ana Costa" }).click();
      await expect(page.getByRole("heading", { level: 1, name: "Ana Costa" })).toBeVisible();
      expect(await overflow(page), "lead page overflows").toBeLessThanOrEqual(0);
      await ctx.close();
    });
  }

  test("the stage strip scrolls sideways, snaps, keeps the active stage in view and every item is at least 44 px", async ({ browser }) => {
    test.setTimeout(90_000);
    const { ctx, page } = await touch(browser, 320, 740);
    await list(page);
    const strip = page.getByRole("group", { name: "Filter by stage" });
    const box = async () => (await strip.boundingBox())!;
    expect(await strip.evaluate((el) => el.scrollWidth > el.clientWidth), "12 stages do not fit in one screen").toBe(true);
    expect(await strip.evaluate((el) => getComputedStyle(el).scrollSnapType)).toContain("x");
    for (const b of await strip.getByRole("button").all()) { const r = (await b.boundingBox())!; expect(r.height).toBeGreaterThanOrEqual(44); expect(r.width).toBeGreaterThanOrEqual(44); }
    expect(await overflow(page)).toBeLessThanOrEqual(0);
    // tapping the last stage scrolls it into view
    const last = strip.getByRole("button", { name: new RegExp(lastStageName) });
    await last.scrollIntoViewIfNeeded();
    await last.click();
    await expect(last).toHaveAttribute("aria-pressed", "true");
    await expect(page).toHaveURL(/stageId=/);
    await expect.poll(async () => { const s = await box(); const b = (await last.boundingBox())!; return b.x >= s.x - 1 && b.x + b.width <= s.x + s.width + 1; }).toBe(true);
    // a second tap clears it
    await last.click();
    await expect(strip.getByRole("button", { name: /^All/ })).toHaveAttribute("aria-pressed", "true");
    // a reload on a stage URL starts with that stage in view
    const long = strip.getByRole("button", { name: new RegExp(LONG.slice(0, 20)) });
    await long.scrollIntoViewIfNeeded();
    await long.click();
    await expect(page).toHaveURL(/stageId=/); // the URL follows the click after a short debounce
    await page.reload();
    const again = page.getByRole("group", { name: "Filter by stage" }).getByRole("button", { name: new RegExp(LONG.slice(0, 20)) });
    await expect(again).toHaveAttribute("aria-pressed", "true");
    await expect.poll(async () => { const s = (await page.getByRole("group", { name: "Filter by stage" }).boundingBox())!; const b = (await again.boundingBox())!; return b.x >= s.x - 1 && b.x + b.width <= s.x + s.width + 1; }).toBe(true);
    expect(await overflow(page)).toBeLessThanOrEqual(0);
    await ctx.close();
  });

  test("rows are two-line cards with 44 px targets; the whole card opens the lead", async ({ browser }) => {
    const { ctx, page } = await touch(browser, 375, 812);
    await list(page);
    const items = page.getByRole("list", { name: "Leads" }).getByRole("listitem");
    await expect(items).toHaveCount(8);
    for (const li of await items.all()) expect((await li.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    const first = items.first();
    await expect(first.getByRole("button", { name: /^Stage of / })).toBeVisible();
    expect((await first.getByRole("button", { name: /^Stage of / }).boundingBox())!.height).toBeGreaterThanOrEqual(44);
    expect((await first.getByRole("link").boundingBox())!.height).toBeGreaterThanOrEqual(56); // the link is the card, not just the name
    await first.click({ position: { x: 30, y: 30 } }); // tap on the avatar side
    await expect(page).toHaveURL(new RegExp(`/contacts/[0-9a-f-]{36}$`));
    await ctx.close();
  });

  test("Agent and Filters are one bottom sheet: Apply filters, the count shows on the trigger, Clear removes it", async ({ browser }) => {
    const { ctx, page } = await touch(browser, 375, 812);
    await list(page);
    await expect(page.getByRole("button", { name: "Agent" })).toHaveCount(0); // one trigger on a phone
    await page.getByRole("button", { name: "Filters", exact: true }).click();
    const sheet = page.getByRole("dialog", { name: "Filters" });
    await expect(sheet).toBeVisible();
    await expect.poll(async () => { const b = await sheet.boundingBox(); return b ? b.y + b.height : 99999; }).toBeLessThanOrEqual(812 + 1); // inside the screen once it has slid in
    const row = sheet.getByRole("checkbox", { name: /Sam Agent/ });
    expect((await row.locator("xpath=ancestor::label").boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await row.check();
    await expect(page.getByRole("list", { name: "Leads", includeHidden: true }).getByRole("listitem", { includeHidden: true })).toHaveCount(8); // the page behind the sheet is inert; nothing changes until Apply
    await sheet.getByRole("button", { name: "Apply" }).click();
    await expect(sheet).toBeHidden();
    await expect(page.getByRole("list", { name: "Leads" }).getByRole("listitem")).toHaveCount(4);
    await expect(page.getByRole("button", { name: "Filters, 1 on" })).toBeVisible();
    await expect(page).toHaveURL(/ownerId=/);
    await expect(page.getByText(/^4 leads? · \d+ enquir(y|ies) match your filters/)).toBeVisible();
    await page.getByRole("button", { name: "Filters, 1 on" }).click();
    await page.getByRole("dialog", { name: "Filters" }).getByRole("button", { name: "Clear" }).click();
    await expect(page.getByRole("button", { name: "Filters", exact: true })).toBeVisible();
    await expect(page.getByRole("list", { name: "Leads" }).getByRole("listitem")).toHaveCount(8);
    await ctx.close();
  });

  test("the stage pill opens a bottom sheet; picking a stage changes the lead", async ({ browser }) => {
    const { ctx, page } = await touch(browser, 375, 812);
    await list(page);
    await page.getByRole("button", { name: /^Stage of Ana Costa/ }).click();
    const sheet = page.getByRole("dialog", { name: "Change stage" });
    await expect(sheet).toBeVisible();
    for (const b of await sheet.getByRole("button").all()) if ((await b.getAttribute("aria-label")) !== "Close") expect((await b.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await sheet.getByRole("button", { name: "Contacted" }).click();
    await expect(sheet).toBeHidden();
    await expect(page.getByRole("button", { name: /^Stage of Ana Costa: Contacted/ })).toBeVisible();
    await ctx.close();
  });

  test("Select mode: checkboxes, a sticky bottom bar above the navigation, Change stage for the selection, Done leaves", async ({ browser }) => {
    const { ctx, page } = await touch(browser, 375, 812);
    await list(page);
    await expect(page.getByRole("checkbox")).toHaveCount(0);
    await page.getByRole("button", { name: "More actions" }).click();
    await page.getByRole("menuitem", { name: "Select leads" }).click();
    const bar = page.getByRole("region", { name: "Bulk actions" });
    await expect(bar).toBeVisible();
    await page.getByRole("checkbox", { name: "Select Ben Okafor" }).check();
    await page.getByRole("checkbox", { name: "Select Chloe Park" }).check();
    await expect(bar).toContainText("2 selected");
    const nav = (await page.getByRole("navigation", { name: "Primary" }).boundingBox())!;
    const b = (await bar.boundingBox())!;
    expect(b.y + b.height).toBeLessThanOrEqual(nav.y + 1); // never under the bottom navigation
    await page.evaluate(() => document.querySelector("main")!.scrollTo(0, 9999));
    const b2 = (await bar.boundingBox())!;
    expect(b2.y + b2.height).toBeLessThanOrEqual(nav.y + 1);
    expect(b2.y).toBeGreaterThan(0);
    for (const btn of await bar.getByRole("button").all()) expect((await btn.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await bar.getByRole("button", { name: "Change stage" }).click();
    const dialog = page.getByRole("dialog", { name: /Change stage of 2 leads/ });
    await dialog.getByLabel(/Stage|New stage/).selectOption({ label: "Qualified" });
    await dialog.getByRole("button", { name: /Move 2 leads/ }).click();
    await expect(page.getByText("2 leads moved to Qualified.")).toBeVisible();
    await expect(bar).toBeHidden(); // Select mode ends after the change
    await ctx.close();
  });

  test("the lead page: stepper with labels only on the current stage, stage list, autosaved value and owner", async ({ browser }) => {
    const { ctx, page } = await touch(browser, 375, 812);
    await page.goto(`/w/${ws}/contacts/${anaId}`);
    await expect(page.getByRole("heading", { level: 1, name: "Ana Costa" })).toBeVisible();
    const steps = page.getByRole("list", { name: "Stage" }).getByRole("button");
    for (const s of await steps.all()) expect((await s.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    expect(await page.getByRole("list", { name: "Stage" }).locator("span:visible", { hasText: /\S/ }).count()).toBe(1); // one visible label: the current stage
    await expect(page.getByRole("combobox", { name: "Stage" })).toBeVisible(); // list fallback
    // value autosaves on blur; no Update button exists
    await expect(page.getByRole("button", { name: "Update" })).toHaveCount(0);
    const value = page.getByLabel("Value", { exact: true });
    await value.fill("2500.50");
    await value.blur();
    await expect(page.getByText("Saved", { exact: true })).toBeVisible();
    await page.reload();
    await expect(page.getByLabel("Value", { exact: true })).toHaveValue("2500.50");
    await page.getByLabel("Owner", { exact: true }).selectOption({ label: "Sam Agent" });
    await expect(page.getByText("Saved", { exact: true })).toBeVisible();
    // details and value access are collapsed
    await expect(page.getByLabel("Company")).toBeHidden();
    await page.getByText("Details", { exact: true }).click();
    await expect(page.getByLabel("Company")).toBeVisible();
    expect(await overflow(page)).toBeLessThanOrEqual(0);
    await ctx.close();
  });

  test("axe: no serious or critical violations on the list and the lead page at 1440, 768 and 375", async ({ browser }) => {
    test.setTimeout(120_000);
    for (const [w, h] of [[1440, 900], [768, 1024], [375, 812]] as const) {
      const { ctx, page } = await touch(browser, w, h);
      await list(page);
      await axe(page, `leads list ${w}`);
      await page.goto(`/w/${ws}/contacts/${anaId}`);
      await expect(page.getByRole("heading", { level: 1, name: "Ana Costa" })).toBeVisible();
      await axe(page, `lead page ${w}`);
      await ctx.close();
    }
  });
});
