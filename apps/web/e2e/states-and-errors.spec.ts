import { devices, expect, test, type Browser, type Page } from "@playwright/test";
import { addMemberByEmail, register, signUpAndCreate } from "./helpers";

async function ownerWithAgent(page: Page, browser: Browser) {
  const { workspaceId } = await signUpAndCreate(page, "State Owner", "States Co");
  const ctx = await browser.newContext();
  const agentPage = await ctx.newPage();
  const email = await register(agentPage, "Ari Agent");
  await ctx.close();
  await addMemberByEmail(workspaceId, email, "agent");
  return workspaceId;
}

test.describe("failure and error states in the browser", () => {
  test("a server rule violation is explained in the role dialog", async ({ page, browser }) => {
    const ws = await ownerWithAgent(page, browser);
    await page.goto(`/w/${ws}/members`);
    await page.route("**/v1/workspaces/*/members/*", (r) => r.fulfill({ status: 403, contentType: "application/json", body: JSON.stringify({ error: { code: "last_owner" } }) }));
    await page.getByRole("button", { name: "Actions for Ari Agent" }).click();
    await page.getByRole("menuitem", { name: "Change role" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("Role").selectOption("viewer");
    await dialog.getByRole("button", { name: "Save role" }).click();
    await expect(dialog.getByRole("alert")).toContainText("A workspace needs at least one owner");
    await expect(dialog).toBeVisible(); // stays open so the user can retry or cancel
  });

  test("a network failure is reported with recovery advice", async ({ page, browser }) => {
    const ws = await ownerWithAgent(page, browser);
    await page.goto(`/w/${ws}/members`);
    await page.route("**/v1/workspaces/*/members/*", (r) => r.abort("failed"));
    await page.getByRole("button", { name: "Actions for Ari Agent" }).click();
    await page.getByRole("menuitem", { name: "Remove from workspace" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Remove member" }).click();
    await expect(page.getByRole("dialog").getByRole("alert")).toContainText("Could not reach the server");
  });

  test("settings: a server error and a contract mismatch show different, honest messages and success clears them", async ({ page }) => {
    const { workspaceId } = await signUpAndCreate(page, "Save Owner", "Save Co");
    await page.goto(`/w/${workspaceId}/settings`);
    await page.route(`**/v1/workspaces/${workspaceId}`, (r) => (r.request().method() === "PATCH" ? r.fulfill({ status: 500, contentType: "application/json", body: "{}" }) : r.continue()));
    await page.getByLabel("Workspace name").fill("Save Co 2");
    await page.getByRole("button", { name: "Save changes" }).click();
    await expect(page.locator("main").getByRole("alert").filter({ hasText: "Something went wrong" })).toBeVisible();
    await page.unroute(`**/v1/workspaces/${workspaceId}`);
    await page.route(`**/v1/workspaces/${workspaceId}`, (r) => (r.request().method() === "PATCH" ? r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ unexpected: true }) }) : r.continue()));
    await page.getByRole("button", { name: "Save changes" }).click();
    await expect(page.locator("main").getByRole("alert").filter({ hasText: "out of sync" })).toBeVisible();
    await page.unroute(`**/v1/workspaces/${workspaceId}`);
    await page.getByRole("button", { name: "Save changes" }).click();
    await expect(page.getByText("Workspace settings saved.")).toBeVisible();
    await expect(page.locator("main").getByRole("alert")).toHaveCount(0); // scoped: Next adds an empty route-announcer alert
  });

  test("audit log: failing to load older entries keeps the list and offers retry", async ({ page }) => {
    const { workspaceId } = await signUpAndCreate(page, "Audit Owner", "Audit Co");
    for (let i = 0; i < 26; i++) await page.request.patch(`/v1/workspaces/${workspaceId}`, { data: { name: `Audit Co ${i}` }, headers: { origin: `http://localhost:${process.env.E2E_WEB_PORT ?? "3217"}` } });
    await page.goto(`/w/${workspaceId}/audit-log`);
    await expect(page.getByRole("button", { name: "Load older entries" })).toBeVisible(); // content streams in after the skeleton
    const before = await page.getByRole("listitem").count();
    await page.route("**/audit-log?*cursor=*", (r) => r.abort("failed"));
    await page.getByRole("button", { name: "Load older entries" }).click();
    await expect(page.locator("main").getByRole("alert")).toContainText("Could not reach the server");
    expect(await page.getByRole("listitem").count()).toBe(before);
    await page.unroute("**/audit-log?*cursor=*");
    await page.getByRole("button", { name: "Load older entries" }).click();
    await expect(page.getByRole("button", { name: "Load older entries" })).toHaveCount(0);
  });

  test("the account menu shows a visible keyboard focus indicator", async ({ page }) => {
    await signUpAndCreate(page, "Keys Owner", "Keys Co");
    await page.getByRole("button", { name: "Account menu" }).focus();
    await page.keyboard.press("Enter");
    await page.keyboard.press("ArrowDown");
    const outline = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement;
      const cs = getComputedStyle(el);
      return { role: el.getAttribute("role"), style: cs.outlineStyle, width: parseFloat(cs.outlineWidth) };
    });
    expect(outline.role).toBe("menuitem");
    expect(outline.style).not.toBe("none");
    expect(outline.width).toBeGreaterThanOrEqual(2);
  });

  test("the navigation drawer closes when the viewport grows past the rail breakpoint", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await signUpAndCreate(page, "Resize Owner", "Resize Co");
    await page.getByRole("button", { name: "Open navigation" }).click();
    await expect(page.getByRole("dialog", { name: "Navigation" })).toBeVisible();
    await page.setViewportSize({ width: 1024, height: 768 });
    await expect(page.getByRole("dialog", { name: "Navigation" })).toBeHidden();
    await page.getByRole("link", { name: "Members" }).filter({ visible: true }).first().click(); // page is interactive again, not inert
    await expect(page).toHaveURL(/\/members$/);
  });
});

