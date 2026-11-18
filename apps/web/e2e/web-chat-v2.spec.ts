import AxeBuilder from "@axe-core/playwright";
import { createServer, type Server } from "node:http";
import { expect, test } from "@playwright/test";
import { signUpAndCreate } from "./helpers";

/**
 * Website chat v2 (pill launcher, collapsing top block, quick replies, languages, away notice, unread badge, page url), against OUR OWN local servers only.
 * The static "customer site" is on another port (another origin) and serves the same page for every path.
 */
const WEB = `http://localhost:${process.env.E2E_WEB_PORT ?? "3217"}`;
const PORT = Number(process.env.E2E_SITE_PORT ?? 5471);
const SITE = `http://localhost:${PORT}`;
const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==", "base64");
let server: Server;
let code = "";
test.beforeAll(async () => {
  server = createServer((_q, r) => { r.setHeader("content-type", "text/html"); r.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Customer site</title></head><body><main><h1>Customer site</h1><p>Some page content.</p></main>${code}</body></html>`); });
  await new Promise<void>((res) => server.listen(PORT, "127.0.0.1", res));
});
test.afterAll(async () => { await new Promise((r) => server.close(r)); });

test("styled widget: launcher, collapse after first message, quick reply, language, away email, page url, unread badge, axe", async ({ page, browser }) => {
  const { workspaceId } = await signUpAndCreate(page, "Vera Visual", "Visual Chat Co");
  const created = await page.request.post(`/v1/workspaces/${workspaceId}/web-chat/widgets`, {
    headers: { origin: WEB },
    data: { name: "Acme Studio", allowedOrigins: [SITE], color: "#4f46e5", subtitle: "We reply here", greeting: "Hi there. How can we help?", quickReplies: ["Prices", "Shoot dates", "On-location"], awayMode: true, avatarUrl: "https://avatar.test/a.png" },
  });
  expect(created.status()).toBe(201);
  const widget = (await created.json()) as { id: string; publicKey: string };
  code = `<script src="${WEB}/widget.js" data-widget-key="${widget.publicKey}" async></script>`;

  const ctx = await browser.newContext();
  await ctx.route("https://avatar.test/**", (r) => r.fulfill({ status: 200, contentType: "image/png", body: PNG })); // no real network
  const v = await ctx.newPage();
  await v.setViewportSize({ width: 1440, height: 900 });
  await v.goto(`${SITE}/pricing/plans?token=SECRET123&email=a@b.co#frag`);

  // launcher pill: avatar + label, a drawn icon set (no emoji), hidden panel/frame already loaded
  const launcher = v.getByRole("button", { name: "Chat with us" });
  await expect(launcher).toBeVisible();
  expect(await launcher.textContent()).not.toMatch(/\p{Extended_Pictographic}/u);
  await expect(launcher.locator("img")).toHaveAttribute("referrerpolicy", "no-referrer");
  await expect(v.getByText(/Online now/i)).toHaveCount(0); // there is no presence data: never claimed
  await v.waitForTimeout(1200);
  await v.screenshot({ path: "test-results/v2-closed-1440.png" });

  await launcher.click();
  const chat = v.frameLocator('iframe[title="Chat"]');
  await expect(chat.getByRole("heading", { name: "Acme Studio", level: 1 })).toBeVisible();
  await expect(chat.getByText("We reply here")).toBeVisible();
  await expect(chat.getByRole("heading", { name: "Hi there. How can we help?" })).toBeVisible();
  await expect(chat.getByRole("button", { name: "Prices" })).toBeVisible();
  await expect(chat.getByText("We're away right now. Leave your email and we'll reply.")).toBeVisible();
  await expect(chat.getByText(/Online now/i)).toHaveCount(0);
  await expect.poll(async () => Math.round((await v.locator('div[role="dialog"]').boundingBox())!.width)).toBe(392); // after the open animation
  const box = await v.locator('div[role="dialog"]').boundingBox();
  expect(box!.height).toBeGreaterThanOrEqual(559);
  expect(box!.height).toBeLessThanOrEqual(661);
  await v.waitForTimeout(500);
  await v.screenshot({ path: "test-results/v2-open-1440.png" });

  // away notice: email capture with a confirmation, messages can still be sent
  await chat.getByLabel("Your email").fill("not an email");
  await chat.getByRole("button", { name: "Send", exact: true }).click();
  await expect(chat.getByText("Enter a valid email address.")).toBeVisible();
  await chat.getByLabel("Your email").fill("visitor.away@example.com");
  await chat.getByRole("button", { name: "Send", exact: true }).click();
  await expect(chat.getByText("Thanks. We'll reply by email.")).toBeVisible();

  // quick reply: sent as the first message; the top block collapses
  const hero = chat.locator(".cw-hero");
  await expect(hero).not.toHaveClass(/collapsed/);
  await chat.getByRole("button", { name: "Prices" }).click();
  const log = chat.getByRole("log", { name: "Conversation" });
  await expect(log).toContainText("Prices");
  await expect(log).toContainText("Sent", { timeout: 15_000 });
  await expect(hero).toHaveClass(/collapsed/);
  await expect.poll(async () => hero.evaluate((e) => (e as HTMLElement).offsetHeight)).toBeLessThanOrEqual(1);
  await expect(chat.getByRole("heading", { name: "Acme Studio", level: 1 })).toBeVisible(); // slim header stays
  await v.waitForTimeout(500);
  await v.screenshot({ path: "test-results/v2-started-1440.png" });
  await chat.getByLabel("Your message").fill("Do you shoot on location?");
  await chat.getByRole("button", { name: "Send message" }).click();
  await expect(log).toContainText("Do you shoot on location?");

  // language: toggle, persisted in the frame, html lang follows
  await chat.getByRole("button", { name: /Switch language to Bangla/ }).click();
  await expect(chat.getByLabel("আপনার বার্তা")).toBeVisible();
  await expect(chat.getByRole("button", { name: "চ্যাট বন্ধ করুন" })).toBeVisible();
  await expect(chat.locator("html")).toHaveAttribute("lang", "bn");
  await v.waitForTimeout(400);
  await v.screenshot({ path: "test-results/v2-bangla-1440.png" });
  await v.reload();
  await v.getByRole("button", { name: "Chat with us" }).click(); // the launcher label follows default_language (en), not the visitor's toggle
  await expect(chat.getByLabel("আপনার বার্তা")).toBeVisible();
  await chat.getByRole("button", { name: /English করুন/ }).click();
  await expect(chat.getByLabel("Your message")).toBeVisible();
  await expect(chat.locator("html")).toHaveAttribute("lang", "en");
  await v.keyboard.press("Escape");

  // the agent sees the page without the query string or fragment, and the captured email
  await page.goto(`/w/${workspaceId}/inbox`);
  await page.getByRole("link", { name: /Web chat user/ }).click();
  const from = page.getByTestId("from-page");
  await expect(from).toContainText(`From page: localhost:${PORT}/pricing/plans`);
  await expect(from.locator("a")).toHaveAttribute("rel", "noopener noreferrer");
  await expect(from.locator("a")).toHaveAttribute("href", `${SITE}/pricing/plans`);
  expect(await page.content()).not.toContain("SECRET123");
  const list = (await (await page.request.get(`/v1/workspaces/${workspaceId}/conversations`)).json()) as { items: { id: string }[] };
  const detail = (await (await page.request.get(`/v1/workspaces/${workspaceId}/conversations/${list.items[0]!.id}`)).json()) as { contactSummary: { email: string | null }; fromPage: string };
  expect(detail.contactSummary.email).toBe("visitor.away@example.com");
  expect(detail.fromPage).toBe(`${SITE}/pricing/plans`);

  // unread badge while the panel is closed, after an agent reply; cleared on open
  await expect(v.getByRole("button", { name: /Chat with us, / })).toHaveCount(0);
  await page.getByRole("textbox", { name: "Reply" }).fill("Yes, we do. Send us the date.");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByRole("log", { name: /Messages with Web chat user/ })).toContainText("Yes, we do.");
  await expect(v.getByRole("button", { name: "Chat with us, 1 new" })).toBeVisible({ timeout: 25_000 });
  await v.screenshot({ path: "test-results/v2-unread-1440.png" });
  await v.getByRole("button", { name: /Chat with us/ }).click();
  await expect(chat.getByRole("log", { name: "Conversation" })).toContainText("Yes, we do.");
  await v.keyboard.press("Escape");
  await expect(v.getByRole("button", { name: "Chat with us", exact: true })).toBeVisible(); // badge cleared: the reply was seen

  // mobile: full-screen sheet, 100dvh
  await v.setViewportSize({ width: 375, height: 700 });
  await v.getByRole("button", { name: "Chat with us" }).click();
  await expect.poll(async () => Math.round((await v.locator('div[role="dialog"]').boundingBox())?.height ?? 0)).toBe(700);
  await expect(v.locator('div[role="dialog"]')).toHaveCSS("height", "700px");
  await v.waitForTimeout(500);
  await v.screenshot({ path: "test-results/v2-open-375.png" });
  await v.keyboard.press("Escape");
  await v.screenshot({ path: "test-results/v2-closed-375.png" });

  // the widget page itself: axe at 1280 and 375, with the away notice and chips showing
  const w = await (await browser.newContext()).newPage();
  for (const size of [{ width: 1280, height: 800 }, { width: 375, height: 700 }]) {
    await w.setViewportSize(size);
    await w.goto(`${WEB}/widget/${widget.publicKey}?host=${encodeURIComponent(SITE)}`);
    await expect(w.getByRole("button", { name: "Prices" })).toBeVisible();
    const axe = await new AxeBuilder({ page: w }).withTags(TAGS).analyze();
    expect(axe.violations.map((x) => `${x.id} ${x.nodes[0]?.target.join(" ")}`), `widget@${size.width}`).toEqual([]);
    await w.getByRole("button", { name: "Prices" }).click();
    await expect(w.getByRole("log", { name: "Conversation" })).toContainText("Prices");
    await expect(w.getByRole("log", { name: "Conversation" })).toContainText("Sent", { timeout: 15_000 });
    await w.waitForTimeout(500); // the message rows fade in; scan the settled state
    const axe2 = await new AxeBuilder({ page: w }).withTags(TAGS).analyze();
    expect(axe2.violations.map((x) => `${x.id} ${x.nodes[0]?.target.join(" ")}`), `widget started@${size.width}`).toEqual([]);
    await w.evaluate(() => localStorage.clear());
  }
  // a plain http picture is not an avatar; the settings form says so and keeps the live preview in step
  await page.goto(`/w/${workspaceId}/settings/web-chat`);
  await page.getByRole("button", { name: "Edit" }).click();
  await page.getByLabel("Line under the name").fill("Ask us anything");
  await expect(page.getByTestId("widget-mock")).toContainText("Ask us anything");
  await page.getByLabel("Quick reply 1").fill("Delivery");
  await expect(page.getByTestId("widget-mock")).toContainText("Delivery");
  await page.getByLabel("Picture address").fill("http://x.example/a.png");
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByText(/Use a picture address that starts with https/)).toBeVisible();
  await page.getByLabel("Picture address").fill("");
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByRole("button", { name: "Edit" })).toBeVisible(); // saved: back to the card
  const saved = (await (await page.request.get(`/v1/workspaces/${workspaceId}/web-chat/widgets`)).json()) as { items: { subtitle: string; quickReplies: string[]; avatarUrl: string | null }[] };
  expect(saved.items[0]).toMatchObject({ subtitle: "Ask us anything", quickReplies: ["Delivery", "Shoot dates", "On-location"], avatarUrl: null });
  const settingsAxe = await new AxeBuilder({ page }).withTags(TAGS).analyze();
  expect(settingsAxe.violations.map((x) => `${x.id} ${x.nodes[0]?.target.join(" ")}`)).toEqual([]);
});
