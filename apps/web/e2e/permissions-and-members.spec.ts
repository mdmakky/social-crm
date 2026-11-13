import { expect, test, type Browser, type Page } from "@playwright/test";
import { addMemberByEmail, register, signUpAndCreate } from "./helpers";

async function newUser(browser: Browser, name: string) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const email = await register(page, name);
  return { ctx, page, email };
}
async function team(browser: Browser, owner: Page, workspaceId: string) {
  const admin = await newUser(browser, "Dana Admin");
  const agent = await newUser(browser, "Sam Agent");
  const viewer = await newUser(browser, "Vic Viewer");
  await addMemberByEmail(workspaceId, admin.email, "admin");
  await addMemberByEmail(workspaceId, agent.email, "agent");
  await addMemberByEmail(workspaceId, viewer.email, "viewer");
  for (const u of [admin, agent, viewer]) await u.page.goto(`/w/${workspaceId}`);
  return { admin, agent, viewer, owner };
}

test.describe("permission-aware navigation and pages", () => {
  test("each role sees only the navigation it can use", async ({ page, browser }) => {
    const { workspaceId } = await signUpAndCreate(page, "Olive Owner", "Perm Co");
    const t = await team(browser, page, workspaceId);
    const nav = (p: Page) => p.getByRole("navigation", { name: "Main" }).first();

    for (const p of [page, t.admin.page, t.agent.page, t.viewer.page]) await nav(p).getByText("Coming soon").click();
    await expect(nav(page).getByRole("link", { name: "Audit log" })).toBeVisible();
    await expect(nav(page).getByText("Automation")).toBeVisible();
    await expect(nav(t.admin.page).getByRole("link", { name: "Audit log" })).toBeVisible();

    for (const p of [t.agent.page, t.viewer.page]) {
      await expect(nav(p).getByRole("link", { name: "Audit log" })).toHaveCount(0);
      await expect(nav(p).getByText("Automation")).toHaveCount(0);
    }
    await expect(nav(t.agent.page).getByText("Integrations")).toBeVisible();
    await expect(nav(t.viewer.page).getByText("Integrations")).toHaveCount(0);
    await expect(nav(t.viewer.page).getByText("AI assistant")).toHaveCount(0);
    await expect(nav(t.agent.page).getByText("AI assistant")).toBeVisible();
  });

  test("restricted pages explain the restriction instead of failing", async ({ page, browser }) => {
    const { workspaceId } = await signUpAndCreate(page, "Olive Owner", "Perm Two Co");
    const t = await team(browser, page, workspaceId);
    await t.agent.page.goto(`/w/${workspaceId}/audit-log`);
    await expect(t.agent.page.getByText("Only owners and admins can view the audit log")).toBeVisible();
    await t.agent.page.goto(`/w/${workspaceId}/settings`);
    await expect(t.agent.page.getByLabel("Workspace name")).toBeDisabled();
    await expect(t.agent.page.getByRole("button", { name: "Save changes" })).toHaveCount(0);
    await t.agent.page.goto(`/w/${workspaceId}`);
    await expect(t.agent.page.getByText("Activity is for owners and admins")).toBeVisible();
  });

  test("owners and admins can rename the workspace; the change shows everywhere", async ({ page }) => {
    await signUpAndCreate(page, "Rena Owner", "Old Name Co");
    await page.getByRole("link", { name: "Settings" }).first().click();
    await page.getByLabel("Workspace name").fill("Renamed Studio");
    await page.getByLabel("Time zone").selectOption("Europe/Berlin");
    await page.getByRole("button", { name: "Save changes" }).click();
    await expect(page.getByText("Workspace settings saved.")).toBeVisible();
    await page.goto(page.url().replace("/settings", ""));
    await expect(page.getByRole("heading", { name: "Renamed Studio", level: 1 })).toBeVisible();
    await expect(page.getByText(/Europe\/Berlin/)).toBeVisible();
  });
});

