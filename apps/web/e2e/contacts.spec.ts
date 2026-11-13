import { expect, test, type Browser, type Page } from "@playwright/test";
import { addMemberByEmail, CONTACT_NAMES, register, seedContacts, signUpAndCreate } from "./helpers";

async function withRoles(browser: Browser, page: Page, workspaceId: string) {
  const make = async (name: string, role: string) => {
    const ctx = await browser.newContext();
    const p = await ctx.newPage();
    const email = await register(p, name);
    await addMemberByEmail(workspaceId, email, role);
    await p.goto(`/w/${workspaceId}/contacts`);
    return p;
  };
  return { admin: await make("Dana Admin", "admin"), agent: await make("Sam Agent", "agent"), viewer: await make("Vic Viewer", "viewer"), owner: page };
}

test.describe("contacts list", () => {
  test("empty workspace offers the next steps; adding a contact lands on its detail page", async ({ page }) => {
    const { workspaceId } = await signUpAndCreate(page, "Olive Owner", "Empty Contacts Co");
    await page.getByRole("link", { name: "Contacts" }).first().click();
    await expect(page.getByRole("heading", { name: "No contacts yet" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Import a CSV" })).toBeVisible();
    await page.getByRole("button", { name: "Add contact" }).first().click();
    const dialog = page.getByRole("dialog", { name: "Add contact" });
    await dialog.getByRole("button", { name: "Add contact" }).click();
    await expect(dialog.getByText("Enter a name.")).toBeVisible();
    await dialog.getByLabel("Name").fill("Priya Nair");
    await dialog.getByLabel("Email").fill("priya@example.com");
    await dialog.getByLabel("Phone").fill("+91 98765 43210");
    await dialog.getByRole("button", { name: "Add contact" }).click();
    await expect(page).toHaveURL(new RegExp(`/w/${workspaceId}/contacts/[0-9a-f-]{36}$`));
    await expect(page.getByRole("heading", { name: "Priya Nair", level: 1 })).toBeVisible();
    await expect(page.getByText("Olive Owner created this contact")).toBeVisible();
  });

  test("a duplicate email is flagged with a link to the existing contact, and can still be created deliberately", async ({ page }) => {
    const { workspaceId } = await signUpAndCreate(page, "Dupe Owner", "Dupes Co");
    await seedContacts(page, workspaceId, [{ name: "Alice Anders", email: "alice@dupe.example" }]);
    await page.goto(`/w/${workspaceId}/contacts`);
    await page.getByRole("button", { name: "Add contact" }).first().click();
    const dialog = page.getByRole("dialog", { name: "Add contact" });
    await dialog.getByLabel("Name").fill("Alice Again");
    await dialog.getByLabel("Email").fill("ALICE@dupe.example");
    await dialog.getByRole("button", { name: "Add contact" }).click();
    await expect(dialog.getByText("This looks like a contact you already have.")).toBeVisible();
    await expect(dialog.getByRole("link", { name: "Alice Anders" })).toBeVisible();
    await dialog.getByRole("button", { name: "Create anyway" }).click();
    await expect(page.getByRole("heading", { name: "Alice Again", level: 1 })).toBeVisible();
  });

  test("search, filters, sorting, pagination and the URL all work together", async ({ page }) => {
    const { workspaceId } = await signUpAndCreate(page, "List Owner", "Big List Co");
    await seedContacts(page, workspaceId, Array.from({ length: 40 }, (_, i) => ({ name: `${CONTACT_NAMES[i % 10]} ${Math.floor(i / 10)}`, email: `p${i}@list.example`, company: i % 2 ? "Umbrella" : "Globex" })));
    await page.goto(`/w/${workspaceId}/contacts`);
    await expect(page.getByText("Showing 25 of 40")).toBeVisible();
    await page.getByRole("button", { name: "Load more" }).click();
    await expect(page.getByText("Showing 40 of 40")).toBeVisible();

    await page.getByLabel("Search contacts").fill("okafor");
    await expect(page.getByText("4 contacts match your filters")).toBeVisible();
    await expect(page).toHaveURL(/search=okafor/);
    await page.reload();
    await expect(page.getByLabel("Search contacts")).toHaveValue("okafor");
    await expect(page.getByText("4 contacts match your filters")).toBeVisible();

    await page.getByLabel("Search contacts").fill("no-such-person");
    await expect(page.getByRole("heading", { name: "No contacts match these filters" })).toBeVisible();
    await page.getByRole("button", { name: "Clear filters" }).click();
    await expect(page.getByText("Showing 25 of 40")).toBeVisible();

    await page.getByLabel("Lifecycle stage").selectOption({ label: "Qualified" });
    await expect(page.getByRole("heading", { name: "No contacts match these filters" })).toBeVisible(); // nobody is in Qualified
    await page.getByRole("button", { name: "Clear", exact: true }).click();

    const nameHeader = page.getByRole("columnheader", { name: /Contact/ });
    await nameHeader.getByRole("button").click();
    await expect(nameHeader).toHaveAttribute("aria-sort", "ascending");
    await expect(page.getByRole("row").nth(1)).toContainText("Ana Costa 0");
    await nameHeader.getByRole("button").click();
    await expect(nameHeader).toHaveAttribute("aria-sort", "descending");
    await expect(page.getByRole("row").nth(1)).toContainText("Jia Li 3");
  });

  test("columns can be hidden and reordered, and the layout is remembered", async ({ page }) => {
    const { workspaceId } = await signUpAndCreate(page, "Cols Owner", "Columns Co");
    await seedContacts(page, workspaceId, [{ name: "Col Person", email: "col@x.example" }]);
    await page.goto(`/w/${workspaceId}/contacts`);
    await expect(page.getByRole("columnheader")).toHaveText(["Contact", "Lifecycle stage", "Owner", "Tags", "Source", "Last activity", "Created"]);
    await page.getByRole("button", { name: "Columns", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Columns" });
    await dialog.getByRole("listitem").filter({ hasText: "Source" }).getByRole("button", { name: "Hide" }).click();
    await dialog.getByRole("button", { name: "Move Created up" }).click();
    await dialog.getByRole("button", { name: "Done" }).click();
    await expect(page.getByRole("columnheader")).toHaveText(["Contact", "Lifecycle stage", "Owner", "Tags", "Created", "Last activity"]);
    await page.reload();
    await expect(page.getByRole("columnheader")).toHaveText(["Contact", "Lifecycle stage", "Owner", "Tags", "Created", "Last activity"]);
    await page.getByRole("button", { name: "Columns", exact: true }).click();
    await page.getByRole("dialog", { name: "Columns" }).getByRole("button", { name: "Reset to default" }).click();
    await page.getByRole("dialog", { name: "Columns" }).getByRole("button", { name: "Done" }).click();
    await expect(page.getByRole("columnheader")).toHaveCount(7);
  });

  test("saved views store filters and columns, can be applied and deleted", async ({ page }) => {
    const { workspaceId } = await signUpAndCreate(page, "View Owner", "Views Co");
    await seedContacts(page, workspaceId, [{ name: "Ana Costa", email: "ana@v.example" }, { name: "Ben Okafor", email: "ben@v.example" }]);
    await page.goto(`/w/${workspaceId}/contacts`);
    await page.getByLabel("Search contacts").fill("ben");
    await expect(page.getByText("1 contact match your filters")).toBeVisible();
    await page.getByRole("button", { name: "Views", exact: true }).click();
    await page.getByRole("menuitem", { name: /Save current view/ }).click();
    const dialog = page.getByRole("dialog", { name: "Save view" });
    await dialog.getByRole("button", { name: "Save view" }).click();
    await expect(dialog.getByText("Give the view a name.")).toBeVisible();
    await dialog.getByLabel("View name").fill("Just Ben");
    await dialog.getByLabel("Share with everyone in this workspace").check();
    await dialog.getByRole("button", { name: "Save view" }).click();
    await expect(page.getByRole("button", { name: "Just Ben" })).toBeVisible();

    await page.getByRole("button", { name: "Clear", exact: true }).click();
    await expect(page.getByText("2 contacts")).toBeVisible();
    await expect(page.getByRole("button", { name: "Views", exact: true })).toBeVisible(); // changing filters leaves the saved view
    await page.getByRole("button", { name: "Views", exact: true }).click();
    await page.getByRole("menuitem", { name: /Just Ben/ }).click();
    await expect(page.getByRole("button", { name: "Just Ben" })).toBeVisible();
    await expect(page.getByLabel("Search contacts")).toHaveValue("ben");
    await expect(page.getByText("1 contact match your filters")).toBeVisible();

    await page.getByRole("button", { name: "Just Ben" }).click();
    await page.getByRole("menuitem", { name: /Delete “Just Ben”/ }).click();
    await page.getByRole("button", { name: "Views", exact: true }).click();
    await expect(page.getByText("No saved views yet.")).toBeVisible();
  });
});

test.describe("permissions in the UI", () => {
  test("each role sees only the contact actions it may use", async ({ page, browser }) => {
    const { workspaceId } = await signUpAndCreate(page, "Perm Owner", "Contact Perms Co");
    const [id] = await seedContacts(page, workspaceId, [{ name: "Perm Person", email: "perm@x.example" }]);
    const r = await withRoles(browser, page, workspaceId);
    await page.goto(`/w/${workspaceId}/contacts`);
    for (const p of [r.owner, r.admin]) {
      await expect(p.getByRole("link", { name: "Import" })).toBeVisible();
      await expect(p.getByRole("link", { name: "Export" })).toBeVisible();
      await expect(p.getByRole("button", { name: "Add contact" }).first()).toBeVisible();
    }
    await expect(r.agent.getByRole("button", { name: "Add contact" }).first()).toBeVisible();
    await expect(r.agent.getByRole("link", { name: "Import" })).toHaveCount(0);
    await expect(r.agent.getByRole("link", { name: "Export" })).toHaveCount(0);
    for (const k of ["Add contact", "Import", "Export"]) await expect(r.viewer.getByRole(k === "Add contact" ? "button" : "link", { name: k })).toHaveCount(0);

    await r.viewer.goto(`/w/${workspaceId}/contacts/${id}`);
    await expect(r.viewer.getByLabel("Name")).toBeDisabled();
    await expect(r.viewer.getByRole("button", { name: "Save changes" })).toHaveCount(0);
    await expect(r.viewer.getByLabel("Add a note")).toHaveCount(0);
    await expect(r.viewer.getByRole("button", { name: "More actions" })).toHaveCount(0);
    await r.agent.goto(`/w/${workspaceId}/contacts/${id}`);
    await expect(r.agent.getByLabel("Name")).toBeEnabled();
    await expect(r.agent.getByRole("button", { name: "More actions" })).toHaveCount(0); // agents cannot delete
    await r.agent.goto(`/w/${workspaceId}/contacts/import`);
    await expect(r.agent.getByRole("heading", { name: "Only owners and admins can import contacts" })).toBeVisible();
    await r.agent.goto(`/w/${workspaceId}/settings/contacts`);
    await expect(r.agent.getByText("Only owners and admins can change these settings.")).toBeVisible();
    await expect(r.agent.getByRole("button", { name: "Add stage" })).toHaveCount(0);
  });
});
