import { expect, test, type Page } from "@playwright/test";
import { createWorkspace, PASSWORD, register, signIn, signOut, signUpAndCreate, uniqueEmail } from "./helpers";

test.describe("authentication", () => {
  test("unauthenticated visitors are sent to sign in, and back to the same page after login", async ({ page }) => {
    const { email, workspaceId } = await signUpAndCreate(page, "Back Again", "Return Co");
    await signOut(page);
    await page.goto(`/w/${workspaceId}/members`);
    await expect(page).toHaveURL(/\/login\?next=/);
    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Password").fill(PASSWORD);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page).toHaveURL(`/w/${workspaceId}`); // the layout's next param targets the workspace root
  });

  test("the next parameter cannot send users to another site", async ({ page }) => {
    const { email } = await signUpAndCreate(page, "Redirect Safe", "Redirect Co");
    for (const evil of ["//evil.example", "/\\evil.example", "https://evil.example"]) {
      await signOut(page);
      await page.goto(`/login?next=${encodeURIComponent(evil)}`);
      await page.getByLabel("Email").fill(email);
      await page.getByLabel("Password").fill(PASSWORD);
      await page.getByRole("button", { name: "Sign in" }).click();
      await page.waitForURL(/\/w\//);
      expect(new URL(page.url()).origin).toBe(`http://localhost:${process.env.E2E_WEB_PORT ?? "3217"}`);
    }
  });

  test("responses carry clickjacking and sniffing protections", async ({ request }) => {
    const res = await request.get("/login");
    expect(res.headers()["x-frame-options"]).toBe("DENY");
    expect(res.headers()["content-security-policy"]).toContain("frame-ancestors 'none'");
    expect(res.headers()["x-content-type-options"]).toBe("nosniff");
    expect(res.headers()["referrer-policy"]).toBe("strict-origin-when-cross-origin");
    expect(res.headers()["x-powered-by"]).toBeUndefined();
  });

  test("registration validates input with specific messages", async ({ page }) => {
    await page.goto("/register");
    await page.getByRole("button", { name: "Create account" }).click();
    await expect(page.getByText("Enter your name.")).toBeVisible();
    await expect(page.getByText("Enter a valid email address.")).toBeVisible();
    await page.getByLabel("Full name").fill("Priya Nair");
    await page.getByLabel("Email").fill(uniqueEmail("short"));
    await page.getByLabel("Password").fill("short");
    await page.getByRole("button", { name: "Create account" }).click();
    await expect(page.getByText("Use at least 10 characters.")).toBeVisible();
  });

  test("register, onboard, land on the workspace, sign out, sign in again", async ({ page }) => {
    const { email } = await signUpAndCreate(page, "Priya Nair", "Northwind Studio");
    await expect(page).toHaveTitle(/Home · Social CRM/);
    await signOut(page);
    await signIn(page, email);
    await expect(page.getByRole("heading", { name: "Northwind Studio", level: 1 })).toBeVisible();
  });

  test("wrong password shows an error that names the recovery", async ({ page }) => {
    const { email } = await signUpAndCreate(page, "Tomas Reyes", "Reyes Bakery");
    await signOut(page);
    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Password").fill("not-the-password");
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.getByRole("alert").filter({ hasText: "Email or password is incorrect." })).toBeVisible();
    await page.getByLabel("Password").fill(PASSWORD);
    await page.getByRole("button", { name: "Sign in" }).click();
    await page.waitForURL(/\/w\//);
  });

  test("duplicate registration explains what to do", async ({ page }) => {
    const email = await register(page, "Dup User");
    await signOutViaStorage(page);
    await page.goto("/register");
    await page.getByLabel("Full name").fill("Dup User");
    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Password").fill(PASSWORD);
    await page.getByRole("button", { name: "Create account" }).click();
    await expect(page.getByText("An account with this email already exists. Sign in instead.")).toBeVisible();
  });
});

async function signOutViaStorage(page: Page) {
  await page.context().clearCookies();
}

test.describe("shell", () => {
  test("shows built features as links and planned ones as plain text under Coming soon", async ({ page }) => {
    await signUpAndCreate(page, "Ada Owner", "Shell Test Co");
    const nav = page.getByRole("navigation", { name: "Main" }).first();
    for (const label of ["Home", "Members", "Audit log", "Settings"]) await expect(nav.getByRole("link", { name: label })).toBeVisible();
    await expect(nav.getByRole("link", { name: "Home" })).toHaveAttribute("aria-current", "page");
    await expect(nav.getByRole("link", { name: "Inbox" })).toHaveCount(0); // not built: never a link
    await nav.getByText("Coming soon").click();
    for (const label of ["Inbox", "Contacts", "Leads", "Pipeline", "Automation", "AI assistant", "Integrations"]) await expect(nav.getByText(label, { exact: true })).toBeVisible();
    await expect(nav.getByText(/Phase \d/)).toHaveCount(0); // no internal roadmap language in the product
  });

  test("skip link, command menu and keyboard navigation work", async ({ page }) => {
    await signUpAndCreate(page, "Kay Keys", "Keyboard Co");
    await page.keyboard.press("Tab");
    await expect(page.getByRole("link", { name: "Skip to content" })).toBeFocused();
    await page.keyboard.press("Control+k");
    const menu = page.getByRole("dialog", { name: "Command menu" });
    await expect(menu).toBeVisible();
    await page.keyboard.type("memb");
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/\/members$/);
    await expect(page.getByRole("heading", { name: "Members", level: 1 })).toBeVisible();
    await page.keyboard.press("Control+k");
    await page.keyboard.press("Escape");
    await expect(menu).toBeHidden();
  });

  test("workspace switcher lists workspaces and creates another", async ({ page }) => {
    await signUpAndCreate(page, "Multi Owner", "First Workspace");
    await page.getByRole("button", { name: /Switch workspace, current: First Workspace/ }).first().click();
    await page.getByRole("menuitem", { name: "Create workspace" }).click();
    await page.waitForURL("**/onboarding?new=1");
    await createWorkspace(page, "Second Workspace");
    await page.getByRole("button", { name: /Switch workspace, current: Second Workspace/ }).first().click();
    await expect(page.getByRole("menuitem", { name: /First Workspace/ })).toBeVisible();
    await page.getByRole("menuitem", { name: /First Workspace/ }).click();
    await expect(page.getByRole("heading", { name: "First Workspace", level: 1 })).toBeVisible();
  });

  test("a workspace the user does not belong to is a not-found page", async ({ page }) => {
    await signUpAndCreate(page, "Lone User", "Lone Co");
    await page.goto("/w/00000000-0000-4000-8000-000000000000");
    await expect(page.getByText("We couldn't find that page")).toBeVisible();
  });
});
