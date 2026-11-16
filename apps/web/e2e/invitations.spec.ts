import { expect, test, type Browser, type Page } from "@playwright/test";
import { addMemberByEmail, PASSWORD, register, signUpAndCreate, uniqueEmail } from "./helpers";

async function invite(page: Page, workspaceId: string, email: string, role?: string) {
  await page.goto(`/w/${workspaceId}/members`);
  await page.getByRole("button", { name: "Invite people" }).click();
  await page.getByRole("textbox", { name: "Email" }).fill(email);
  if (role) await page.getByLabel("Role").selectOption(role);
  await page.getByRole("button", { name: "Create invite" }).click();
  const link = await page.getByTestId("invite-link").inputValue();
  return link;
}
async function guest(browser: Browser) {
  const ctx = await browser.newContext();
  return { ctx, page: await ctx.newPage() };
}

test.describe("member invitations", () => {
  test("owner invites by email, the invitee registers through the link and joins as an agent", async ({ page, browser }) => {
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
    const { workspaceId } = await signUpAndCreate(page, "Olive Owner", "Invite Co");
    const email = uniqueEmail("guest");
    const link = await invite(page, workspaceId, email);

    // result panel: shown once, mailer sent it, Copy puts the same link on the clipboard
    await expect(page.getByText(`Email sent to ${email}.`)).toBeVisible();
    expect(link).toMatch(/\/invite\/[A-Za-z0-9_-]{43}$/);
    await page.getByRole("button", { name: "Copy" }).click();
    await expect(page.getByRole("button", { name: "Copied" })).toBeVisible();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(link);
    await page.getByRole("button", { name: "Done" }).click();
    const row = page.getByRole("listitem").filter({ hasText: email });
    await expect(row).toContainText("Pending");
    await expect(row).toContainText("Agent");

    // the invitee opens the public page, creates an account and lands back on the invitation
    const g = await guest(browser);
    await g.page.goto(link);
    await expect(g.page.getByRole("heading", { name: "Join Invite Co" })).toBeVisible();
    await expect(g.page.getByText("Olive Owner invited you as agent.")).toBeVisible();
    await expect(g.page.getByText(email)).toHaveCount(0); // only a masked address is public
    await g.page.getByRole("link", { name: "Create account" }).click();
    await g.page.getByLabel("Full name").fill("Gus Guest");
    await g.page.getByRole("textbox", { name: "Email" }).fill(email);
    await g.page.getByLabel("Password").fill(PASSWORD);
    await g.page.getByRole("button", { name: "Create account" }).click();
    await g.page.waitForURL(/\/invite\//);
    await g.page.getByRole("button", { name: "Join Invite Co" }).click();
    await g.page.waitForURL(`**/w/${workspaceId}`);

    // joined as an agent: agent pages yes, owner/admin surfaces no
    const nav = g.page.getByRole("navigation", { name: "Main" }).first();
    await expect(nav.getByRole("link", { name: "Inbox" })).toBeVisible();
    await expect(nav.getByRole("link", { name: "Audit log" })).toHaveCount(0);
    await g.page.goto(`/w/${workspaceId}/members`);
    await expect(g.page.getByRole("row", { name: /Gus Guest/ })).toContainText("Agent");
    await expect(g.page.getByRole("button", { name: "Invite people" })).toHaveCount(0);
    await expect(g.page.getByRole("heading", { name: "Invitations" })).toHaveCount(0);
    await g.page.goto(`/w/${workspaceId}/audit-log`);
    await expect(g.page.getByText("Only owners and admins can view the audit log")).toBeVisible();

    // the used link is dead; the owner sees the invitation as joined
    const again = await guest(browser);
    await again.page.goto(link);
    await expect(again.page.getByRole("heading", { name: "Link not valid" })).toBeVisible();
    await page.goto(`/w/${workspaceId}/members`);
    await expect(page.getByRole("listitem").filter({ hasText: email })).toContainText("Joined");
    await g.ctx.close();
    await again.ctx.close();
  });

  test("a user with another email is refused and can sign out", async ({ page, browser }) => {
    const { workspaceId } = await signUpAndCreate(page, "Olive Owner", "Mismatch Co");
    const link = await invite(page, workspaceId, uniqueEmail("guest"), "viewer");
    const w = await guest(browser);
    await register(w.page, "Ivan Intruder", uniqueEmail("intruder"));
    await w.page.goto(link);
    await expect(w.page.getByText(/This invitation was sent to another email\./).first()).toBeVisible();
    await expect(w.page.getByRole("button", { name: /^Join / })).toHaveCount(0);
    await w.page.getByRole("button", { name: "Sign out" }).click();
    await expect(w.page.getByRole("link", { name: "Sign in" })).toBeVisible();
    await w.ctx.close();
  });

  test("a revoked link stops working", async ({ page, browser }) => {
    const { workspaceId } = await signUpAndCreate(page, "Olive Owner", "Revoke Co");
    const email = uniqueEmail("guest");
    const link = await invite(page, workspaceId, email);
    await page.getByRole("button", { name: "Done" }).click();
    await page.getByRole("button", { name: `Revoke invitation to ${email}` }).click();
    await expect(page.getByRole("listitem").filter({ hasText: email })).toContainText("Revoked");
    const g = await guest(browser);
    await g.page.goto(link);
    await expect(g.page.getByRole("heading", { name: "Link not valid" })).toBeVisible();
    await g.ctx.close();
  });

  test("a viewer has no invite controls; a second invite to the same email is refused", async ({ page, browser }) => {
    const { workspaceId } = await signUpAndCreate(page, "Olive Owner", "Viewer Co");
    const v = await guest(browser);
    const viewerEmail = await register(v.page, "Vic Viewer");
    await addMemberByEmail(workspaceId, viewerEmail, "viewer");
    await v.page.goto(`/w/${workspaceId}/members`);
    await expect(v.page.getByRole("heading", { name: "Members", level: 1 })).toBeVisible();
    await expect(v.page.getByRole("button", { name: "Invite people" })).toHaveCount(0);
    await v.ctx.close();

    const email = uniqueEmail("dup");
    await invite(page, workspaceId, email);
    await page.getByRole("button", { name: "Done" }).click();
    await page.getByRole("button", { name: "Invite people" }).click();
    await page.getByRole("textbox", { name: "Email" }).fill(email);
    await page.getByRole("button", { name: "Create invite" }).click();
    await expect(page.getByRole("alert").filter({ hasText: "already pending" })).toBeVisible();
    await page.getByRole("button", { name: "Cancel" }).click();
    // resend gives a fresh one-time link
    await page.getByRole("button", { name: `Resend invitation to ${email}` }).click();
    await expect(page.getByTestId("invite-link")).toHaveValue(/\/invite\//);
  });
});
