import AxeBuilder from "@axe-core/playwright";
import { createServer, type Server } from "node:http";
import { expect, test } from "@playwright/test";
import { signUpAndCreate } from "./helpers";

/**
 * Website chat, end to end, against OUR OWN local servers only: the web app, the API, and two tiny static "customer sites" on other ports (other origins).
 * This does not prove the widget works on real third-party sites (their CSP, cookies policy, page builders, ad blockers).
 */
const PORT_A = Number(process.env.E2E_SITE_PORT ?? 5461);
const PORT_B = PORT_A + 1;
const SITE_A = `http://localhost:${PORT_A}`;
const servers: Server[] = [];
const page$ = (code: string) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Customer site</title></head><body><main><h1>Customer site</h1><p>Some page content.</p></main>${code}</body></html>`;
let code = "";
const listen = (port: number) => new Promise<void>((res) => { const s = createServer((_q, r) => { r.setHeader("content-type", "text/html"); r.end(page$(code)); }); servers.push(s); s.listen(port, "127.0.0.1", res); });
test.beforeAll(async () => { await listen(PORT_A); await listen(PORT_B); });
test.afterAll(async () => { await Promise.all(servers.map((s) => new Promise((r) => s.close(r)))); });

test.describe("website chat", () => {
  test("owner creates a widget, a visitor on another origin chats, the agent answers in the Inbox, the visitor sees it", async ({ page, browser }) => {
    const { workspaceId } = await signUpAndCreate(page, "Wanda Web", "Web Chat Co");
    await page.goto(`/w/${workspaceId}/settings/web-chat`);
    await expect(page.getByRole("heading", { name: "Web chat", level: 1 })).toBeVisible();
    await expect(page.getByText("Not tested on real sites")).toBeVisible();
    await expect(page.getByText("No chat widget yet")).toBeVisible();

    await page.getByRole("button", { name: "Add widget" }).click();
    await page.getByLabel("Name", { exact: true }).fill("Shop chat");
    await page.getByLabel("Sites that may show the chat").fill(SITE_A);
    await page.getByRole("button", { name: "Create widget" }).click();
    const snippet = await page.locator("pre code").first().textContent();
    expect(snippet).toMatch(/^<script src="http:\/\/localhost:\d+\/widget\.js" data-widget-key="[A-Za-z0-9_-]{32}" async><\/script>$/);
    const key = /data-widget-key="([^"]+)"/.exec(snippet!)![1]!;
    await page.screenshot({ path: "test-results/web-chat-settings-desktop.png", fullPage: true });
    await page.setViewportSize({ width: 375, height: 812 });
    await page.screenshot({ path: "test-results/web-chat-settings-375.png", fullPage: true });
    await page.setViewportSize({ width: 1280, height: 800 });

    // the visitor: a different origin that embeds the loader
    code = snippet!;
    const visitor = await (await browser.newContext()).newPage();
    await visitor.goto(SITE_A);
    const launcher = visitor.getByRole("button", { name: "Chat with us" });
    await expect(launcher).toHaveAttribute("aria-expanded", "false");
    await launcher.click();
    // (changed: the pill launcher now hides while the panel is open, the panel has its own close button inside the frame; so this checks the launcher state and that the dialog is shown, instead of a visible host "Close chat" button)
    await expect(visitor.locator('button[aria-haspopup="dialog"]')).toHaveAttribute("aria-expanded", "true"); // hidden while open, so it is not found by role
    await expect(visitor.locator('div[role="dialog"]')).toBeVisible();
    const chat = visitor.frameLocator('iframe[title="Chat"]');
    await expect(chat.getByRole("heading", { name: "Shop chat" })).toBeVisible();
    const input = chat.getByLabel("Your message");
    await expect(input).toBeVisible();
    await expect(input).toBeFocused(); // focus moved into the frame
    await visitor.screenshot({ path: "test-results/web-chat-widget-desktop.png" });
    await input.fill("Hello <b>from the site</b>");
    await chat.getByRole("button", { name: "Send message" }).click();
    const log = chat.getByRole("log", { name: "Conversation" });
    await expect(log).toContainText("Hello <b>from the site</b>"); // shown as text, never as HTML
    await expect(log.locator("b")).toHaveCount(0);

    // Escape closes and returns focus to the launcher
    await visitor.keyboard.press("Escape");
    await expect(visitor.getByRole("button", { name: "Chat with us" })).toBeFocused();
    await expect(visitor.locator('iframe[title="Chat"]')).toBeHidden();

    // the agent sees it in the Inbox and answers
    await page.goto(`/w/${workspaceId}/inbox`);
    await page.getByRole("link", { name: /Web chat user/ }).click();
    await expect(page.getByRole("log", { name: /Messages with Web chat user/ })).toContainText("Hello <b>from the site</b>");
    await page.getByRole("textbox", { name: "Reply" }).fill("Hi! How can we help?");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await expect(page.getByRole("log", { name: /Messages with Web chat user/ })).toContainText("Hi! How can we help?");

    // the visitor's widget picks it up by polling
    await visitor.getByRole("button", { name: "Chat with us" }).click();
    await expect(chat.getByRole("log", { name: "Conversation" })).toContainText("Hi! How can we help?", { timeout: 15_000 });
    await visitor.reload(); // the session survives a reload (token in the frame's localStorage)
    await visitor.getByRole("button", { name: "Chat with us" }).click();
    await expect(chat.getByRole("log", { name: "Conversation" })).toContainText("Hello <b>from the site</b>");
    await visitor.setViewportSize({ width: 375, height: 700 });
    // (changed: this used to check that a "Close chat" button is attached, which raced with the loader hiding its launcher behind the full-screen sheet at 375 px; now it checks the sheet itself)
    await expect.poll(async () => Math.round((await visitor.locator('div[role="dialog"]').boundingBox())?.width ?? 0)).toBe(375);
    await visitor.screenshot({ path: "test-results/web-chat-widget-375.png" });

    // a site that is not on the list cannot show the chat: the browser refuses the frame (frame-ancestors) and the API refuses its origin
    // (changed with the preview work: the loader now asks the server first, so a site that is not listed gets no launcher at all and one console warning, instead of a launcher with an empty frame)
    const other = await (await browser.newContext()).newPage();
    const warned: string[] = [];
    other.on("console", (m) => { if (m.type() === "warning") warned.push(m.text()); });
    await other.goto(`http://localhost:${PORT_B}`);
    await other.waitForTimeout(1500);
    await expect(other.getByRole("button", { name: "Chat with us" })).toHaveCount(0);
    expect(warned.join("\n")).toContain("Chat widget not shown: this site's origin is not allowed for this widget key");
    await expect(other.frameLocator('iframe[title="Chat"]').getByLabel("Your message")).toHaveCount(0);
    const denied = await other.evaluate(async (k) => (await fetch(`http://localhost:${new URL((document.querySelector("script[data-widget-key]") as HTMLScriptElement).src).port}/public/widget/${k}/config`, { mode: "cors" }).then((r) => r.status).catch(() => "blocked")), key);
    expect(["blocked", 403]).toContain(denied);

    // the app itself is still not frameable, and the widget page is
    const app = await page.request.get("/login");
    expect(app.headers()["x-frame-options"]).toBe("DENY");
    expect(app.headers()["content-security-policy"]).toContain("frame-ancestors 'none'");
    const w = await page.request.get(`/widget/${key}`);
    expect(w.headers()["x-frame-options"]).toBeUndefined();
    expect(w.headers()["content-security-policy"]).toContain(`frame-ancestors ${SITE_A}`);
    const unknown = await page.request.get(`/widget/${"u".repeat(32)}`);
    expect(unknown.headers()["content-security-policy"]).toContain("frame-ancestors 'none'");
    // the public proxy forwards only the visitor routes
    expect((await page.request.get(`/public/widget/${key}/anything`)).status()).toBe(404);
    expect((await page.request.get(`/public/widget/_frame/${key}`)).status()).toBe(404);
  });

  test("the widget page has no serious accessibility problems, on desktop and at 375 px", async ({ page, browser }) => {
    const { workspaceId } = await signUpAndCreate(page, "Axel Axe", "Axe Chat Co");
    await page.goto(`/w/${workspaceId}/settings/web-chat`);
    await page.getByRole("button", { name: "Add widget" }).click();
    await page.getByLabel("Name", { exact: true }).fill("Axe chat");
    await page.getByLabel("Sites that may show the chat").fill(SITE_A);
    await page.getByLabel("Ask visitors for a name and email first").check();
    await page.getByRole("button", { name: "Create widget" }).click();
    const settingsAxe = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
    expect(settingsAxe.violations.map((v) => `${v.id} ${v.nodes[0]?.target.join(" ")}`)).toEqual([]);
    const key = /data-widget-key="([^"]+)"/.exec((await page.locator("pre code").first().textContent())!)![1]!;

    const v = await (await browser.newContext()).newPage();
    for (const size of [{ width: 1280, height: 800 }, { width: 375, height: 700 }]) {
      await v.setViewportSize(size);
      await v.goto(`/widget/${key}?host=${encodeURIComponent(SITE_A)}`.replace(/^/, `http://localhost:${process.env.E2E_WEB_PORT ?? "3217"}`));
      await expect(v.getByRole("button", { name: "Start chat" })).toBeVisible(); // pre-chat form
      const pre = await new AxeBuilder({ page: v }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
      expect(pre.violations.map((x) => `${x.id} ${x.nodes[0]?.target.join(" ")}`), `prechat@${size.width}`).toEqual([]);
      await v.getByRole("button", { name: "Skip" }).click();
      await expect(v.getByLabel("Your message")).toBeVisible();
      const fontSize = await v.getByLabel("Your message").evaluate((e) => parseFloat(getComputedStyle(e).fontSize));
      expect(fontSize).toBeGreaterThanOrEqual(16);
      const chat = await new AxeBuilder({ page: v }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
      expect(chat.violations.map((x) => `${x.id} ${x.nodes[0]?.target.join(" ")}`), `chat@${size.width}`).toEqual([]);
      await v.screenshot({ path: `test-results/web-chat-page-${size.width}.png` });
    }
    // opened with no host (not framed by an allowed site): refused with a plain explanation
    await v.goto(`http://localhost:${process.env.E2E_WEB_PORT ?? "3217"}/widget/${key}`);
    await expect(v.getByText("Chat is not available here.")).toBeVisible();
  });
});
