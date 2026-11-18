import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { seedContacts, signUpAndCreate } from "./helpers";

const stagesPanel = (page: Page) => page.getByRole("heading", { name: "Lifecycle stages" }).locator("xpath=ancestor::div[contains(@class,'rounded-card')][1]");
const err500 = { status: 500, contentType: "application/json", body: "{}" };

test.describe("contact settings confirmations", () => {
  test("archiving a stage that has contacts asks first (F17)", async ({ page }) => {
    const { workspaceId } = await signUpAndCreate(page, "Arch Owner", "Arch Co");
    await seedContacts(page, workspaceId, [{ name: "In Stage" }]);
    await page.goto(`/w/${workspaceId}/settings/contacts`);
    const stages = stagesPanel(page);
    const row = stages.getByRole("listitem").filter({ hasText: "1 lead" });
    await row.getByRole("button", { name: "Archive" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toContainText(/cannot be newly assigned/);
    for (const width of [375, 768, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      const r = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
      expect(r.violations.map((v) => `${width}: ${v.id}`)).toEqual([]);
    }
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(stages.getByText("Archived")).toHaveCount(0);
    await row.getByRole("button", { name: "Archive" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Archive stage" }).click();
    await expect(stages.getByText("Archived")).toBeVisible();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    // a stage without contacts still archives directly
    await stages.getByRole("listitem").filter({ hasText: "Inactive" }).getByRole("button", { name: "Archive" }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(stages.getByText("Archived")).toHaveCount(2);
  });

  test("a failing archive keeps the dialog open with the error", async ({ page }) => {
    const { workspaceId } = await signUpAndCreate(page, "ArchErr Owner", "ArchErr Co");
    await seedContacts(page, workspaceId, [{ name: "In Stage" }]);
    await page.goto(`/w/${workspaceId}/settings/contacts`);
    await page.route("**/lifecycle-stages/*", (r) => r.fulfill(err500));
    await stagesPanel(page).getByRole("listitem").filter({ hasText: "1 lead" }).getByRole("button", { name: "Archive" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Archive stage" }).click();
    await expect(page.getByRole("dialog").getByRole("alert")).toContainText("Something went wrong");
  });

  test("cancelling the tag delete dialog keeps the tag; a failure shows inline (F8)", async ({ page }) => {
    const { workspaceId } = await signUpAndCreate(page, "TagDel Owner", "TagDel Co");
    const [id] = await seedContacts(page, workspaceId, [{ name: "Tagged" }]);
    await page.goto(`/w/${workspaceId}/contacts/${id}`);
    await page.getByLabel("Add a tag").fill("keepme");
    await page.getByRole("button", { name: "Add", exact: true }).click();
    await expect(page.getByRole("list", { name: "Tags on this lead" }).getByText("keepme")).toBeVisible();
    await page.goto(`/w/${workspaceId}/settings/contacts`);
    page.on("dialog", () => { throw new Error("native dialog used"); });
    await page.getByRole("button", { name: "Delete tag keepme" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Cancel" }).click();
    await expect(page.getByText("keepme")).toBeVisible();
    await page.route("**/tags/*", (r) => (r.request().method() === "DELETE" ? r.fulfill(err500) : r.continue()));
    await page.getByRole("button", { name: "Delete tag keepme" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Delete tag" }).click();
    await expect(page.getByRole("dialog").getByRole("alert")).toContainText("Something went wrong");
    await expect(page.getByText("keepme").first()).toBeVisible();
  });
});
