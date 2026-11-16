import { expect, test, type Page } from "@playwright/test";
import { addMemberByEmail, api, register, signUpAndCreate } from "./helpers";
import { axe } from "./channel-helpers";

/** Ad measurement consent UI on the contact page (CAPI slice 1 is mock only; this proves our UI and permissions, not Meta). */
test("grant, withdraw, history; viewer is read-only (UI and API)", async ({ page, browser }) => {
  const { workspaceId } = await signUpAndCreate(page, "Olive Owner", "Consent Co");
  const made = await api(page).post(`/v1/workspaces/${workspaceId}/contacts`, { name: "Cora Consent", email: `cora-${Date.now()}@example.com` });
  expect(made.status()).toBe(201);
  const contactId = (await made.json()).id as string;
  const url = `/w/${workspaceId}/contacts/${contactId}`;
  const panelOf = (p: Page) => p.locator("[data-panel]").filter({ has: p.getByRole("heading", { name: "Ad measurement consent" }) });
  const panel = panelOf(page);
  const history = panel.getByRole("region", { name: "Consent history" }).getByRole("listitem");

  await page.goto(url);
  await expect(panel.getByText("No consent recorded")).toBeVisible();
  await expect(panel.getByRole("button", { name: "Record withdrawal" })).toHaveCount(0);

  // Cancel records nothing.
  await panel.getByRole("button", { name: "Record consent" }).click();
  const dlg = page.getByRole("dialog", { name: "Record ad measurement consent?" });
  await expect(dlg).toContainText("hashed identifiers");
  await expect(dlg).toContainText("Meta");
  await dlg.getByRole("button", { name: "Cancel" }).click();
  await expect(panel.getByText("No consent recorded")).toBeVisible();

  // Grant.
  await panel.getByRole("button", { name: "Record consent" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Confirm consent" }).click();
  await expect(panel.getByText(/by Olive Owner/).first()).toBeVisible();
  await expect(history).toHaveCount(1);

  // Withdraw.
  await panel.getByRole("button", { name: "Record withdrawal" }).click();
  await page.getByRole("dialog", { name: "Record withdrawal of consent?" }).getByRole("button", { name: "Confirm withdrawal" }).click();
  await expect(history).toHaveCount(2);
  await expect(history.first()).toContainText("Withdrawn");
  await expect(panel.getByRole("button", { name: "Record consent" })).toBeVisible();
  await page.reload();
  await expect(history).toHaveCount(2);

  for (const w of [375, 768, 1440]) {
    await page.setViewportSize({ width: w, height: 900 });
    await expect(panel.getByRole("heading", { name: "Ad measurement consent" })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  }
  await axe(page, "contact consent panel");

  // Viewer: read-only explanation, no controls, API refuses.
  const ctx = await browser.newContext();
  const vp = await ctx.newPage();
  const email = await register(vp, "Vic Viewer");
  await addMemberByEmail(workspaceId, email, "viewer");
  await vp.goto(url);
  const vpanel = panelOf(vp);
  await expect(vpanel.getByText(/do not have permission/)).toBeVisible();
  await expect(vpanel.getByRole("button")).toHaveCount(0);
  expect((await api(vp).get(`/v1/workspaces/${workspaceId}/contacts/${contactId}/ad-consent`)).status()).toBe(403);
  expect((await api(vp).post(`/v1/workspaces/${workspaceId}/contacts/${contactId}/ad-consent`, { status: "granted", source: "manual" })).status()).toBe(403);
  await ctx.close();
});
