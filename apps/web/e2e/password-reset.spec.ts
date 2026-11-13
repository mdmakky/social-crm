import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { FileMailer } from "@crm/core";
import { MAIL_DIR } from "../playwright.config";
import { PASSWORD, register, uniqueEmail } from "./helpers";

const NEW_PASSWORD = "a-brand-new-passphrase";
const mailer = new FileMailer(MAIL_DIR);

async function linkFor(email: string, index = -1): Promise<string> {
  for (let i = 0; i < 60; i++) {
    const mails = await mailer.messagesFor(email);
    const mail = index >= 0 ? mails[index] : mails.at(-1);
    if (mail) return mail.text.match(/https?:\/\/\S+/)![0];
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`no mail for ${email}`);
}
async function requestReset(page: Page, email: string) {
  await page.goto("/forgot-password");
  await page.getByLabel("Email").fill(email);
  await page.getByRole("button", { name: "Send reset link" }).click();
  await expect(page.getByRole("heading", { name: "Check your email" })).toBeVisible();
}
const axe = async (page: Page, label: string) => {
  const r = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
  expect(r.violations.map((v) => `${label}: ${v.id} ${JSON.stringify(v.nodes[0]?.target)}`)).toEqual([]);
};

test.describe("password reset", () => {
  test("full flow: request, emailed link, new password, old password and old sessions stop working", async ({ page, browser }) => {
    const email = await register(page, "Reset Person");
    // a second signed-in device
    const other = await browser.newContext();
    const otherPage = await other.newPage();
    await otherPage.goto("/login");
    await otherPage.getByLabel("Email").fill(email);
    await otherPage.getByLabel("Password").fill(PASSWORD);
    await otherPage.getByRole("button", { name: "Sign in" }).click();
    await otherPage.waitForURL(/onboarding|\/w\//);

    await signOutFromOnboarding(page);
    await page.goto("/login");
    await page.getByRole("link", { name: "Forgot password?" }).click();
    await expect(page).toHaveURL(/\/forgot-password$/);
    await page.getByLabel("Email").fill(email);
    await page.getByRole("button", { name: "Send reset link" }).click();
    await expect(page.getByRole("heading", { name: "Check your email" })).toBeVisible();
    await expect(page.getByText("works for 30 minutes and only once")).toBeVisible();

    const link = await linkFor(email);
    await page.goto(link);
    await expect(page).toHaveURL(/\/reset-password\?token=/);
    await expect(page.getByRole("heading", { name: "Choose a new password" })).toBeVisible();

    await page.getByLabel("New password", { exact: true }).fill("short");
    await page.getByRole("button", { name: "Update password" }).click();
    await expect(page.getByText("Use at least 10 characters.")).toBeVisible();
    await expect(page.getByLabel("New password", { exact: true })).toBeFocused();
    await page.getByLabel("New password", { exact: true }).fill(NEW_PASSWORD);
    await page.getByLabel("Confirm new password").fill("something-different-1");
    await page.getByRole("button", { name: "Update password" }).click();
    await expect(page.getByText("The passwords don't match.")).toBeVisible();
    await page.getByLabel("Confirm new password").fill(NEW_PASSWORD);
    await page.getByRole("button", { name: "Update password" }).click();

    await expect(page).toHaveURL(/\/login\?reset=1$/);
    await expect(page.getByText("Password updated. Sign in with your new password.")).toBeVisible();
    await axe(page, "login-with-notice");

    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Password").fill(PASSWORD);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.getByText("Email or password is incorrect.")).toBeVisible();
    await page.getByLabel("Password").fill(NEW_PASSWORD);
    await page.getByRole("button", { name: "Sign in" }).click();
    await page.waitForURL(/onboarding|\/w\//);

    // the other device's session was revoked
    await otherPage.goto("/");
    await expect(otherPage).toHaveURL(/\/login/);
    await other.close();
  });

  test("an unknown address gets the same confirmation and no email is sent", async ({ page }) => {
    const unknown = uniqueEmail("nobody");
    await requestReset(page, unknown);
    await expect(page.getByText(`If an account exists for ${unknown}`)).toBeVisible();
    await new Promise((r) => setTimeout(r, 500));
    expect(await mailer.messagesFor(unknown)).toHaveLength(0);
    await axe(page, "forgot-sent");
  });

  test("a link works once; reusing it explains what to do", async ({ page }) => {
    const email = await register(page, "Once Only");
    await signOutFromOnboarding(page);
    await requestReset(page, email);
    const link = await linkFor(email);
    await page.goto(link);
    await page.getByLabel("New password", { exact: true }).fill(NEW_PASSWORD);
    await page.getByLabel("Confirm new password").fill(NEW_PASSWORD);
    await page.getByRole("button", { name: "Update password" }).click();
    await expect(page).toHaveURL(/\/login\?reset=1$/);

    await page.goto(link);
    await expect(page.getByRole("heading", { name: "This link can’t be used" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Request a new link" })).toBeVisible();
    await axe(page, "reset-invalid-link");
  });

  test("a newer link replaces the older one", async ({ page }) => {
    const email = await register(page, "Two Links");
    await signOutFromOnboarding(page);
    await requestReset(page, email);
    const first = await linkFor(email, 0);
    await requestReset(page, email);
    const second = await linkFor(email, 1);
    await page.goto(first);
    await expect(page.getByRole("heading", { name: "This link can’t be used" })).toBeVisible();
    await page.goto(second);
    await expect(page.getByRole("heading", { name: "Choose a new password" })).toBeVisible();
    await axe(page, "reset-form");
  });

  test("the emailed-link endpoint cannot be abused as an open redirect", async ({ request }) => {
    const res = await request.get("/api/auth/reset-password/whatever?callbackURL=https%3A%2F%2Fevil.example", { maxRedirects: 0 });
    expect(res.status()).toBe(400);
    expect(res.headers()["location"]).toBeUndefined();
  });

  test("forgot-password validates the address and passes axe", async ({ page }) => {
    await page.goto("/forgot-password");
    await page.getByRole("button", { name: "Send reset link" }).click();
    await expect(page.getByText("Enter a valid email address.")).toBeVisible();
    await expect(page.getByLabel("Email")).toBeFocused();
    await axe(page, "forgot-form");
  });
});

async function signOutFromOnboarding(page: Page) {
  await page.getByRole("button", { name: "Sign out" }).click();
  await page.waitForURL("**/login");
}