// defaultBrowserType cannot be set inside a describe block; the project already uses Chromium.
const { defaultBrowserType: _browser, ...pixel7 } = devices["Pixel 7"];

test.describe("touch devices", () => {
  test.use(pixel7);

  test("tap targets are at least 44px and inputs use 16px text", async ({ page }) => {
    await page.goto("/login");
    const sizes = await page.evaluate(() => {
      const box = (el: Element) => { const r = el.getBoundingClientRect(); return { h: Math.round(r.height), w: Math.round(r.width) }; };
      return {
        submit: box(document.querySelector("button[type=submit]")!),
        email: box(document.querySelector("input[name=email]")!),
        password: box(document.querySelector("input[name=password]")!),
        fontSize: getComputedStyle(document.querySelector("input[name=email]")!).fontSize,
        coarse: matchMedia("(pointer: coarse)").matches,
      };
    });
    expect(sizes.coarse).toBe(true);
    for (const k of ["submit", "email", "password"] as const) expect(sizes[k].h).toBeGreaterThanOrEqual(44);
    expect(sizes.fontSize).toBe("16px");
  });

  test("shell controls are at least 44px on touch", async ({ page }) => {
    await signUpAndCreate(page, "Touch Owner", "Touch Co");
    for (const name of ["Open navigation", "Open command menu", "Account menu"]) {
      const box = await page.getByRole("button", { name }).boundingBox();
      expect(box!.height, name).toBeGreaterThanOrEqual(44);
      expect(box!.width, name).toBeGreaterThanOrEqual(44);
    }
    await page.getByRole("button", { name: "Open command menu" }).click();
    const input = page.getByPlaceholder("Search contacts, pages and actions");
    expect(await input.evaluate((el) => getComputedStyle(el).fontSize)).toBe("16px");
  });
});
