import { createHmac, randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { createWorkspace } from "./helpers";
import { axe, person } from "./channel-helpers";

/**
 * Email support inbox, end to end on the MOCK provider (run with E2E_META_MOCK=1, which also turns on the mock email provider). Nothing here talks to Mailgun or sends real email:
 * the "customer email" is a POST to our webhook signed with the public mock signing key, and the "sent" reply is recorded by the in-memory mock provider.
 */
const API = `http://localhost:${process.env.E2E_API_PORT ?? "8791"}`;
const MOCK_KEY = "mock-mailgun-signing-key-not-a-secret";
const SHOTS = "/tmp/em-shots";

function inboundFields(recipient: string, o: { from: string; subject: string; text: string; spf?: string; messageId: string }) {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const token = randomBytes(20).toString("hex");
  const headers = [["From", o.from], ["Subject", o.subject], ["Message-Id", `<${o.messageId}>`], ["X-Mailgun-Spf", o.spf ?? "Pass"], ["X-Mailgun-Dkim-Check-Result", o.spf ?? "Pass"]];
  const addr = /<([^>]+)>/.exec(o.from)?.[1] ?? o.from;
  return { recipient, from: o.from, sender: addr, subject: o.subject, "message-headers": JSON.stringify(headers), "body-plain": o.text, timestamp, token, signature: createHmac("sha256", MOCK_KEY).update(timestamp + token).digest("hex") };
}

test.describe.serial("Email channel (MOCK provider)", () => {
  let owner: { ctx: BrowserContext; page: Page; email: string };
  let ws = "";
  let address = "";

  test.beforeAll(async ({ browser }) => {
    mkdirSync(SHOTS, { recursive: true });
    owner = await person(browser, "Email Owner");
    ws = await createWorkspace(owner.page, "Email Co");
  });
  test.afterAll(async () => { await owner?.ctx.close(); });

  test("connect email: support address, plain DNS steps, collapsed technical details, mock check @1440 @375", async () => {
    const page = owner.page;
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`/w/${ws}/integrations?channel=email`);
    await expect(page.getByRole("heading", { name: "Email", level: 2 })).toBeVisible();
    await expect(page.getByText("Add an email address for support")).toBeVisible();
    await page.screenshot({ path: `${SHOTS}/email-empty-1440.png` });
    await page.getByRole("button", { name: "Create support address" }).click();
    const code = page.getByTestId("email-support-address");
    await expect(code).toBeVisible();
    address = ((await code.textContent()) ?? "").trim();
    expect(address).toMatch(/^support\+[a-z2-7]{20}@inbound\.mock\.example\.test$/);
    await page.screenshot({ path: `${SHOTS}/email-top-1440.png` });
    const panel = page.locator("[data-panel]").last();
    await expect(panel.getByText("MOCK", { exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: /Email/, level: 2 }).getByText("Not tested live", { exact: true })).toBeVisible();
    for (const t of ["Receive email.", "Allow sending.", "Sign your email.", "Protect your domain."]) await expect(panel.getByText(t)).toBeVisible();
    await expect(panel.getByText("v=spf1")).toBeHidden(); // technical details are collapsed
    await panel.getByText("Technical details").click();
    await expect(panel.getByText("v=spf1 include:mailgun.org ~all")).toBeVisible();
    await panel.getByRole("button", { name: "Check setup" }).click();
    await expect(panel.getByRole("list", { name: "Setup check result" })).toContainText("Mock result");
    await expect(panel.getByText("Checked (mock)")).toBeVisible();
    await page.screenshot({ path: `${SHOTS}/email-connected-1440.png`, fullPage: true });
    await axe(page, "email-panel@1440");
    await page.setViewportSize({ width: 375, height: 800 });
    await page.screenshot({ path: `${SHOTS}/email-connected-375.png`, fullPage: true });
    await code.scrollIntoViewIfNeeded();
    await page.getByRole("heading", { name: "Your support address" }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${SHOTS}/email-top-375.png` });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.setViewportSize({ width: 1440, height: 900 });
  });

  test("a customer email becomes a conversation; subject and plain text with line breaks; an unverified sender is badged", async () => {
    const page = owner.page;
    const post = (f: ReturnType<typeof inboundFields>) => page.request.post(`${API}/webhooks/email/inbound`, { form: f });
    const ok = await post(inboundFields(address, { from: "Ada Lovelace <ada@example.org>", subject: "Order 42 has not arrived", text: "Hello,\nmy order 42 has not arrived.\n\n<b>not bold</b> Thanks, Ada\n\nOn Mon, 1 Jan 2026, Support wrote:\n> old quoted text", messageId: `e2e-${Date.now()}@example.org` }));
    expect(ok.status()).toBe(200);
    expect((await post({ ...inboundFields(address, { from: "x@example.org", subject: "bad", text: "bad", messageId: "bad@x" }), signature: "0".repeat(64) })).status()).toBe(403);
    expect((await post(inboundFields(address, { from: "Mallory <ada@example.org>", subject: "Urgent: update your bank details", text: "Please send money.", spf: "Fail", messageId: `e2e-forged-${Date.now()}@example.org` }))).status()).toBe(200);
    await page.goto(`/w/${ws}/inbox`);
    await expect(page.getByRole("link", { name: /Ada Lovelace/ })).toBeVisible({ timeout: 20_000 });
    await expect(page.getByRole("link", { name: /Mallory/ })).toBeVisible();
    await page.getByRole("link", { name: /Ada Lovelace/ }).click();
    const log = page.getByRole("log", { name: /Messages with Ada Lovelace/ });
    await expect(log.getByTestId("email-subject")).toHaveText("Order 42 has not arrived");
    await expect(log).toContainText("my order 42 has not arrived.");
    await expect(log).toContainText("<b>not bold</b>"); // shown as text, never rendered as HTML
    await expect(log).not.toContainText("old quoted text"); // quoted reply stripped
    await expect(log.locator("b")).toHaveCount(0);
    const pre = await log.locator("p.whitespace-pre-wrap").first().evaluate((el) => getComputedStyle(el).whiteSpace);
    expect(pre).toBe("pre-wrap");
    await expect(log.getByText("Unverified sender")).toHaveCount(0);
    await page.screenshot({ path: `${SHOTS}/email-thread-1440.png` });
    await page.goto(`/w/${ws}/inbox`);
    await page.getByRole("link", { name: /Mallory/ }).click();
    await expect(page.getByRole("log", { name: /Messages with Mallory/ }).getByText("Unverified sender")).toBeVisible();
    await expect(page.getByText(/Replying is turned off/)).toBeVisible();
    await expect(page.getByRole("textbox", { name: "Reply" })).toBeDisabled();
  });

  test("reply from the Inbox is recorded as sent by the mock provider and shows in the thread", async () => {
    const page = owner.page;
    await page.goto(`/w/${ws}/inbox`);
    await page.getByRole("link", { name: /Ada Lovelace/ }).click();
    const log = page.getByRole("log", { name: /Messages with Ada Lovelace/ });
    await expect(log).toContainText("my order 42");
    await page.getByRole("textbox", { name: "Reply" }).fill("Hi Ada, we are on it.\nWe will update you today.");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await expect(log).toContainText("Hi Ada, we are on it.");
    await expect(log.getByText("Sent", { exact: true })).toBeVisible();
    await expect(log.getByText("Not sent")).toHaveCount(0);
    await page.reload();
    await expect(page.getByRole("log", { name: /Messages with Ada Lovelace/ })).toContainText("We will update you today.");
    await axe(page, "email-thread@1440");
  });
});
