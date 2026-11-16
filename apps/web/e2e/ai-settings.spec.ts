import { expect, test, type Page } from "@playwright/test";
import { addMemberByEmail, api, register, signUpAndCreate } from "./helpers";
import { axe, seed } from "./channel-helpers";

/**
 * AI foundation slice 1, MOCK provider only: this proves our settings, permissions and the draft-only composer flow, not any real AI service.
 * Needs the mock Meta environment (E2E_META_MOCK=1: worker role and secret key) and a fresh database, like the inbox spec.
 */
test.describe.configure({ mode: "serial" });

let owner: Page, workspaceId = "";
const SETTINGS = () => `/w/${workspaceId}/settings/ai`;
const noOverflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);

test.beforeAll(async ({ browser }) => {
  owner = await (await browser.newContext()).newPage();
  ({ workspaceId } = await signUpAndCreate(owner, "Olive Owner", "AI Co"));
  seed(workspaceId);
});

test("configure the mock provider and a budget", async () => {
  await owner.goto(SETTINGS());
  await expect(owner.getByRole("heading", { name: "Provider", exact: true })).toBeVisible();
  await expect(owner.getByText("MOCK", { exact: true }).first()).toBeVisible();
  await expect(owner.getByLabel("API key")).toHaveCount(0); // the mock takes no key
  await owner.getByRole("button", { name: "Connect provider" }).click();
  await expect(owner.getByText("AI provider saved")).toBeVisible();
  await expect(owner.getByRole("button", { name: "Save provider" })).toBeVisible();
  await expect(owner.getByLabel("Provider", { exact: true })).toContainText("Mock (offline) (default)");

  // A real provider shows a password field that is cleared after saving and never comes back.
  await owner.getByLabel("Provider", { exact: true }).selectOption("anthropic");
  const key = owner.getByLabel("API key");
  await expect(key).toHaveAttribute("type", "password");
  await expect(owner.getByText("Not tested live", { exact: true })).toBeVisible();
  await key.fill("sk-ant-E2E-SECRET-0123456789abcdef");
  await owner.getByLabel("Use for reply suggestions (default)").uncheck();
  await owner.getByRole("button", { name: "Connect provider" }).click();
  await expect(owner.getByText("AI provider saved")).toBeVisible();
  await expect(key).toHaveValue("");
  await expect(owner.getByText(/A key ending in cdef is stored/)).toBeVisible();
  await owner.reload();
  await expect(owner.locator("body")).not.toContainText("E2E-SECRET");
  await owner.getByLabel("Provider", { exact: true }).selectOption("anthropic");
  await expect(owner.getByLabel("API key")).toHaveValue("");

  // The mock stays the default; budget saves and survives a reload.
  await owner.getByLabel("Monthly limit (USD)").fill("5");
  await owner.getByRole("button", { name: "Save budget" }).click();
  await expect(owner.getByText("Budget saved")).toBeVisible();
  await owner.reload();
  await expect(owner.getByLabel("Monthly limit (USD)")).toHaveValue("5.00");
  await owner.getByLabel("Monthly limit (USD)").fill("abc");
  await owner.getByRole("button", { name: "Save budget" }).click();
  await expect(owner.getByText("Enter an amount like 25 or 12.50.")).toBeVisible();
  await owner.getByLabel("Monthly limit (USD)").fill("5");

  for (const w of [375, 768, 1440]) {
    await owner.setViewportSize({ width: w, height: 900 });
    await expect(owner.getByRole("heading", { name: "Monthly budget" })).toBeVisible();
    expect(await noOverflow(owner)).toBe(true);
  }
  await axe(owner, "settings-ai");
});

test("prompt versions", async () => {
  await owner.setViewportSize({ width: 1440, height: 900 });
  await owner.goto(SETTINGS());
  const box = owner.getByLabel("Prompt template");
  await box.fill("Reply to {{contact_name}} politely. Use {{secret}}.");
  await owner.getByRole("button", { name: "Publish as new version" }).click();
  await expect(owner.getByText(/Unknown placeholder \{\{secret\}\}/)).toBeVisible();
  await box.fill("Reply to {{contact_name}} on {{channel}} politely.");
  await owner.getByRole("button", { name: "Publish as new version" }).click();
  await expect(owner.getByText("New prompt version published")).toBeVisible();
  await expect(owner.getByText("Version 1 is active.")).toBeVisible();
  await owner.getByRole("button", { name: "Use the built-in prompt" }).click();
  await expect(owner.getByText("Using the built-in prompt.")).toBeVisible();
});

