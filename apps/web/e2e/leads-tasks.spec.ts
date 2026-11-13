import { expect, test } from "@playwright/test";
import { api, seedContacts, signUpAndCreate } from "./helpers";

test("add a task from a lead, see next activity, complete it to clear it, unlink another", async ({ page }) => {
  test.setTimeout(120_000);
  const { workspaceId } = await signUpAndCreate(page, "Tess Tasker", "Lead Tasks Co");
  const [contactId] = await seedContacts(page, workspaceId, [{ name: "Contact Zed" }]);
  const r = await api(page).post(`/v1/workspaces/${workspaceId}/leads`, { title: "Zed deal", primaryContactId: contactId });
  expect(r.status()).toBe(201);
  const lead = await r.json();

  await page.goto(`/w/${workspaceId}/leads/${lead.id}`);
  const next = page.locator("dt", { hasText: "Next activity" }).locator("xpath=following-sibling::dd");
  await expect(next).toContainText("None scheduled");
  await expect(page.getByText("No tasks yet.")).toBeVisible();

  await page.getByRole("button", { name: "Add task" }).click();
  const dlg = page.getByRole("dialog");
  await dlg.getByLabel("Title").fill("Call Zed");
  await dlg.getByLabel("Due").fill("2031-03-02T10:00");
  await dlg.getByRole("button", { name: "Create task" }).click();
  const list = page.getByRole("list", { name: "Linked tasks" });
  await expect(list).toContainText("Call Zed");
  await expect(list).toContainText("Open");
  await expect(next).not.toContainText("None scheduled");
  await expect(next).toContainText("Mar 2");
  await page.reload();
  await expect(next).toContainText("Mar 2");

  // a second task with an earlier date moves next activity; unlinking it moves it back
  await page.getByRole("button", { name: "Add task" }).click();
  await page.getByRole("dialog").getByLabel("Title").fill("Email Zed");
  await page.getByRole("dialog").getByLabel("Due").fill("2030-01-05T09:00");
  await page.getByRole("dialog").getByRole("button", { name: "Create task" }).click();
  await expect(next).toContainText("Jan 5");
  await list.getByRole("listitem").filter({ hasText: "Email Zed" }).getByRole("button", { name: "Unlink" }).click();
  await expect(list).not.toContainText("Email Zed");
  await expect(next).toContainText("Mar 2");

  await list.getByRole("listitem").filter({ hasText: "Call Zed" }).getByRole("button", { name: "Mark done" }).click();
  await expect(next).toContainText("None scheduled");
  await expect(list).toContainText("Done");
});