test.describe("members", () => {
  test("an admin changes an agent's role; the audit log records it", async ({ page, browser }) => {
    const { workspaceId } = await signUpAndCreate(page, "Olive Owner", "Members Co");
    const t = await team(browser, page, workspaceId);
    const a = t.admin.page;
    await a.goto(`/w/${workspaceId}/members`);
    await expect(a.getByRole("row", { name: /Sam Agent/ })).toContainText("Agent");
    // admins have no actions on owners; agents have none anywhere
    await expect(a.getByRole("button", { name: "Actions for Olive Owner" })).toHaveCount(0);
    await t.agent.page.goto(`/w/${workspaceId}/members`);
    await expect(t.agent.page.getByRole("button", { name: /Actions for/ })).toHaveCount(0);

    await a.getByRole("button", { name: "Actions for Sam Agent" }).click();
    await a.getByRole("menuitem", { name: "Change role" }).click();
    const dialog = a.getByRole("dialog", { name: "Change role for Sam Agent" });
    await expect(dialog.getByRole("option", { name: "Owner" })).toHaveCount(0); // admins cannot grant owner
    await dialog.getByLabel("Role").selectOption("viewer");
    await dialog.getByRole("button", { name: "Save role" }).click();
    await expect(a.getByRole("row", { name: /Sam Agent/ })).toContainText("Viewer");

    await page.goto(`/w/${workspaceId}/audit-log`);
    await expect(page.getByText("Dana Admin changed Sam Agent's role from agent to viewer")).toBeVisible();
  });

  test("removing a member asks for confirmation and revokes access", async ({ page, browser }) => {
    const { workspaceId } = await signUpAndCreate(page, "Olive Owner", "Remove Co");
    const t = await team(browser, page, workspaceId);
    await page.goto(`/w/${workspaceId}/members`);
    await page.getByRole("button", { name: "Actions for Vic Viewer" }).click();
    await page.getByRole("menuitem", { name: "Remove from workspace" }).click();
    const dialog = page.getByRole("dialog", { name: "Remove Vic Viewer?" });
    await expect(dialog).toContainText("They will lose access");
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(page.getByRole("row", { name: /Vic Viewer/ })).toBeVisible();
    await page.getByRole("button", { name: "Actions for Vic Viewer" }).click();
    await page.getByRole("menuitem", { name: "Remove from workspace" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Remove member" }).click();
    await expect(page.getByRole("dialog")).toBeHidden(); // the dialog hides the page from the accessibility tree while open, so wait for it first
    await expect(page.getByRole("row", { name: /Vic Viewer/ })).toHaveCount(0);
    await t.viewer.page.goto(`/w/${workspaceId}`);
    await expect(t.viewer.page.getByText("We couldn't find that page")).toBeVisible();
  });

  test("the only owner cannot be demoted or removed from the UI", async ({ page }) => {
    await signUpAndCreate(page, "Solo Owner", "Solo Co");
    await page.getByRole("link", { name: "Members" }).first().click();
    await expect(page.getByRole("row", { name: /Solo Owner/ })).toContainText("Owner");
    await expect(page.getByRole("button", { name: /Actions for Solo Owner/ })).toHaveCount(0);
  });
});

test("audit log pages through older entries", async ({ page }) => {
  const { workspaceId } = await signUpAndCreate(page, "Pager Owner", "Paging Co");
  for (let i = 0; i < 27; i++) {
    const res = await page.request.patch(`/v1/workspaces/${workspaceId}`, { data: { name: `Paging Co ${i}` }, headers: { origin: "http://localhost:3217" } });
    expect(res.status()).toBe(200);
  }
  await page.goto(`/w/${workspaceId}/audit-log`);
  await expect(page.getByRole("button", { name: "Load older entries" })).toBeVisible();
  const before = await page.getByText(/updated the workspace name/).count();
  await page.getByRole("button", { name: "Load older entries" }).click();
  await expect(page.getByRole("button", { name: "Load older entries" })).toHaveCount(0);
  expect(await page.getByText(/updated the workspace name/).count()).toBeGreaterThan(before);
});
