import { expect, test } from "@playwright/test";
import { seedContacts, signUpAndCreate } from "./helpers";

const ws = (id: string, path = "") => `/v1/workspaces/${id}${path}`;

// Product decision D260: every contact is one lead. A stage change on a contact without a lead creates the lead; the list and the counts follow.
test("stage change on a contact without a lead creates it, and the list and counts show it", async ({ page }) => {
  test.setTimeout(150_000);
  const { workspaceId } = await signUpAndCreate(page, "Olive Owner", "One Lead Co");
  const [ana, ben] = await seedContacts(page, workspaceId, [{ name: "Ana Costa" }, { name: "Ben Okafor" }]);
  const leads = async () => ((await (await page.request.get(ws(workspaceId, "/leads"))).json()) as { items: { id: string; primaryContact: { id: string }; stageId: string }[] }).items;
  expect(await leads()).toHaveLength(0);

  await page.goto(`/w/${workspaceId}/contacts`);
  const chips = page.getByRole("group", { name: "Filter by stage" });
  await expect(chips.getByRole("button", { name: /^All 2/ })).toBeVisible();
  await expect(chips.getByRole("button", { name: /^New 2/ })).toBeVisible(); // both sit in the first stage, virtually
  await expect(chips.getByRole("button", { name: /^Qualified 0/ })).toBeVisible();

  // quick change, keyboard only: focus the stage button, open it, move down, choose
  const trigger = page.getByRole("button", { name: "Stage of Ana Costa: New. Change stage" });
  await trigger.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("menu")).toBeVisible();
  await page.getByRole("menuitem", { name: "Qualified" }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("status").filter({ hasText: "Ana Costa is now Qualified." }).first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Stage of Ana Costa: Qualified. Change stage" })).toBeVisible();
  await expect(chips.getByRole("button", { name: /^New 1/ })).toBeVisible();
  await expect(chips.getByRole("button", { name: /^Qualified 1/ })).toBeVisible();
  const afterOne = await leads();
  expect(afterOne).toHaveLength(1);
  expect(afterOne[0]!.primaryContact.id).toBe(ana);

  // the stage filter shows exactly what the chip counts
  await chips.getByRole("button", { name: /^New/ }).click();
  await expect(page.getByRole("link", { name: "Ben Okafor" }).first()).toBeVisible();
  await expect(page.getByRole("link", { name: "Ana Costa" })).toHaveCount(0);
  await chips.getByRole("button", { name: /^All/ }).click();
  await expect(page.getByRole("link", { name: "Ana Costa" }).first()).toBeVisible(); // the list reloaded

  // bulk: select both rows, move to Won
  await page.getByLabel("Select all on this page").check();
  await expect(page.getByText("2 selected")).toBeVisible();
  await page.getByRole("button", { name: "Change stage", exact: true }).click();
  const dlg = page.getByRole("dialog");
  await dlg.getByLabel("New stage").selectOption({ label: "Won" });
  await dlg.getByRole("button", { name: "Move 2 contacts" }).click();
  await expect(page.getByRole("status").filter({ hasText: "2 contacts moved to Won." }).first()).toBeVisible();
  await expect(chips.getByRole("button", { name: /^Won 2/ })).toBeVisible();
  expect(await leads()).toHaveLength(2); // Ben's lead was created by the bulk move
  expect(ben).toBeTruthy();

  // old links still work: /leads keeps the stage filter, /leads/<id> opens the contact
  const wonId = (await leads())[0]!.stageId;
  await page.goto(`/w/${workspaceId}/leads?stage=${wonId}`);
  await expect(page).toHaveURL(new RegExp(`/contacts\\?stageId=${wonId}`));
  const lead = (await leads()).find((l) => l.primaryContact.id === ana)!;
  await page.goto(`/w/${workspaceId}/leads/${lead.id}`);
  await expect(page).toHaveURL(new RegExp(`/contacts/${ana}$`));
  await expect(page.getByRole("heading", { level: 1, name: "Ana Costa" })).toBeVisible();
  // the sidebar has no Leads entry
  await expect(page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Leads" })).toHaveCount(0);
});
