import { expect, test, type Page } from "@playwright/test";
import { addMemberByEmail, api, register, signUpAndCreate, openFold } from "./helpers";
import { axe, seed } from "./channel-helpers";

/**
 * OpenRouter gateway, slice A. Uses the MOCK environment (E2E_META_MOCK=1 also sets OPENROUTER_MOCK=1): a fixed offline model list and a fake adapter served under the `openrouter` id.
 * This proves our browser, validation and permissions, not the real OpenRouter service (UNVERIFIED). Needs a fresh database, like the other AI specs.
 */
test.describe.configure({ mode: "serial" });

let owner: Page, workspaceId = "";
const SETTINGS = () => `/w/${workspaceId}/settings/ai/setup`;
const noOverflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);

test.beforeAll(async ({ browser }) => {
  owner = await (await browser.newContext()).newPage();
  ({ workspaceId } = await signUpAndCreate(owner, "Olive Owner", "OR Co"));
  seed(workspaceId);
});

test("browse, filter, enable two models, choose the default, save", async () => {
  await owner.setViewportSize({ width: 1440, height: 900 });
  await owner.goto(SETTINGS());
  await owner.getByLabel("Provider", { exact: true }).selectOption("openrouter");
  const key = owner.getByLabel("API key");
  await expect(key).toHaveAttribute("type", "password");
  await expect(owner.getByText("Not tested live", { exact: true }).first()).toBeVisible();
  await expect(owner.getByText("No models enabled")).toBeVisible();

  // No model yet: saving is refused with a clear message.
  await key.fill("sk-or-v1-E2E-SECRET-0123456789abcdef");
  await owner.getByRole("button", { name: "Connect provider" }).click();
  await expect(owner.getByText(/Enable at least one model/)).toBeVisible();

  await owner.getByRole("button", { name: "Browse models" }).click();
  const dlg = owner.getByRole("dialog", { name: "Browse OpenRouter models" });
  await expect(dlg.getByText(/MOCK list/)).toBeVisible();
  await expect(dlg.getByText("0 of 50 selected")).toBeVisible();
  // Router aliases and bad prices never reach the list.
  await expect(dlg.getByLabel("mockvendor/alpha-chat")).toBeVisible();
  await expect(dlg.getByLabel("openrouter/auto")).toHaveCount(0);
  await expect(dlg.getByLabel("mockvendor/broken-price")).toHaveCount(0);
  await expect(dlg.getByText("3.00 in, 15.00 out per 1M tokens (USD)")).toBeVisible();

  await dlg.getByRole("button", { name: "Vision", exact: true }).click();
  await expect(dlg.getByLabel("mockvendor/alpha-chat")).toBeVisible();
  await expect(dlg.getByLabel("mockvendor/gamma-text")).toHaveCount(0);
  await dlg.getByRole("button", { name: "Vision", exact: true }).click();
  await dlg.getByLabel("Search models").fill("zzz-nothing");
  await expect(dlg.getByText("No models match")).toBeVisible();
  await dlg.getByLabel("Search models").fill("beta");
  await expect(dlg.getByLabel("mockvendor/alpha-chat")).toHaveCount(0);
  await dlg.getByLabel("Search models").fill("");

  await dlg.getByLabel("mockvendor/alpha-chat").check();
  await dlg.getByLabel("mockvendor/beta-mini").check();
  await expect(dlg.getByText("2 of 50 selected")).toBeVisible();
  for (const w of [375, 768, 1440]) {
    await owner.setViewportSize({ width: w, height: 900 });
    expect(await noOverflow(owner)).toBe(true);
  }
  await owner.setViewportSize({ width: 1440, height: 900 });
  await axe(owner, "openrouter-browser");
  await dlg.getByRole("button", { name: "Done" }).click();

  const list = owner.getByRole("list", { name: "Enabled models" });
  await expect(list.getByRole("listitem")).toHaveCount(2);
  await list.getByLabel("Use mockvendor/beta-mini as the default").check();
  await owner.getByRole("button", { name: "Connect provider" }).click();
  await expect(owner.getByText("AI provider saved")).toBeVisible();
  await expect(key).toHaveValue("");
  await expect(owner.getByText(/A key ending in cdef is stored/)).toBeVisible();

  await owner.reload();
  await owner.getByLabel("Provider", { exact: true }).selectOption("openrouter");
  await expect(owner.getByText("Enabled models (2 of 50)")).toBeVisible();
  await expect(owner.getByLabel("Use mockvendor/beta-mini as the default")).toBeChecked();
  await expect(owner.locator("body")).not.toContainText("E2E-SECRET");

  // Capabilities panel: the vision model shows its stored badge, the text-only one does not.
  await openFold(owner, "Capabilities");
  const caps = owner.getByLabel("OpenRouter capabilities", { exact: true });
  await expect(caps.getByLabel("mockvendor/alpha-chat capabilities")).toContainText("Vision");
  await expect(caps.getByLabel("mockvendor/beta-mini capabilities")).toContainText("No Vision");
  await axe(owner, "settings-ai-openrouter");
});

test("a suggestion works through the openrouter provider id (fake adapter)", async () => {
  await owner.goto(`/w/${workspaceId}/inbox`);
  await owner.getByRole("link", { name: /Maria Lopez/ }).click();
  const reply = owner.getByLabel("Reply", { exact: true });
  await owner.getByRole("button", { name: "Suggest reply with AI" }).click();
  await expect(reply).toHaveValue(/\[MOCK OPENROUTER DRAFT\]/);
  await owner.goto(SETTINGS());
  await openFold(owner, "Usage");
  await expect(owner.getByRole("region", { name: "AI usage by day" })).toContainText("Reply suggestion");
});

test("a viewer cannot configure or browse (UI and API)", async ({ browser }) => {
  const vp = await (await browser.newContext()).newPage();
  const email = await register(vp, "Vic Viewer");
  await addMemberByEmail(workspaceId, email, "viewer");
  await vp.goto(SETTINGS());
  await expect(vp.getByText("Only owners and admins can manage AI")).toBeVisible();
  await expect(vp.getByRole("button", { name: "Browse models" })).toHaveCount(0);
  expect((await api(vp).get(`/v1/workspaces/${workspaceId}/ai/providers/openrouter/models`)).status()).toBe(403);
});
