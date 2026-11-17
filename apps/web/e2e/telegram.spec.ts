import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { createWorkspace } from "./helpers";
import { axe, person } from "./channel-helpers";

/**
 * Telegram channel end to end: connect a bot, receive a message, reply. MOCK ONLY: run with E2E_META_MOCK=1, which also swaps the Telegram Bot API for the in-memory mock (nothing reaches Telegram,
 * and nothing here proves real Telegram behaviour). Needs a FRESH database per run: the mock bot id is globally unique.
 * The webhook secret is random and never shown, so the spec reads it from the mock-only route GET /mock/telegram/webhooks on the API port.
 */
const API = `http://localhost:${process.env.E2E_API_PORT ?? "8791"}`;
const MOCK_TOKEN = "7000000001:mock-telegram-token-not-real-0000"; // MOCK_TELEGRAM_TOKEN in packages/integrations/src/telegram.ts
const SNAP = "test-results/telegram";

test.describe.serial("Telegram (mock)", () => {
  let owner: { ctx: BrowserContext; page: Page; email: string };
  let ws = "";
  let hook: { url: string; secretToken: string };

  test.beforeAll(async ({ browser }) => {
    owner = await person(browser, "Telegram Owner");
    ws = await createWorkspace(owner.page, "Telegram Co");
  });
  test.afterAll(async () => { await owner?.ctx.close(); });

  test("connect: validation, wrong token, mock bot, token never shown, health @1440", async () => {
    const page = owner.page;
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`/w/${ws}/integrations?channel=telegram`);
    await expect(page.getByText("MOCK", { exact: true }).first()).toBeVisible();
    await expect(page.getByText("Not tested live", { exact: true })).toBeVisible();
    const token = page.getByLabel("Bot token");
    await page.getByRole("button", { name: "Connect bot" }).click();
    await expect(page.getByText("Paste the whole token from BotFather, with no spaces.")).toBeVisible();
    await token.fill("1234567890:this-is-not-a-token-the-mock-knows");
    await page.getByRole("button", { name: "Connect bot" }).click();
    await expect(page.getByText(/Telegram rejected this token/)).toBeVisible();
    await token.fill(MOCK_TOKEN);
    await page.getByRole("button", { name: "Connect bot" }).click();
    const rail = page.getByRole("navigation", { name: "Channels" });
    await expect(rail.getByRole("button", { name: /Telegram/ })).toContainText("1 connected", { timeout: 15_000 });
    await expect(page.getByText("@mock_support_bot").first()).toBeVisible();
    await expect(page.getByText("Bot ID 7000000001")).toBeVisible();
    await expect(token).toHaveValue("");
    expect(await page.content()).not.toContain(MOCK_TOKEN);
    expect(await page.evaluate(() => JSON.stringify([localStorage, sessionStorage, document.cookie]))).not.toContain("mock-telegram-token");
    expect(await (await page.request.get(`/v1/workspaces/${ws}/integrations/meta`)).text()).not.toContain(MOCK_TOKEN);
    await page.getByRole("button", { name: "Check connection" }).click();
    await expect(page.getByText(/Webhook set\. 0 waiting\./)).toBeVisible();
    await axe(page, "telegram-connected@1440");
    await page.screenshot({ path: `${SNAP}-1440.png`, fullPage: true });
    hook = (await (await page.request.get(`${API}/mock/telegram/webhooks`)).json()).webhooks.at(-1);
    expect(hook.url).toContain("/webhooks/telegram/");
  });

  test("receive: wrong or missing secret is refused, the right one stores the message and the inbox shows it", async () => {
    const page = owner.page;
    const path = new URL(hook.url).pathname;
    const update = (id: number, message: Record<string, unknown>) => ({ update_id: id, message: { message_id: id, from: { id: 424242, is_bot: false, first_name: "Mina", last_name: "Rahman" }, chat: { id: 424242, type: "private" }, date: Math.floor(Date.now() / 1000), ...message } });
    const send = (body: unknown, secret?: string) => page.request.post(`${API}${path}`, { data: body, headers: secret ? { "x-telegram-bot-api-secret-token": secret } : {} });
    expect((await send(update(1, { text: "nope" }))).status()).toBe(403);
    expect((await send(update(1, { text: "nope" }), "wrong")).status()).toBe(403);
    expect((await send(update(10, { text: "Hi, I need help with my order" }), hook.secretToken)).status()).toBe(200);
    expect((await send(update(11, { caption: "my receipt", photo: [{ file_id: "FILE1", width: 10, height: 10 }] }), hook.secretToken)).status()).toBe(200);
    await page.setViewportSize({ width: 1440, height: 900 });
    await expect(async () => {
      await page.goto(`/w/${ws}/inbox`);
      await expect(page.getByRole("link", { name: /Mina Rahman/ })).toBeVisible({ timeout: 2_000 });
    }).toPass({ timeout: 20_000 });
    await page.getByRole("link", { name: /Mina Rahman/ }).click();
    const log = page.getByRole("log", { name: /Messages with Mina Rahman/ });
    await expect(log).toContainText("Hi, I need help with my order");
    await expect(log).toContainText("my receipt");
    await expect(log).toContainText("not available"); // the photo is a placeholder: Telegram files are never downloaded
  });

  test("reply: plain text goes through the mock and is shown as sent; no 24 hour banner", async () => {
    const page = owner.page;
    await expect(page.getByText(/more than 24 hours/i)).toHaveCount(0);
    await page.getByPlaceholder("Write a reply").fill("Thanks Mina, I am on it");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    const log = page.getByRole("log", { name: /Messages with Mina Rahman/ });
    await expect(log).toContainText("Thanks Mina, I am on it");
    await expect(log.getByText("Sent", { exact: true })).toBeVisible({ timeout: 15_000 });
    await axe(page, "telegram-thread@1440");
  });

  test("disconnect with confirm, and the 375px layout", async () => {
    const page = owner.page;
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto(`/w/${ws}/integrations?channel=telegram`);
    await expect(page.getByRole("heading", { name: "Telegram", level: 2 })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: `${SNAP}-375.png`, fullPage: true });
    await page.getByRole("button", { name: "Disconnect" }).first().click();
    await page.getByRole("dialog", { name: "Disconnect this account?" }).getByRole("button", { name: "Disconnect" }).click();
    await page.setViewportSize({ width: 1440, height: 900 });
    await expect(page.getByRole("navigation", { name: "Channels" }).getByRole("button", { name: /Telegram/ })).toContainText("Not connected");
  });
});
