import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { signUpAndCreate } from "./helpers";

/**
 * Owner preview of the web chat on a sample page (D270), against our own local servers only. The widget allows only https://customer.example, which is NOT our origin:
 * the preview works anyway through the short-lived grant, and nothing is added to the allowlist.
 */
const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

test("owner previews the chat on a sample page, chats, answers from the Inbox, and tries the mobile sheet", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1300 }); // tall enough that the whole sample frame (and the open chat) is inside the viewport
  const { workspaceId } = await signUpAndCreate(page, "Pia Preview", "Preview Co");
  await page.goto(`/w/${workspaceId}/settings/web-chat`);

  // allowed-sites input: hint, rejection of a path, normalised address
  await page.getByRole("button", { name: "Add widget" }).click();
  await page.getByLabel("Name", { exact: true }).fill("Preview chat");
  await expect(page.getByText("A site that is not on this list shows no chat at all.")).toBeVisible();
  const sites = page.getByLabel("Sites that may show the chat");
  await sites.fill("https://Customer.Example/shop");
  await page.getByRole("button", { name: "Create widget" }).click();
  await expect(page.getByText("Remove the page path: https://customer.example")).toBeVisible();
  await sites.fill("HTTPS://Customer.Example/");
  await expect(page.getByText("Will be saved as: https://customer.example")).toBeVisible();
  await page.getByRole("button", { name: "Create widget" }).click();
  await expect(page.getByRole("link", { name: "Preview on a sample page" })).toBeVisible();
  await expect(page.locator("pre code").first()).toContainText("widget.js"); // install snippet kept
  await expect(page.getByText("https://customer.example", { exact: true }).first()).toBeVisible();

  await page.getByRole("link", { name: "Preview on a sample page" }).click();
  await expect(page.getByRole("heading", { name: "Preview web chat", level: 1 })).toBeVisible();
  await expect(page.getByText("Messages you send here are real: they appear in your Inbox as a Web chat user.")).toBeVisible();
  const sample = page.frameLocator('iframe[title="Sample page with your chat"]');
  await expect(sample.getByText("Sample page, not your site")).toBeVisible();
  const launcher = sample.getByRole("button", { name: "Chat with us" });
  await expect(launcher).toBeVisible(); // the real loader mounted its launcher
  await expect(page.getByRole("button", { name: "Open widget" })).toBeEnabled();
  await page.getByRole("button", { name: "Open widget" }).click();
  const chat = sample.frameLocator('iframe[title="Chat"]');
  await expect(chat.getByRole("heading", { name: "Preview chat" })).toBeVisible();
  const input = chat.getByLabel("Your message");
  await input.fill("Hello from the preview");
  await chat.getByRole("button", { name: "Send message" }).click();
  await expect(chat.getByRole("log", { name: "Conversation" })).toContainText("Hello from the preview");
  await expect(chat.getByText("Sending…")).toHaveCount(0); // the server has it (the first message waits a moment: spam check)
  await page.screenshot({ path: "test-results/web-chat-preview-1440.png", fullPage: true });

  // the allowlist did not change
  await page.goto(`/w/${workspaceId}/settings/web-chat`);
  await expect(page.getByText("https://customer.example", { exact: true }).first()).toBeVisible();
  await expect(page.getByText(`http://localhost:${process.env.E2E_WEB_PORT ?? "3217"}`, { exact: true })).toHaveCount(0);

  // the message is in the Inbox; answer it
  await page.goto(`/w/${workspaceId}/inbox`);
  await page.getByRole("link", { name: /Web chat user/ }).click();
  await expect(page.getByRole("log", { name: /Messages with Web chat user/ })).toContainText("Hello from the preview");
  await page.getByRole("textbox", { name: "Reply" }).fill("Hi from the Inbox");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByRole("log", { name: /Messages with Web chat user/ })).toContainText("Hi from the Inbox");

  // back in the preview: the same visitor sees the reply
  await page.goto(`/w/${workspaceId}/settings/web-chat/preview`);
  await sample.getByRole("button", { name: "Chat with us" }).click();
  await expect(chat.getByRole("log", { name: "Conversation" })).toContainText("Hi from the Inbox", { timeout: 15_000 });

  // width toggle: mobile shows the full-screen sheet at 375 px
  await page.getByRole("button", { name: /^Mobile/ }).click();
  await expect(page.getByRole("button", { name: /^Mobile/ })).toHaveAttribute("aria-pressed", "true");
  await expect.poll(async () => Math.round((await page.locator('iframe[title="Sample page with your chat"]').boundingBox())!.width)).toBe(375);
  await expect(sample.locator('div[role="dialog"]')).toBeVisible(); // the chat stays open while the width changes
  await expect.poll(async () => Math.round((await sample.locator('div[role="dialog"]').boundingBox())!.width)).toBe(375); // the loader switched to the full-width phone sheet
  await page.screenshot({ path: "test-results/web-chat-preview-mobile-sheet.png", fullPage: true });
  await page.getByRole("button", { name: /^Desktop/ }).click();

  // reset visitor: a new visitor has an empty conversation
  await page.getByRole("button", { name: "Reset visitor" }).click();
  await expect(sample.getByRole("button", { name: "Chat with us" })).toBeVisible();
  await page.getByRole("button", { name: "Open widget" }).click();
  await expect(chat.getByLabel("Your message")).toBeVisible();
  await expect(chat.getByRole("log", { name: "Conversation" })).not.toContainText("Hello from the preview");

  // accessibility of the preview page at desktop and phone width (the sample page frame is scanned too)
  for (const size of [{ width: 1280, height: 900 }, { width: 375, height: 800 }]) {
    await page.setViewportSize(size);
    await expect(page.getByRole("heading", { name: "Preview web chat", level: 1 })).toBeVisible();
    const axe = await new AxeBuilder({ page }).withTags(TAGS).analyze();
    expect(axe.violations.map((v) => `${v.id} ${v.nodes[0]?.target.join(" ")}`), `preview@${size.width}`).toEqual([]);
    await page.screenshot({ path: `test-results/web-chat-preview-${size.width}.png`, fullPage: true });
  }

  // a switched-off widget: no preview, a plain explanation, a way out
  await page.goto(`/w/${workspaceId}/settings/web-chat`);
  await page.getByRole("button", { name: "Turn off" }).click();
  await expect(page.getByRole("button", { name: "Turn on" })).toBeVisible();
  await page.goto(`/w/${workspaceId}/settings/web-chat/preview`);
  await expect(page.getByText(/This chat is switched off/)).toBeVisible();
  await expect(page.locator('iframe[title="Sample page with your chat"]')).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Open widget" })).toBeDisabled();
});

test("no widget yet: the preview says so; the sample route alone shows no chat and only we may frame it", async ({ page }) => {
  const { workspaceId } = await signUpAndCreate(page, "Gus Grant", "Grant Co");
  await page.goto(`/w/${workspaceId}/settings/web-chat/preview`);
  await expect(page.getByText("No chat widget yet")).toBeVisible();
  // the sample route on its own (no key, no grant) explains itself and shows no chat
  await page.goto("/widget-preview");
  await expect(page.getByText("only used by the preview")).toBeVisible();
  await expect(page.getByRole("button", { name: "Chat with us" })).toHaveCount(0);
  const r = await page.request.get("/widget-preview");
  expect(r.headers()["x-frame-options"]).toBe("SAMEORIGIN");
  expect(r.headers()["content-security-policy"]).toContain("frame-ancestors 'self'");
});
