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

test("connect OpenRouter with a starting model, then pick models per job in the browser", async () => {
  await owner.setViewportSize({ width: 1440, height: 900 });
  await owner.goto(SETTINGS());
  await owner.getByLabel("Provider", { exact: true }).selectOption("openrouter");
  const key = owner.getByLabel("API key");
  await expect(key).toHaveAttribute("type", "password");
  await expect(owner.getByText("Not yet tested with a real request", { exact: true }).first()).toBeVisible();

  // No starting model yet: saving is refused with a clear message.
  await key.fill("sk-or-v1-E2E-SECRET-0123456789abcdef");
  await owner.getByRole("button", { name: "Connect provider" }).click();
  await expect(owner.getByText(/Choose a starting model for OpenRouter first/)).toBeVisible();

  await owner.getByRole("button", { name: "Choose a starting model" }).click();
  const dlg = owner.getByRole("dialog", { name: "Choose a starting model" });
  await expect(dlg.getByText(/MOCK list/)).toBeVisible();
  // Router aliases and bad prices never reach the list.
  await expect(dlg.getByRole("button", { name: /Mock Alpha Chat/ })).toBeVisible();
  await expect(dlg.getByText("openrouter/auto")).toHaveCount(0);
  await expect(dlg.getByText("mockvendor/broken-price")).toHaveCount(0);
  await expect(dlg.getByText("$3.00 in / $15.00 out per 1M")).toBeVisible();
  await dlg.getByRole("button", { name: "Images", exact: true }).click();
  await expect(dlg.getByRole("button", { name: /Mock Gamma Text/ })).toHaveCount(0);
  await dlg.getByRole("button", { name: "Images", exact: true }).click();
  await dlg.getByLabel("Search models").fill("zzz-nothing");
  await expect(dlg.getByText("No models match")).toBeVisible();
  await dlg.getByLabel("Search models").fill("");
  await dlg.getByRole("button", { name: /Mock Alpha Chat/ }).click();
  await expect(dlg).toHaveCount(0);
  await owner.getByRole("button", { name: "Connect provider" }).click();
  await expect(owner.getByText("AI provider saved")).toBeVisible();
  await expect(key).toHaveValue("");
  await expect(owner.getByText(/A key ending in cdef is stored/)).toBeVisible();

  // The vision job offers only models that can read images; the others are listed but cannot be picked.
  await owner.getByRole("button", { name: "Change the model for Read images customers send" }).click();
  const jb = owner.getByRole("dialog", { name: /Read images customers send/ });
  await expect(jb.getByRole("button", { name: /Mock Gamma Text/ })).toHaveCount(0);
  await expect(jb.getByText(/hidden\./)).toBeVisible();
  await jb.getByLabel("Hide models that cannot do this job").uncheck();
  await expect(jb.getByRole("button", { name: /Mock Gamma Text/ })).toBeDisabled();
  await jb.getByRole("button", { name: "Close" }).click();

  // A text job: choose a second model, which is turned on for the workspace and pinned.
  await owner.getByRole("button", { name: "Change the model for Reply suggestions in the inbox" }).click();
  const rb = owner.getByRole("dialog", { name: /Reply suggestions in the inbox/ });
  await rb.getByRole("button", { name: /Mock Beta Mini/ }).click();
  await expect(owner.getByText("Reply suggestions in the inbox: model saved")).toBeVisible();
  await expect(owner.getByRole("button", { name: "Change the model for Reply suggestions in the inbox" })).toContainText("mockvendor/beta-mini");
  await expect(owner.getByLabel("Models in use").getByRole("listitem")).toHaveCount(2);
  await expect(owner.locator("body")).not.toContainText("E2E-SECRET");

  // Capabilities (Advanced): the vision model shows its stored badge, the text-only one does not.
  await openFold(owner, "Capabilities");
  const caps = owner.getByLabel("OpenRouter capabilities", { exact: true });
  await expect(caps.getByLabel("mockvendor/alpha-chat capabilities")).toContainText("Vision");
  await expect(caps.getByLabel("mockvendor/beta-mini capabilities")).toContainText("No Vision");
  for (const w of [375, 768, 1440]) {
    await owner.setViewportSize({ width: w, height: 900 });
    expect(await noOverflow(owner)).toBe(true);
  }
  await owner.setViewportSize({ width: 1440, height: 900 });
  await axe(owner, "settings-ai-openrouter");
});

test("a suggestion works through the openrouter provider id (fake adapter)", async () => {
  await owner.goto(`/w/${workspaceId}/inbox`);
  await owner.getByRole("link", { name: /Maria Lopez/ }).click();
  const reply = owner.getByLabel("Reply", { exact: true });
  await owner.getByRole("button", { name: "Suggest reply with AI" }).click();
  await expect(reply).toHaveValue(/\[MOCK OPENROUTER DRAFT\]/);
  await owner.goto(SETTINGS());
  await expect(owner.getByRole("region", { name: "AI usage by day" })).toContainText("Reply suggestion");
});

test("a viewer cannot configure or browse (UI and API)", async ({ browser }) => {
  const vp = await (await browser.newContext()).newPage();
  const email = await register(vp, "Vic Viewer");
  await addMemberByEmail(workspaceId, email, "viewer");
  await vp.goto(SETTINGS());
  await expect(vp.getByText("Only owners and admins can manage AI")).toBeVisible();
  await expect(vp.getByRole("button", { name: /Change the model for/ })).toHaveCount(0);
  expect((await api(vp).get(`/v1/workspaces/${workspaceId}/ai/providers/openrouter/models`)).status()).toBe(403);
});
