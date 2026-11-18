import { createHmac } from "node:crypto";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import pg from "pg";
import { createWorkspace } from "./helpers";
import { axe, DB, person } from "./channel-helpers";

/**
 * Enquiries (D310): a person with no phone number is an ENQUIRY, not a lead. A phone (typed, detected in a message, or the WhatsApp sender id) makes them a lead in the first stage.
 * MOCK Meta only (E2E_META_MOCK=1): signed webhooks go to the real ingress and the real worker extracts. Nothing here proves real Meta behaviour.
 */
const API = `http://localhost:${process.env.E2E_API_PORT ?? "8791"}`;
const APP_SECRET = "e2e-mock-app-secret-0123456789";
const SNAP = "test-results/enquiries";
const digits = () => `8${Math.floor(Math.random() * 1e12).toString().padStart(12, "0")}`;

test.skip(process.env.E2E_META_MOCK !== "1", "needs the mock Meta API (E2E_META_MOCK=1)");

test.describe.serial("Enquiries (mock Meta)", () => {
  let owner: { ctx: BrowserContext; page: Page; email: string };
  let ws = "", wsEmpty = "";
  let pageId = "", waPhoneId = "";
  let db: pg.Client;
  const q = async (text: string, params: unknown[] = []) => (await db.query(text, params)).rows;
  const post = async (path: string, body: string) => {
    const sig = "sha256=" + createHmac("sha256", APP_SECRET).update(body).digest("hex");
    const res = await fetch(`${API}/webhooks/meta/${path}`, { method: "POST", headers: { "content-type": "application/json", "x-hub-signature-256": sig }, body });
    expect(res.status).toBe(200);
  };
  const messenger = (user: string, text: string) => post("messenger", JSON.stringify({ object: "page", entry: [{ id: pageId, time: Date.now(), messaging: [{ sender: { id: user }, recipient: { id: pageId }, timestamp: Date.now(), message: { mid: `m_${digits()}`, text } }] }] }));
  const whatsapp = (from: string, text: string) => post("whatsapp", JSON.stringify({ object: "whatsapp_business_account", entry: [{ id: digits(), changes: [{ field: "messages", value: { messaging_product: "whatsapp", metadata: { display_phone_number: "15550100", phone_number_id: waPhoneId }, contacts: [{ profile: { name: "WA Customer" }, wa_id: from }], messages: [{ from, id: `wamid.${digits()}`, timestamp: String(Math.floor(Date.now() / 1000)), type: "text", text: { body: text } }] } }] }] }));
  const contactOf = async (user: string) => (await q("SELECT c.id, c.name, c.phone FROM contacts c JOIN platform_identities pi ON pi.contact_id = c.id WHERE pi.external_user_id = $1 AND c.workspace_id = $2", [user, ws]))[0] as { id: string; name: string; phone: string | null } | undefined;
  const arrive = async (user: string) => { await expect.poll(async () => (await contactOf(user))?.id ?? "", { timeout: 25_000 }).not.toBe(""); return (await contactOf(user))!; };
  const strip = (page: Page) => page.getByRole("group", { name: "Filter by stage" });
  const tab = (page: Page) => strip(page).getByRole("button", { name: /^Enquiries/ });
  const enquiries = async (page: Page) => { await page.goto(`/w/${ws}/contacts?kind=enquiry`); await expect(tab(page)).toHaveAttribute("aria-pressed", "true"); };
  const noHScroll = async (page: Page) => expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);

  test.beforeAll(async ({ browser }) => {
    db = new pg.Client({ connectionString: `postgres://postgres:postgres@127.0.0.1:5436/${DB}` });
    await db.connect();
    owner = await person(browser, "Enq Owner");
    ws = await createWorkspace(owner.page, "Enquiry Co");
    await owner.page.goto("/onboarding");
    wsEmpty = await createWorkspace(owner.page, "Empty Enquiry Co");
    pageId = digits();
    waPhoneId = digits();
    await q("INSERT INTO integration_accounts (workspace_id, platform, external_account_id, status, display_name) VALUES ($1,'messenger',$2,'connected','Enq page')", [ws, pageId]);
    await q("INSERT INTO integration_accounts (workspace_id, platform, external_account_id, status, display_name) VALUES ($1,'whatsapp',$2,'connected','+1 555 0100')", [ws, waPhoneId]);
  });
  test.afterAll(async () => { await owner?.ctx.close(); await db?.end(); });

  test("empty state explains what enquiries are", async () => {
    const page = owner.page;
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`/w/${wsEmpty}/contacts`);
    await tab(page).click();
    await expect(page.getByText("People who wrote to you but have not given a phone number yet.")).toBeVisible();
    await expect(page).toHaveURL(/kind=enquiry/);
    await page.screenshot({ path: `${SNAP}-empty-1440.png` });
    await page.setViewportSize({ width: 375, height: 800 });
    await page.screenshot({ path: `${SNAP}-empty-375.png` });
  });

  test("a message from an unknown person with no phone is an enquiry, not a lead", async () => {
    const page = owner.page;
    const u = digits();
    await messenger(u, "Hi, what are your prices?");
    const c = await arrive(u);
    expect(c.phone).toBeNull();
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`/w/${ws}/contacts`);
    await expect(page.getByRole("link", { name: c.name })).toHaveCount(0); // not in Leads
    await expect(page.getByText(/^0 leads · 1 enquiry/)).toBeVisible();
    await expect(tab(page)).toContainText("1");
    await tab(page).click();
    const row = page.getByRole("listitem").filter({ hasText: c.name });
    await expect(row).toBeVisible();
    await expect(row).toContainText("Messenger");
    await expect(row).toContainText("what are your prices?");
    await expect(row.getByRole("button", { name: /Add phone/ })).toBeVisible();
    await expect(row.getByRole("link", { name: "Open in Inbox" })).toBeVisible();
    await expect(page.getByText("0 leads · 1 enquiry")).toBeVisible();
    await page.screenshot({ path: `${SNAP}-list-1440.png` });
    // the Enquiries tab comes before All; Back leaves it
    await strip(page).getByRole("button", { name: /^All/ }).click();
    await expect(page).not.toHaveURL(/kind=enquiry/);
    await page.goBack();
    await expect(tab(page)).toHaveAttribute("aria-pressed", "true");
    await axe(page, "enquiries@1440");
  });

  test("adding a phone moves the person to Leads, New, with a confirmation", async () => {
    const page = owner.page;
    await enquiries(page);
    const row = page.getByRole("listitem").first();
    const name = (await row.getByRole("link").first().textContent())!;
    await row.getByRole("button", { name: /Add phone/ }).click();
    const input = row.getByRole("textbox", { name: /Phone number for/ });
    await input.fill("12");
    await row.getByRole("button", { name: "Save" }).click();
    await expect(row.getByRole("alert")).toBeVisible(); // invalid number, row stays
    await page.screenshot({ path: `${SNAP}-addphone-error-1440.png` });
    await input.fill("01712-300400");
    await row.getByRole("button", { name: "Save" }).click();
    await expect(page.getByText("Moved to Leads, New")).toBeVisible();
    await expect(page.getByRole("link", { name })).toHaveCount(0);
    await expect(page.getByText("People who wrote to you but have not given a phone number yet.")).toBeVisible();
    await page.goto(`/w/${ws}/contacts`);
    await expect(page.getByRole("link", { name }).first()).toBeVisible();
    await expect(page.getByText(/^1 lead · 0 enquiries/)).toBeVisible();
    await strip(page).getByRole("button", { name: /^New/ }).click();
    await expect(page.getByRole("link", { name }).first()).toBeVisible(); // virtual first stage, no lead row
    expect(await q("SELECT 1 FROM leads l JOIN contacts c ON c.id = l.primary_contact_id WHERE c.workspace_id = $1 AND c.name = $2", [ws, name])).toHaveLength(0);
  });

  test("a phone found in a later message moves the person", async () => {
    const page = owner.page;
    const u = digits();
    await messenger(u, "Hello, do you deliver?");
    const c = await arrive(u);
    await enquiries(page);
    await expect(page.getByRole("listitem").filter({ hasText: c.name })).toBeVisible();
    await messenger(u, "My number is 01812-345678 please call");
    await expect.poll(async () => (await contactOf(u))?.phone ?? "", { timeout: 25_000 }).toBe("+8801812345678");
    await page.reload();
    await expect(page.getByRole("listitem").filter({ hasText: c.name })).toHaveCount(0);
    await page.goto(`/w/${ws}/contacts?search=${encodeURIComponent(c.name)}`);
    await expect(page.getByRole("link", { name: c.name }).first()).toBeVisible();
    // a person whose very first message has the number is a lead at once
    const u2 = digits();
    await messenger(u2, "Please call 01912-345678");
    const c2 = await arrive(u2);
    await page.goto(`/w/${ws}/contacts?search=${encodeURIComponent(c2.name)}`);
    await expect(page.getByRole("link", { name: c2.name }).first()).toBeVisible();
  });

  test("a WhatsApp sender is a lead immediately (the sender id is the number)", async () => {
    const page = owner.page;
    const from = `8801${Math.floor(Math.random() * 1e9).toString().padStart(9, "0")}`;
    await whatsapp(from, "Hi from WhatsApp");
    const c = await arrive(from);
    expect(c.phone).toBe(`+${from}`);
    await page.goto(`/w/${ws}/contacts?search=${encodeURIComponent(c.name)}`);
    await expect(page.getByRole("link", { name: c.name }).first()).toBeVisible();
    await enquiries(page);
    await expect(page.getByRole("listitem").filter({ hasText: c.name })).toHaveCount(0);
  });

  test("an enquiry's own page hides the stage stepper and puts Add phone first; a phone gives the normal lead page", async () => {
    const page = owner.page;
    const u = digits();
    await messenger(u, "Question about shipping");
    const c = await arrive(u);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`/w/${ws}/contacts/${c.id}`);
    await expect(page.getByTestId("enquiry-reason")).toHaveText("Add a phone number to make this a lead.");
    await expect(page.getByRole("heading", { level: 1 })).toContainText("Enquiry");
    await expect(page.getByRole("button", { name: /^Won$/ })).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "Conversation" })).toBeVisible(); // other sections keep working
    await page.screenshot({ path: `${SNAP}-detail-1440.png` });
    await axe(page, "enquiry-detail@1440");
    await page.setViewportSize({ width: 375, height: 800 });
    await noHScroll(page);
    await page.screenshot({ path: `${SNAP}-detail-375.png` });
    await page.getByRole("button", { name: /Add phone for/ }).click();
    await page.getByRole("textbox", { name: /Phone number for/ }).fill("01712 999 888");
    await page.getByRole("button", { name: "Save" }).click();
    await expect(page.getByText("Moved to Leads, New")).toBeVisible();
    await expect(page.getByTestId("enquiry-reason")).toHaveCount(0);
    await expect(page.getByRole("button", { name: /^Won$/ }).first()).toBeVisible();
  });

  test("Add lead without a phone is saved as an enquiry and says so", async () => {
    const page = owner.page;
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`/w/${ws}/contacts`);
    await page.getByRole("button", { name: "Add lead" }).first().click();
    const dlg = page.getByRole("dialog");
    await dlg.getByLabel("Name").fill("Walk In Nophone");
    await expect(dlg.getByTestId("enquiry-hint")).toContainText("saved as an enquiry");
    await dlg.getByLabel("Phone").fill("01755 000111");
    await expect(dlg.getByTestId("enquiry-hint")).toHaveCount(0);
    await dlg.getByLabel("Phone").fill("");
    await dlg.getByRole("button", { name: "Add lead" }).click();
    await expect(page.getByText(/Saved as an enquiry/)).toBeVisible();
    await expect(tab(page)).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByRole("link", { name: "Walk In Nophone" })).toBeVisible();
  });

  test("phone: the tab scrolls with the strip, no sideways page scroll at 375 and 320, Add phone is usable", async () => {
    const page = owner.page;
    for (const w of [375, 320]) {
      await page.setViewportSize({ width: w, height: 760 });
      await enquiries(page);
      await noHScroll(page);
      const box = (await tab(page).boundingBox())!;
      expect(box.height).toBeGreaterThanOrEqual(44);
      await expect(page.getByRole("listitem").first()).toBeVisible();
      const add = page.getByRole("button", { name: /Add phone for/ }).first();
      expect((await add.boundingBox())!.height).toBeGreaterThanOrEqual(44);
      await add.click();
      const input = page.getByRole("textbox", { name: /Phone number for/ }).first();
      expect(await input.evaluate((el) => parseFloat(getComputedStyle(el).fontSize))).toBeGreaterThanOrEqual(16);
      expect((await input.boundingBox())!.height).toBeGreaterThanOrEqual(44);
      await noHScroll(page);
      if (w === 375) { await page.screenshot({ path: `${SNAP}-addphone-375.png` }); await page.screenshot({ path: `${SNAP}-list-375.png`, fullPage: true }); }
      await page.getByRole("button", { name: "Cancel" }).first().click();
    }
    await page.setViewportSize({ width: 375, height: 760 });
    await page.goto(`/w/${ws}/contacts`);
    await expect(tab(page)).toBeVisible();
    await page.screenshot({ path: `${SNAP}-leads-375.png` });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`/w/${ws}/contacts`);
    await expect(tab(page)).toBeVisible();
    await page.screenshot({ path: `${SNAP}-leads-1440.png` });
  });

  test("axe on the enquiries list at 768 and 375", async () => {
    const page = owner.page;
    for (const w of [768, 375]) {
      await page.setViewportSize({ width: w, height: 800 });
      await enquiries(page);
      await axe(page, `enquiries@${w}`);
    }
  });
});
