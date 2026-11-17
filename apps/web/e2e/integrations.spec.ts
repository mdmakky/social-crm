import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { createWorkspace } from "./helpers";
import { axe, focusIndicator, person } from "./channel-helpers";

/**
 * Integrations option B (channel rail + detail pane), end to end.
 * Run with E2E_META_MOCK=1: the Meta connect flow then uses the in-memory MOCK Graph (no Meta contact; nothing here proves real Meta behaviour).
 * Needs a FRESH database per run (mock Page ids are globally unique, events are append-only): see docs/project/testing-report.md.
 */
test.describe.serial("Integrations option B (mock Meta)", () => {
  let owner: { ctx: BrowserContext; page: Page; email: string };
  let outsider: { ctx: BrowserContext; page: Page; email: string };
  let wsInt = "";
  let wsOut = "";

  test.beforeAll(async ({ browser }) => {
    owner = await person(browser, "Owner One");
    wsInt = await createWorkspace(owner.page, "Integrations Co");
    outsider = await person(browser, "Outsider Three");
    wsOut = await createWorkspace(outsider.page, "Outsider Co");
  });
  test.afterAll(async () => {
    await Promise.all([owner?.ctx.close(), outsider?.ctx.close()]);
  });

  test("rail, channel panels, mock label @1440", async () => {
    const page = owner.page;
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`/w/${wsInt}/integrations`);
    await expect(page.getByRole("heading", { name: "Integrations", level: 1 })).toBeVisible();
    await expect(page.getByText("MOCK", { exact: true })).toBeVisible();
    const rail = page.getByRole("navigation", { name: "Channels" });
    for (const c of ["Messenger", "Instagram", "WhatsApp", "Telegram"]) await expect(rail.getByRole("button", { name: new RegExp(c) })).toBeVisible();
    await expect(rail.getByRole("button", { name: /Messenger/ })).toHaveAttribute("aria-current", "page");
    await rail.getByRole("button", { name: /WhatsApp/ }).click();
    await expect(page.getByRole("heading", { name: "WhatsApp", level: 2 })).toBeVisible();
    await expect(page).toHaveURL(/\?channel=whatsapp$/);
    await expect(page.getByText("No WhatsApp account connected")).toBeVisible();
    await expect(page.getByLabel("System user token")).toHaveAttribute("type", "password");
    await expect(page.getByRole("button", { name: "Find numbers" })).toBeEnabled();
    // Changed with the Telegram channel (MOCK ONLY): Telegram is no longer a disabled "Soon" card; it is a real panel with a token field and a Connect bot button.
    await rail.getByRole("button", { name: /Telegram/ }).click();
    await expect(page.getByRole("heading", { name: "Telegram", level: 2 })).toBeVisible();
    await expect(page.getByText("No Telegram account connected")).toBeVisible();
    await expect(page.getByLabel("Bot token")).toHaveAttribute("type", "password");
    await expect(page.getByRole("button", { name: "Connect bot" })).toBeEnabled();
    await rail.getByRole("button", { name: /Instagram/ }).click();
    await expect(page.getByText("No Instagram account connected")).toBeVisible();
    await expect(page.getByText("Not tested live", { exact: true })).toBeVisible();
    await axe(page, "integrations-empty@1440");
  });

  test("mock connect: Page picker, details, webhook subscription, activity, token check", async () => {
    const page = owner.page;
    await page.goto(`/w/${wsInt}/integrations?channel=messenger`);
    await page.getByRole("button", { name: "Connect with Meta" }).first().click();
    await expect(page.getByText("Choose a Page", { exact: true })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText("Mock Page")).toBeVisible();
    await page.getByLabel("Also connect the linked Instagram account").check();
    await page.getByRole("button", { name: "Connect Page" }).click();
    await expect(page.getByText("Connection result")).toBeVisible();
    await expect(page.getByText("Webhook subscribed").first()).toBeVisible();
    // rail reflects both channels
    const rail = page.getByRole("navigation", { name: "Channels" });
    await expect(rail.getByRole("button", { name: /Messenger/ })).toContainText("1 Page connected");
    await expect(rail.getByRole("button", { name: /Instagram/ })).toContainText("1 connected");
    // connected Page details
    await expect(page.getByRole("heading", { name: "Connected Pages" })).toBeVisible();
    await expect(page.getByText("Mock Page").first()).toBeVisible();
    await expect(page.getByText("Connected", { exact: true }).first()).toBeVisible();
    // webhook subscription: requested fields (behind the closed "Technical details"), explicit re-check result
    await expect(page.getByText("message_echoes", { exact: true })).toBeHidden();
    await page.getByText("Technical details").click();
    for (const f of ["messages", "message_echoes", "messaging_postbacks", "message_reads", "message_deliveries"]) await expect(page.getByText(f, { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Re-check subscription" }).click();
    await expect(page.getByText("Webhook subscribed").last()).toBeVisible();
    // token check updates the last-check time
    await page.getByRole("button", { name: "Check token" }).first().click();
    await expect(page.getByText("Token is valid")).toBeVisible();
    // activity trail, plain language
    const activity = page.getByRole("region").or(page.locator("section")).filter({ hasText: "Recent activity" }).first();
    await expect(activity.getByText("Connected", { exact: true }).first()).toBeVisible();
    await expect(activity.getByText("Webhook subscribed").first()).toBeVisible();
    await expect(activity.getByText("Token checked: valid").first()).toBeVisible();
    await axe(page, "integrations-connected@1440");
    // Instagram pane lists the Instagram account and says the dashboard step is required
    await rail.getByRole("button", { name: /Instagram/ }).click();
    await expect(page.getByRole("heading", { name: "Connected accounts" })).toBeVisible();
    await expect(page.getByText("Mock Page (Instagram)").last()).toBeVisible();
  });

  test("disconnect dialog: keyboard, focus return, confirm", async () => {
    const page = owner.page;
    await page.goto(`/w/${wsInt}/integrations?channel=messenger`);
    const trigger = page.getByRole("button", { name: "Disconnect" }).first();
    await trigger.focus();
    expect(["outline", "ring"]).toContain(await focusIndicator(page));
    await trigger.press("Enter");
    const dialog = page.getByRole("dialog", { name: "Disconnect this account?" });
    await expect(dialog).toBeVisible();
    await axe(page, "disconnect-dialog");
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(trigger).toBeFocused();
    await trigger.click();
    await dialog.getByRole("button", { name: "Disconnect" }).click();
    await expect(page.getByText("Disconnected").first()).toBeVisible();
    await expect(page.getByRole("navigation", { name: "Channels" }).getByRole("button", { name: /Messenger/ })).toContainText("Not connected");
  });

  test("WhatsApp manual connect: errors, number picker, connect, re-check, token never shown, disconnect", async () => {
    const WA_TOKEN = "mock-system-user-token-" + "0".repeat(24); // same value as MOCK_WA_TOKEN in apps/api/src/server.ts
    const page = owner.page;
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`/w/${wsInt}/integrations?channel=whatsapp`);
    const waba = page.getByLabel("WhatsApp Business Account ID");
    const token = page.getByLabel("System user token");
    // client-side validation: nothing is sent
    await page.getByRole("button", { name: "Find numbers" }).click();
    await expect(page.getByText("Enter the WhatsApp Business Account ID: digits only.")).toBeVisible();
    await expect(page.getByText("Paste the whole system user token, with no spaces.")).toBeVisible();
    // Meta rejects: unknown WABA, then wrong token (server errors, in plain language)
    await waba.fill("999999999999999");
    await token.fill(WA_TOKEN);
    await page.getByRole("button", { name: "Find numbers" }).click();
    await expect(page.getByText(/cannot read that WhatsApp Business Account/)).toBeVisible();
    await waba.fill("200000000000001");
    await token.fill("wrong-token-" + "1".repeat(24));
    await page.getByRole("button", { name: "Find numbers" }).click();
    await expect(page.getByText(/Meta rejected this token/)).toBeVisible();
    // happy path: find, pick, connect
    await token.fill(WA_TOKEN);
    await page.getByRole("button", { name: "Find numbers" }).click();
    await expect(page.getByText("Choose the number to connect")).toBeVisible();
    await expect(page.getByText("Mock WhatsApp Business")).toBeVisible();
    await expect(page.getByRole("radio").first()).toBeChecked();
    await axe(page, "whatsapp-picker@1440");
    await page.getByRole("button", { name: "Connect number" }).click();
    const rail = page.getByRole("navigation", { name: "Channels" });
    await expect(rail.getByRole("button", { name: /WhatsApp/ })).toContainText("1 connected", { timeout: 15_000 });
    await expect(page.getByText(/ID 300000000000001/).first()).toBeVisible();
    await expect(page.getByText("Webhook subscribed").first()).toBeVisible();
    // the token is gone from the form, the page, the proxy responses and storage
    await expect(token).toHaveValue("");
    expect(await page.content()).not.toContain(WA_TOKEN);
    expect(await page.evaluate(() => JSON.stringify([localStorage, sessionStorage, document.cookie]))).not.toContain("mock-system-user-token");
    const list = await page.request.get(`/v1/workspaces/${wsInt}/integrations/meta`);
    expect(await list.text()).not.toContain(WA_TOKEN);
    // re-check subscription and token check
    await page.getByRole("button", { name: "Re-check subscription" }).click();
    await expect(page.getByText("Webhook subscribed").last()).toBeVisible();
    await page.getByRole("button", { name: "Check token" }).first().click();
    await expect(page.getByText("Token is valid")).toBeVisible();
    await expect(page.getByText("Not tested live", { exact: true })).toBeVisible();
    await axe(page, "whatsapp-connected@1440");
    // a second number of the same account shows the first as already connected
    await waba.fill("200000000000001");
    await token.fill(WA_TOKEN);
    await page.getByRole("button", { name: "Find numbers" }).click();
    await expect(page.getByText(/already connected here/)).toBeVisible(); // this workspace's own number (another number may also read "connected to another workspace")
    await page.getByRole("button", { name: "Start over" }).click();
    // disconnect with confirm
    await page.getByRole("button", { name: "Disconnect" }).first().click();
    await page.getByRole("dialog", { name: "Disconnect this account?" }).getByRole("button", { name: "Disconnect" }).click();
    await expect(rail.getByRole("button", { name: /WhatsApp/ })).toContainText("Not connected");
  });

  test("WhatsApp: a non-member cannot reach the connect routes (roles: see the API permissions test)", async () => {
    const res = await outsider.page.request.post(`/v1/workspaces/${wsInt}/integrations/whatsapp/numbers`, { data: { wabaId: "200000000000001", accessToken: "x".repeat(40) } });
    expect(res.status()).toBe(404); // not a member: the workspace does not exist for them
  });

  test("WhatsApp: a number held by another workspace is shown as unavailable, and the backend still refuses it (409)", async () => {
    const WA_TOKEN = "mock-system-user-token-" + "0".repeat(24);
    const page = outsider.page;
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`/w/${wsOut}/integrations?channel=whatsapp`);
    await page.getByLabel("WhatsApp Business Account ID").fill("200000000000001");
    await page.getByLabel("System user token").fill(WA_TOKEN);
    await page.getByRole("button", { name: "Find numbers" }).click();
    await expect(page.getByText(/ID 300000000000001 · connected to another workspace/)).toBeVisible(); // the line of this very number (other specs may hold other mock numbers too)
    const radios = page.getByRole("radio");
    await expect(radios.first()).toBeDisabled();
    await expect(radios.nth(1)).toBeEnabled();
    await expect(radios.nth(1)).toBeChecked(); // default skips the unavailable number
    const refused = await page.request.post(`/v1/workspaces/${wsOut}/integrations/whatsapp/connect`, { data: { wabaId: "200000000000001", accessToken: WA_TOKEN, phoneNumberId: "300000000000001" } });
    expect(refused.status()).toBe(409);
    expect((await refused.json()).error.code).toBe("account_unavailable");
    await axe(page, "whatsapp-unavailable@1440");
  });

  test("mobile 375: list screen, detail screen, back", async () => {
    const page = owner.page;
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto(`/w/${wsInt}/integrations`);
    const rail = page.getByRole("navigation", { name: "Channels" });
    await expect(rail).toBeVisible();
    await expect(page.getByRole("heading", { name: "Messenger", level: 2 })).toBeHidden(); // list screen only
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await axe(page, "integrations-list@375");
    await rail.getByRole("button", { name: /Messenger/ }).click();
    await expect(page.getByRole("heading", { name: "Messenger", level: 2 })).toBeVisible();
    await expect(rail).toBeHidden();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await axe(page, "integrations-detail@375");
    const back = page.getByRole("button", { name: "Integrations" });
    await expect(back).toBeVisible();
    expect((await back.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await back.click();
    await expect(rail).toBeVisible();
  });

  test("another workspace cannot see these integrations, through the UI or the API", async () => {
    const page = outsider.page;
    await page.setViewportSize({ width: 1440, height: 900 });
    expect((await page.request.get(`/v1/workspaces/${wsInt}/integrations/meta`)).status()).toBe(404);
    expect((await page.request.get(`/v1/workspaces/${wsInt}/integrations/meta/accounts/00000000-0000-4000-8000-000000000000/events`)).status()).toBe(404);
    await page.goto("/");
    await page.goto(page.url().replace(/\/w\/([0-9a-f-]{36}).*/, "/w/$1/integrations"));
    await expect(page.getByRole("navigation", { name: "Channels" }).getByRole("button", { name: /Messenger/ })).toContainText("Not connected");
  });
});
