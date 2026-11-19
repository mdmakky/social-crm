import { expect, test, type Browser } from "@playwright/test";
import { addMemberByEmail, register, signUpAndCreate } from "./helpers";

const GROUPS = ["Workspace", "CRM data", "AI and automation", "Channels", "Team and security"];
const OLD_URLS: [string, string][] = [
  ["settings", "General"], ["settings/contacts", "Lead fields"], ["settings/pipelines", "Lead stages"], ["settings/ad-measurement", "Ad measurement"], ["settings/notifications", "Notification preferences"],
  // The four AI and automation pages became tabs of one hub; the old URLs redirect into it.
  ["settings/automations", "AI and automation"], ["settings/ai", "AI and automation"], ["settings/ai-agents", "AI and automation"], ["settings/knowledge", "AI and automation"],
  ["integrations", "Integrations"], ["members", "Members"], ["audit-log", "Audit log"],
];

test.describe("settings information architecture", () => {
  test("desktop: grouped sub-navigation with aria-current, and every old URL still loads inside it", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const own = await signUpAndCreate(page, "Nav Owner", "Nav Co");
    const nav = page.getByRole("navigation", { name: "Settings sections" });
    for (const [path, h1] of OLD_URLS) {
      await page.goto(`/w/${own.workspaceId}/${path}`);
      await expect(page.getByRole("heading", { level: 1, name: h1, exact: true })).toBeVisible();
      await expect(nav).toBeVisible();
      for (const g of GROUPS) await expect(nav.getByText(g, { exact: true }).first()).toBeVisible();
      await expect(nav.locator("[aria-current=page]")).toHaveCount(1);
    }
    await page.goto(`/w/${own.workspaceId}/members`);
    await expect(nav.getByRole("link", { name: "Members" })).toHaveAttribute("aria-current", "page");
    await nav.getByRole("link", { name: "Audit log" }).click();
    await expect(page).toHaveURL(/\/audit-log$/);
    // One home per thing: the main sidebar has Settings only; Integrations, Members, Audit log and Ad measurement live in the Settings sub-navigation.
    const main = page.getByRole("navigation", { name: "Main" });
    await expect(main.getByRole("link", { name: "Settings" })).toBeVisible();
    for (const gone of ["Integrations", "Members", "Audit log"]) await expect(main.getByRole("link", { name: gone })).toHaveCount(0);
    await nav.getByRole("link", { name: "Ad measurement" }).click();
    await expect(page).toHaveURL(/\/settings\/ad-measurement$/);
    await expect(page.getByRole("heading", { level: 2, name: "Start with a dataset" })).toBeVisible();
    // Keyboard: the nav links are focusable in order.
    await nav.getByRole("link", { name: "General" }).focus();
    await page.keyboard.press("Tab");
    await expect(nav.getByRole("link", { name: "Notifications" })).toBeFocused();
  });

  test("phone 375: section list, then detail, then back", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 800 });
    const own = await signUpAndCreate(page, "Phone Owner", "Phone Co");
    await page.goto(`/w/${own.workspaceId}/settings`);
    await expect(page.getByRole("heading", { level: 1, name: "Settings" })).toBeVisible();
    const list = page.getByRole("navigation", { name: "Settings sections" });
    await expect(list.getByRole("link", { name: /^AI and automation/ })).toBeVisible();
    await expect(page.getByLabel("Workspace name")).toBeHidden();
    // Row targets are at least 44px tall.
    const box = await list.getByRole("link", { name: /^AI and automation/ }).boundingBox();
    expect(box!.height).toBeGreaterThanOrEqual(44);
    await list.getByRole("link", { name: /^AI and automation/ }).click();
    await expect(page.getByRole("heading", { level: 1, name: "AI and automation" })).toBeVisible();
    await page.getByRole("link", { name: "Settings", exact: true }).first().click();
    await expect(page).toHaveURL(/\/settings$/);
    await list.getByRole("link", { name: /^General/ }).click();
    await expect(page).toHaveURL(/\/settings\/general$/);
    await expect(page.getByLabel("Workspace name")).toBeVisible();
  });

  test("roles: agent and viewer only see the sections they can use; admin-only URLs explain", async ({ page, browser }) => {
    const own = await signUpAndCreate(page, "Role Owner", "Role Co");
    const user = async (name: string, role: string) => {
      const ctx = await (browser as Browser).newContext();
      const p = await ctx.newPage();
      const email = await register(p, name);
      await addMemberByEmail(own.workspaceId, email, role);
      await p.setViewportSize({ width: 1440, height: 900 });
      await p.goto(`/w/${own.workspaceId}/settings`);
      return p;
    };
    const agent = await user("Sam Agent", "agent");
    const viewer = await user("Vic Viewer", "viewer");
    for (const [p, canIntegrations] of [[agent, true], [viewer, false]] as const) {
      const nav = p.getByRole("navigation", { name: "Settings sections" });
      for (const l of ["General", "Notifications", "Lead fields", "Lead stages", "AI and automation", "Members"]) await expect(nav.getByRole("link", { name: l })).toBeVisible();
      for (const l of ["AI", "AI Agents", "Automations", "Knowledge", "Audit log", "Ad measurement"]) await expect(nav.getByRole("link", { name: l, exact: true })).toHaveCount(0);
      await expect(nav.getByRole("link", { name: "Integrations" })).toHaveCount(canIntegrations ? 1 : 0);
      await expect(nav.getByText("More sections are available to owners and admins.")).toBeVisible();
    }
    // An agent can neither manage AI nor automations: the hub opens on Knowledge (read-only) and shows only that tab; the admin-only tabs explain.
    await agent.goto(`/w/${own.workspaceId}/settings/ai`);
    await expect(agent).toHaveURL(/\/settings\/ai\/knowledge$/);
    const tabsNav = agent.getByRole("navigation", { name: "AI and automation sections" });
    await expect(tabsNav.getByRole("link")).toHaveText(["Knowledge"]);
    await agent.goto(`/w/${own.workspaceId}/settings/ai/setup`);
    await expect(agent.getByText("Only owners and admins can manage AI")).toBeVisible();
    await viewer.goto(`/w/${own.workspaceId}/audit-log`);
    await expect(viewer.getByText("Only owners and admins can view the audit log")).toBeVisible();
  });
});