test("suggest reply fills the composer as an editable draft and sends nothing", async () => {
  await owner.goto(`/w/${workspaceId}/inbox`);
  await owner.getByRole("link", { name: /Maria Lopez/ }).click();
  const log = owner.getByRole("log", { name: /Messages with Maria Lopez/ });
  await expect(log).toContainText("Can you deliver to Dhaka by Friday?");
  const bubbles = () => log.getByRole("listitem").count();
  const before = await bubbles();
  const reply = owner.getByLabel("Reply", { exact: true });
  await expect(reply).toHaveValue("");

  await owner.getByRole("button", { name: "Suggest reply with AI" }).click();
  await expect(reply).toHaveValue(/\[MOCK DRAFT\]/);
  await expect(owner.getByText("AI draft (mock)")).toBeVisible();
  await expect(owner.getByText(/Nothing is sent automatically/)).toBeVisible();
  expect(await bubbles()).toBe(before); // no message exists yet
  await expect(log).not.toContainText("[MOCK DRAFT]");
  await owner.reload();
  await expect(log).not.toContainText("[MOCK DRAFT]"); // nothing was sent behind the scenes
  await expect(owner.getByLabel("Reply", { exact: true })).toHaveValue("");

  // Draft, edit, send through the normal composer.
  await owner.getByRole("button", { name: "Suggest reply with AI" }).click();
  await expect(reply).toHaveValue(/\[MOCK DRAFT\]/);
  await reply.fill("Yes, we can deliver by Friday. (edited by a person)");
  await owner.getByRole("button", { name: "Send", exact: true }).click();
  await expect(log).toContainText("(edited by a person)");
  // The mock Meta cannot deliver, so the text may come back into the composer for a retry (the existing send behaviour); clearing it removes the AI marker.
  await reply.fill("");
  await expect(owner.getByText("AI draft (mock)")).toHaveCount(0);

  // Replacing an existing text asks first.
  await reply.fill("my own text");
  owner.once("dialog", (d) => void d.dismiss());
  await owner.getByRole("button", { name: "Suggest reply with AI" }).click();
  await expect(reply).toHaveValue("my own text");
  await reply.fill("");

  for (const w of [375, 768, 1440]) {
    await owner.setViewportSize({ width: w, height: 900 });
    await expect(owner.getByRole("button", { name: "Suggest reply with AI" })).toBeVisible();
    expect(await noOverflow(owner)).toBe(true);
  }
  await owner.setViewportSize({ width: 1440, height: 900 });
  await axe(owner, "inbox-thread-ai");

  // The usage table shows the calls (counts only), and the draft text is nowhere in it.
  await owner.goto(SETTINGS());
  const usage = owner.getByRole("region", { name: "AI usage by day" });
  await expect(usage).toContainText("Reply suggestion");
  await expect(owner.locator("body")).not.toContainText("MOCK DRAFT");
});

test("a spent budget blocks suggestions with a clear message", async () => {
  await owner.goto(SETTINGS());
  await owner.getByLabel("Monthly limit (USD)").fill("0");
  await owner.getByRole("button", { name: "Save budget" }).click();
  await expect(owner.getByText("Budget saved")).toBeVisible();
  await expect(owner.getByText("Limit reached: AI calls are blocked")).toBeVisible();
  await owner.goto(`/w/${workspaceId}/inbox`);
  await owner.getByRole("link", { name: /Maria Lopez/ }).click();
  await owner.getByRole("button", { name: "Suggest reply with AI" }).click();
  await expect(owner.getByText(/monthly AI budget is used up/)).toBeVisible();
  await expect(owner.getByLabel("Reply", { exact: true })).toHaveValue("");
  await owner.goto(SETTINGS());
  await expect(owner.getByRole("region", { name: "AI usage by day" })).toContainText("Reply suggestion");
});

test("a viewer cannot configure or use AI (UI and API)", async ({ browser }) => {
  const vp = await (await browser.newContext()).newPage();
  const email = await register(vp, "Vic Viewer");
  await addMemberByEmail(workspaceId, email, "viewer");
  await vp.goto(SETTINGS());
  await expect(vp.getByText("Only owners and admins can manage AI")).toBeVisible();
  await expect(vp.getByRole("button", { name: "Connect provider" })).toHaveCount(0);
  const W = `/v1/workspaces/${workspaceId}`;
  expect((await api(vp).get(`${W}/ai/providers`)).status()).toBe(403);
  expect((await api(vp).get(`${W}/ai/usage`)).status()).toBe(403);
  expect((await api(vp).get(`${W}/ai/status`)).status()).toBe(403);
  expect((await api(vp).post(`${W}/conversations/019a0000-0000-7000-8000-000000000000/ai/suggest-reply`, {})).status()).toBe(403);
  expect((await (await vp.request.put(`${W}/ai/budget`, { data: { monthlyCapMicro: 1, hardStop: false }, headers: { origin: `http://localhost:${process.env.E2E_WEB_PORT ?? "3217"}` } })).status())).toBe(403);
  await vp.goto(`/w/${workspaceId}/inbox`);
  await vp.getByRole("link", { name: /Maria Lopez/ }).click();
  await expect(vp.getByText("You have read-only access.")).toBeVisible();
  await expect(vp.getByRole("button", { name: "Suggest reply with AI" })).toHaveCount(0);
});
