import { expect, test } from "@playwright/test";
import { api, seedContacts, signUpAndCreate } from "./helpers";

test("command menu finds a lead by title and opens it", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const { workspaceId } = await signUpAndCreate(page, "Lena Search", "Lead Search Co");
  const [contactId] = await seedContacts(page, workspaceId, [{ name: "Ana Costa", email: "ana.lead@example.com" }]);
  const r = await api(page).post(`/v1/workspaces/${workspaceId}/leads`, { title: "Quokka Expansion", primaryContactId: contactId, valueMinor: 424242, currency: "USD" });
  expect(r.status()).toBe(201);
  const lead = (await r.json()) as { id: string };
  await page.goto(`/w/${workspaceId}/contacts`);
  await page.keyboard.press("Control+k");
  const dialog = page.getByRole("dialog", { name: "Command menu" });
  await dialog.getByRole("combobox").fill("quokka");
  const opt = dialog.getByRole("option", { name: /Quokka Expansion/ });
  await expect(opt).toBeVisible();
  await expect(dialog.getByText("Leads", { exact: true })).toBeVisible();
  await expect(dialog).not.toContainText("424242");
  await opt.click();
  await expect(page).toHaveURL(new RegExp(`/w/${workspaceId}/leads/${lead.id}$`));
});
