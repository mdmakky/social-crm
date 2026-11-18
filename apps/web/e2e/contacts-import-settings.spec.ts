import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { seedContacts, signUpAndCreate } from "./helpers";

const axe = async (page: Page, label: string) => {
  const r = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
  expect(r.violations.map((v) => `${label}: ${v.id} ${JSON.stringify(v.nodes[0]?.target)}`)).toEqual([]);
};
const file = (name: string, csv: string) => ({ name, mimeType: "text/csv", buffer: Buffer.from(csv) });
const HEADER = "Name,Email,Phone,Company,Stage,Owner email,Tags";

test.describe("csv import wizard", () => {
  test("upload, match columns, review problems and duplicates, then import", async ({ page }) => {
    const { workspaceId } = await signUpAndCreate(page, "Import Owner", "Import Co");
    await seedContacts(page, workspaceId, [{ name: "Existing Erin", email: "erin@exist.example", company: "OldCo" }]);
    await page.goto(`/w/${workspaceId}/contacts/import`);
    await expect(page.getByRole("heading", { name: "Choose a CSV file" })).toBeFocused();
    await expect(page.getByRole("link", { name: "Download a template" })).toBeVisible();
    await axe(page, "import-step1");

    const csv = [HEADER, "Mia Import,mia@i.example,+44 20 7946 0958,Initrode,Qualified,,vip; lead", "Noah Import,noah@i.example,,,,,", "Erin Again,ERIN@exist.example,,NewCo,Customer,,", "Broken Row,not-an-email,,,,,", "Bad Stage,bs@i.example,,,Nonexistent,,"].join("\n");
    await page.getByLabel("CSV file").setInputFiles(file("people.csv", csv));
    await expect(page.getByRole("heading", { name: "Match columns" })).toBeFocused();
    await expect(page.getByText("5 rows found.")).toBeVisible();
    await expect(page.getByLabel("Import column Email as")).toHaveValue("email");
    await expect(page.getByLabel("Import column Owner email as")).toHaveValue("owner_email");
    await axe(page, "import-step2");
    // a field can only be used once
    await expect(page.getByLabel("Import column Phone as").getByRole("option", { name: "Email", exact: true })).toBeDisabled();

    await page.getByRole("button", { name: "Check my data" }).click();
    const problems = page.getByRole("alert").filter({ hasText: "2 rows have problems" });
    await expect(problems).toBeFocused(); // F13: with problem rows the error summary takes focus
    await expect(page.getByRole("heading", { name: "Review before importing" })).toBeVisible();
    await expect(problems.getByText(/Row 5:.*not a valid email/)).toBeVisible();
    await expect(problems.getByText(/Row 6:.*Unknown lifecycle stage/)).toBeVisible();
    await expect(page.getByText("1 possible duplicate")).toBeVisible();
    await expect(page.getByRole("link", { name: "Existing Erin" })).toBeVisible();
    const importBtn = page.getByRole("button", { name: /^Import 2 leads$/ });
    await expect(importBtn).toBeDisabled(); // problems must be acknowledged first
    await axe(page, "import-step3");

    await page.getByLabel(/Skip the 2 problem rows/).check();
    await expect(importBtn).toBeEnabled();
    // choose to update the existing contact instead of skipping it
    await page.getByLabel("Update the existing lead").check();
    await expect(page.getByRole("button", { name: /^Import 3 leads$/ })).toBeEnabled();
    await page.getByRole("button", { name: /^Import 3 leads$/ }).click();

    await expect(page.getByRole("heading", { name: "Import complete" })).toBeFocused();
    await expect(page.getByText("2 added · 1 updated · 0 skipped.")).toBeVisible();
    await page.getByRole("link", { name: "View leads" }).click();
    await expect(page.getByText("3 leads")).toBeVisible();
    await page.getByLabel("Search leads").fill("erin@exist");
    await expect(page.getByRole("link", { name: "Erin Again" })).toBeVisible(); // name and company were updated
    await page.getByLabel("Search leads").fill("mia@");
    await page.getByRole("link", { name: "Mia Import" }).click();
    await expect(page.getByText("Import Owner imported this lead from people.csv")).toBeVisible();
    await expect(page.getByRole("list", { name: "Tags on this lead" }).getByText("vip")).toBeVisible();
  });

  test("unusable files are refused with a clear message before anything is read further", async ({ page }) => {
    const { workspaceId } = await signUpAndCreate(page, "Bad File Owner", "Bad File Co");
    await page.goto(`/w/${workspaceId}/contacts/import`);
    await page.getByLabel("CSV file").setInputFiles(file("empty.csv", "Name,Email\n"));
    await expect(page.getByRole("alert").filter({ hasText: "no data rows" })).toBeVisible();
    await page.getByLabel("CSV file").setInputFiles(file("broken.csv", 'Name,Email\n"Ana,ana@x.com'));
    await expect(page.getByRole("alert").filter({ hasText: "CSV format problem" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Choose a CSV file" })).toBeVisible(); // still on step 1, nothing saved
  });

  test("an unmapped file cannot continue, and duplicates inside the file are listed", async ({ page }) => {
    const { workspaceId } = await signUpAndCreate(page, "Map Owner", "Map Co");
    await page.goto(`/w/${workspaceId}/contacts/import`);
    await page.getByLabel("CSV file").setInputFiles(file("odd.csv", "Foo,Bar\nx,y\nx,z"));
    await expect(page.getByRole("button", { name: "Check my data" })).toBeDisabled();
    await expect(page.getByText("Match at least a name, email or phone column to continue.")).toBeVisible();
    await page.getByLabel("Import column Foo as").selectOption({ label: "Email" });
    await page.getByLabel("Import column Bar as").selectOption({ label: "Full name" });
    await page.getByRole("button", { name: "Check my data" }).click();
    await expect(page.getByRole("alert").filter({ hasText: "2 rows have problems" })).toBeVisible(); // "x" is not an email
  });
});

test.describe("contact settings", () => {
  test("lifecycle stages can be renamed, added, reordered, archived and restored", async ({ page }) => {
    const { workspaceId } = await signUpAndCreate(page, "Stage Owner", "Stages Co");
    await page.goto(`/w/${workspaceId}/settings/contacts`);
    await expect(page.getByRole("link", { name: "Leads", exact: true }).filter({ visible: true }).first()).toBeVisible();
    const stages = page.getByRole("heading", { name: "Lifecycle stages" }).locator("xpath=ancestor::div[contains(@class,'rounded-card')][1]");
    await expect(stages.getByRole("listitem")).toHaveCount(5);
    await stages.getByRole("listitem").filter({ hasText: "New" }).getByRole("button", { name: "Rename" }).click();
    await page.getByLabel("Rename New").fill("Fresh");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(stages.getByText("Fresh")).toBeVisible();

    await page.getByLabel("New lifecycle stage").fill("fresh");
    await page.getByRole("button", { name: "Add stage" }).click();
    await expect(page.getByRole("alert").filter({ hasText: "already exists" })).toBeVisible();
    await page.getByLabel("New lifecycle stage").fill("Onboarding");
    await page.getByRole("button", { name: "Add stage" }).click();
    await expect(stages.getByRole("listitem")).toHaveCount(6);

    await page.getByRole("button", { name: "Move Onboarding up" }).click();
    await expect(stages.getByRole("listitem").nth(4)).toContainText("Onboarding");
    await stages.getByRole("listitem").filter({ hasText: "Inactive" }).getByRole("button", { name: "Archive" }).click();
    await expect(stages.getByText("Archived")).toBeVisible();
    await page.reload();
    await expect(stages.getByText("Archived")).toBeVisible();
    await stages.getByRole("listitem").filter({ hasText: "Inactive" }).getByRole("button", { name: "Restore" }).click();
    await expect(stages.getByText("Archived")).toHaveCount(0);
    await axe(page, "contact-settings");
  });

  test("a custom field appears in the new-contact form and on the contact, with validation", async ({ page }) => {
    const { workspaceId } = await signUpAndCreate(page, "Field Owner", "Fields Co");
    await page.goto(`/w/${workspaceId}/settings/contacts`);
    await page.getByLabel("Label").fill("Budget");
    await page.getByLabel("Type").selectOption({ label: "Number" });
    await page.getByRole("button", { name: "Add field" }).click();
    await expect(page.getByText("key budget")).toBeVisible();
    await page.getByLabel("Label").fill("Tier");
    await page.getByLabel("Type").selectOption({ label: "Single choice" });
    await page.getByLabel("Options").fill("gold, silver");
    await page.getByLabel("Required when adding a lead").check();
    await page.getByRole("button", { name: "Add field" }).click();

    await page.goto(`/w/${workspaceId}/contacts`);
    await page.getByRole("button", { name: "Add lead" }).first().click();
    const dialog = page.getByRole("dialog", { name: "Add lead" });
    await dialog.getByLabel("Name").fill("Field Person");
    await dialog.getByRole("button", { name: "Add lead" }).click();
    await expect(dialog.getByText("Tier is required")).toBeVisible();
    await dialog.getByLabel("Tier (required)").selectOption("gold");
    await dialog.getByLabel("Budget").fill("1500");
    await dialog.getByRole("button", { name: "Add lead" }).click();
    await expect(page.getByRole("heading", { name: "Field Person", level: 1 })).toBeVisible();
    await expect(page.getByLabel("Budget")).toHaveValue("1500");
    await expect(page.getByLabel("Tier (required)")).toHaveValue("gold");
  });

  test("tags can be renamed and deleted by an admin; deleting removes them from contacts", async ({ page }) => {
    const { workspaceId } = await signUpAndCreate(page, "Tag Owner", "Tags Co");
    const [id] = await seedContacts(page, workspaceId, [{ name: "Tagged Person" }]);
    await page.goto(`/w/${workspaceId}/contacts/${id}`);
    await page.getByLabel("Add a tag").fill("trial");
    await page.getByRole("button", { name: "Add", exact: true }).click();
    await expect(page.getByRole("list", { name: "Tags on this lead" }).getByText("trial")).toBeVisible();

    await page.goto(`/w/${workspaceId}/settings/contacts`);
    await expect(page.getByText("1 lead").first()).toBeVisible();
    await page.getByRole("button", { name: "Edit", exact: true }).click();
    await page.getByLabel("Rename tag trial").fill("trial-user");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByText("trial-user")).toBeVisible();

    await page.getByRole("button", { name: "Delete tag trial-user" }).click();
    const dialog = page.getByRole("dialog", { name: 'Delete tag "trial-user"?' });
    await expect(dialog).toContainText("removed from 1 lead");
    await dialog.getByRole("button", { name: "Delete tag" }).click();
    await expect(page.getByText("No tags yet.")).toBeVisible();
    await page.goto(`/w/${workspaceId}/contacts/${id}`);
    await expect(page.getByText("No tags yet.")).toBeVisible();
  });
});
