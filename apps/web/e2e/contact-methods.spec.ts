import { createHmac } from "node:crypto";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import pg from "pg";
import { addMemberByEmail, createWorkspace } from "./helpers";
import { axe, DB, person } from "./channel-helpers";

/**
 * Automatic phone/email detection, end to end on MOCK Meta: signed webhooks are posted to the API's real ingress (the mock app secret below), the real worker extracts,
 * and the Inbox and Contact Details show the result. Nothing here proves real Meta behaviour. Run with E2E_META_MOCK=1 on a fresh database (docs/project/testing-report.md).
 */
const API = `http://localhost:${process.env.E2E_API_PORT ?? "8791"}`;
const APP_SECRET = "e2e-mock-app-secret-0123456789";
const digits = () => `8${Math.floor(Math.random() * 1e12).toString().padStart(12, "0")}`;

test.skip(process.env.E2E_META_MOCK !== "1", "needs the mock Meta API (E2E_META_MOCK=1)");

test.describe.serial("Detected phone/email (mock Meta)", () => {
  let owner: { ctx: BrowserContext; page: Page; email: string };
  let viewer: { ctx: BrowserContext; page: Page; email: string };
  let ws = "";
  let pageId = "";
  let db: pg.Client;
  const q = async (text: string, params: unknown[] = []) => (await db.query(text, params)).rows;

  /** One inbound Messenger message as Meta would deliver it, signed with the mock secret. */
  async function deliver(user: string, text: string, mid = `m_${digits()}`) {
    const body = JSON.stringify({ object: "page", entry: [{ id: pageId, time: Date.now(), messaging: [{ sender: { id: user }, recipient: { id: pageId }, timestamp: Date.now(), message: { mid, text } }] }] });
    const sig = "sha256=" + createHmac("sha256", APP_SECRET).update(body).digest("hex");
    const res = await fetch(`${API}/webhooks/meta/messenger`, { method: "POST", headers: { "content-type": "application/json", "x-hub-signature-256": sig }, body });
    expect(res.status).toBe(200);
    return mid;
  }
  const contactOf = async (user: string) => (await q("SELECT c.id, c.phone, c.email, pi_c.conv FROM contacts c JOIN platform_identities pi ON pi.contact_id = c.id LEFT JOIN LATERAL (SELECT id AS conv FROM conversations WHERE identity_id = pi.id LIMIT 1) pi_c ON true WHERE pi.external_user_id = $1", [user]))[0];
  const methodsOf = (contactId: string) => q("SELECT kind, value, is_primary FROM contact_methods WHERE contact_id = $1 ORDER BY kind, value", [contactId]);
  async function settle(user: string, expected: number) {
    await expect.poll(async () => { const c = await contactOf(user); return c ? (await methodsOf(c.id)).length : -1; }, { timeout: 20_000 }).toBe(expected);
    return (await contactOf(user))!;
  }
  const panel = (page: Page) => page.getByRole("region", { name: "Detected phone numbers and emails" });

  test.beforeAll(async ({ browser }) => {
    db = new pg.Client({ connectionString: `postgres://postgres:postgres@127.0.0.1:5436/${DB}` });
    await db.connect();
    owner = await person(browser, "Owner One");
    ws = await createWorkspace(owner.page, "Detect Co");
    viewer = await person(browser, "Viewer Two");
    await addMemberByEmail(ws, viewer.email, "viewer");
    pageId = digits();
    await q("INSERT INTO integration_accounts (workspace_id, platform, external_account_id, status, display_name) VALUES ($1,'messenger',$2,'connected','Detect page')", [ws, pageId]);
  });
  test.afterAll(async () => {
    await Promise.all([owner?.ctx.close(), viewer?.ctx.close()]);
    await db?.end();
  });

  test("a phone number in a new message is detected and shown in the Inbox panel with source and confidence", async () => {
    const u = digits();
    await deliver(u, "Hi, please call me on 01712-345678 about the order");
    const c = await settle(u, 1);
    expect(c.phone).toBe("+8801712345678");
    await owner.page.setViewportSize({ width: 1440, height: 900 });
    await owner.page.goto(`/w/${ws}/inbox/${c.conv}`);
    const detected = panel(owner.page);
    await expect(detected).toBeVisible();
    await expect(detected.getByRole("link", { name: "+8801712345678" })).toBeVisible();
    await expect(detected).toContainText("Messenger");
    await expect(detected).toContainText(/auto-detected \d+%/);
    await expect(detected).toContainText("primary");
    await expect(owner.page.getByRole("link", { name: "+8801712345678" }).first()).toBeVisible(); // also in the plain Phone row
    await axe(owner.page, "inbox-detected@1440");
  });

  test("an email in a new message is detected", async () => {
    const u = digits();
    await deliver(u, "you can mail me: Rahim.Uddin@Example.com thanks");
    const c = await settle(u, 1);
    expect(c.email).toBe("rahim.uddin@example.com");
    await owner.page.goto(`/w/${ws}/inbox/${c.conv}`);
    await expect(panel(owner.page).getByRole("link", { name: "rahim.uddin@example.com" })).toBeVisible();
    await expect(panel(owner.page)).toContainText(/Messenger .* auto-detected 95%/);
  });

  test("a phone and an email in the same message are both detected", async () => {
    const u = digits();
    await deliver(u, "Number 01812345678 and email team@shop.com.bd please");
    const c = await settle(u, 2);
    expect((await methodsOf(c.id)).map((m) => [m.kind, m.value])).toEqual([["email", "team@shop.com.bd"], ["phone", "+8801812345678"]]);
    await owner.page.goto(`/w/${ws}/inbox/${c.conv}`);
    await expect(panel(owner.page).getByRole("link", { name: "team@shop.com.bd" })).toBeVisible();
    await expect(panel(owner.page).getByRole("link", { name: "+8801812345678" })).toBeVisible();
  });

  test("an existing contact phone and email stay unchanged; new values are kept as separate detected methods", async () => {
    const u = digits();
    await deliver(u, "hello");
    await expect.poll(async () => !!(await contactOf(u)), { timeout: 20_000 }).toBe(true);
    const c0 = (await contactOf(u))!;
    await q("UPDATE contacts SET phone = '01999999999', phone_normalized = '01999999999', email = 'owner@shop.com', email_normalized = 'owner@shop.com' WHERE id = $1", [c0.id]);
    await deliver(u, "my other number is +8801555000111 or write to other@shop.com");
    const c = await settle(u, 2);
    expect([c.phone, c.email]).toEqual(["01999999999", "owner@shop.com"]); // what a person entered is never overwritten
    expect((await methodsOf(c.id)).every((m) => m.is_primary === false)).toBe(true);
    await owner.page.goto(`/w/${ws}/inbox/${c.conv}`);
    await expect(owner.page.getByRole("link", { name: "01999999999" })).toBeVisible();
    await expect(owner.page.getByRole("link", { name: "owner@shop.com" }).first()).toBeVisible();
    await expect(panel(owner.page).getByRole("link", { name: "+8801555000111" })).toBeVisible();
    await expect(panel(owner.page).getByRole("link", { name: "other@shop.com" })).toBeVisible();
  });

  test("a duplicate webhook delivery and repeated numbers do not create duplicate methods", async () => {
    const u = digits();
    const mid = await deliver(u, "call 01712345678");
    const c = await settle(u, 1);
    await deliver(u, "call 01712345678", mid); // Meta redelivers the same message
    await deliver(u, "again +880 1712 345678");
    await deliver(u, "third message without any number"); // a later message lands after the duplicates were handled
    await expect.poll(async () => Number((await q("SELECT count(*) FROM messages m JOIN conversations c ON c.id = m.conversation_id WHERE c.id = $1", [c.conv]))[0].count), { timeout: 20_000 }).toBe(3);
    expect(await methodsOf(c.id)).toHaveLength(1);
    await owner.page.goto(`/w/${ws}/inbox/${c.conv}`);
    await expect(panel(owner.page).getByRole("listitem")).toHaveCount(1);
  });

  test("Contact Details separates detected from entered values and lets an editor correct and remove them; a viewer cannot", async () => {
    const u = digits();
    await deliver(u, "reach me at 01712345678 or a@b.com");
    const c = await settle(u, 2);
    const page = owner.page;
    await page.goto(`/w/${ws}/contacts/${c.id}`);
    const section = page.getByRole("heading", { name: "Detected from conversations", level: 2 }).locator("xpath=ancestor::*[@data-panel][1]");
    await expect(section).toContainText("Not verified");
    await expect(section.getByText("Auto-detected, unverified")).toHaveCount(2);
    await expect(section).toContainText(/Messenger · Phone · \d+% confidence · detected /);
    await axe(page, "contact-detected@1440");

    // correct the phone
    await section.getByRole("button", { name: /Correct phone number \+8801712345678/ }).click();
    await section.getByLabel("Corrected phone number").fill("not a number");
    await section.getByRole("button", { name: "Save" }).click();
    await expect(section.getByRole("alert")).toBeVisible();
    await section.getByLabel("Corrected phone number").fill("01712-999888");
    await section.getByRole("button", { name: "Save" }).click();
    await expect(section.getByRole("link", { name: "+8801712999888" })).toBeVisible();
    await expect(section).toContainText(/corrected /);
    expect((await contactOf(u))!.phone).toBe("+8801712999888"); // the auto-filled primary followed the correction

    // remove the email (not the primary phone): needs a confirmation
    await section.getByRole("button", { name: /Remove email a@b.com/ }).click();
    await section.getByRole("button", { name: /Confirm remove email a@b.com/ }).click();
    await expect(section.getByRole("link", { name: "a@b.com" })).toHaveCount(0);
    expect((await methodsOf(c.id)).map((m) => m.kind)).toEqual(["phone"]);

    // a viewer sees the values but no way to change them
    await viewer.page.goto(`/w/${ws}/contacts/${c.id}`);
    const vs = viewer.page.getByRole("heading", { name: "Detected from conversations", level: 2 }).locator("xpath=ancestor::*[@data-panel][1]");
    await expect(vs.getByRole("link", { name: "+8801712999888" })).toBeVisible();
    await expect(vs.getByRole("button")).toHaveCount(0);
    // audit trail exists and holds no values
    const audit = await q("SELECT action, summary FROM audit_log WHERE entity_id = $1 AND action LIKE 'contact.method_%' ORDER BY created_at", [c.id]);
    expect(audit.map((a) => a.action)).toEqual(expect.arrayContaining(["contact.method_extracted", "contact.method_corrected", "contact.method_deleted"]));
    expect(JSON.stringify(audit)).not.toMatch(/1712|a@b\.com/);
  });
});
