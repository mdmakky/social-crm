import { expect, test } from "@playwright/test";
import { api, seedContacts, signUpAndCreate } from "./helpers";

test.describe("contact detail", () => {
  test("edits save with a version, record activity, and a concurrent edit is detected", async ({ page }) => {
    const { workspaceId } = await signUpAndCreate(page, "Edit Owner", "Edit Co");
    const [id] = await seedContacts(page, workspaceId, [{ name: "Gus Hall", email: "gus@edit.example", company: "Hall & Co" }]);
    await page.goto(`/w/${workspaceId}/contacts/${id}`);
    const save = page.getByRole("button", { name: "Save changes" });
    await expect(save).toBeDisabled();
    await page.getByLabel("Company").fill("Hall Industries");
    await page.getByLabel("Lifecycle stage").selectOption({ label: "Engaged" });
    await save.click();
    await expect(page.getByText("Saved.")).toBeVisible();
    await expect(page.getByText("Edit Owner moved the lifecycle stage from New to Engaged")).toBeVisible();
    await expect(page.getByText("Edit Owner updated company")).toBeVisible();

    // someone else edits in the meantime
    const current = await (await api(page).get(`/v1/workspaces/${workspaceId}/contacts/${id}`)).json();
    await api(page).patch(`/v1/workspaces/${workspaceId}/contacts/${id}`, { expectedVersion: current.version, name: "Gus Hall Jr" });
    await page.getByLabel("Company").fill("Stale Edit Co");
    await save.click();
    await expect(page.getByText("Someone else changed this contact.")).toBeVisible();
    await page.getByRole("button", { name: "Load latest" }).click();
    await expect(page.getByLabel("Name")).toHaveValue("Gus Hall Jr");
    await expect(page.getByLabel("Company")).toHaveValue("Hall Industries");
  });

  test("tags, notes and tasks: add, change and remove", async ({ page }) => {
    const { workspaceId } = await signUpAndCreate(page, "Work Owner", "Work Co");
    const [id] = await seedContacts(page, workspaceId, [{ name: "Hana Sato", email: "hana@work.example" }]);
    await page.goto(`/w/${workspaceId}/contacts/${id}`);

    await page.getByLabel("Add a tag").fill("wholesale");
    await page.getByRole("button", { name: "Add", exact: true }).click();
    await expect(page.getByRole("list", { name: "Tags on this contact" }).getByText("wholesale")).toBeVisible();
    await expect(page.getByText("Work Owner added the tag wholesale")).toBeVisible();
    await page.getByRole("button", { name: "Remove tag wholesale" }).click();
    await expect(page.getByText("No tags yet.")).toBeVisible();

    await page.getByRole("button", { name: "Add note" }).click();
    await expect(page.getByText("Write something first.")).toBeVisible();
    await page.getByLabel("Add a note").fill("Prefers calls after 4pm.");
    await page.getByRole("button", { name: "Add note" }).click();
    await expect(page.getByText("Prefers calls after 4pm.").first()).toBeVisible();
    await page.getByRole("button", { name: "Edit note" }).click();
    await page.getByLabel("Edit note").fill("Prefers calls after 5pm.");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByText("Prefers calls after 5pm.").first()).toBeVisible();
    await page.getByRole("button", { name: "Delete note" }).click();
    await page.getByRole("button", { name: "Confirm delete" }).click();
    await expect(page.getByText("No notes yet.")).toBeVisible();

    await page.getByLabel("New task").fill("Send the quote");
    await page.getByLabel("Due", { exact: true }).fill("2020-01-02T09:00");
    await page.getByRole("button", { name: "Add task" }).click();
    await expect(page.getByText("Send the quote").first()).toBeVisible();
    await expect(page.getByText(/Overdue/)).toBeVisible();
    await page.getByRole("checkbox", { name: "Complete: Send the quote" }).click();
    await expect(page.getByRole("checkbox", { name: "Reopen: Send the quote" })).toBeChecked();
    await expect(page.getByText("Work Owner completed the task \"Send the quote\"")).toBeVisible();
    await page.getByRole("button", { name: "Delete task: Send the quote" }).click();
    await expect(page.getByText("No tasks yet.")).toBeVisible();
  });

  test("related conversations and pipeline records are honest about not being available yet", async ({ page }) => {
    const { workspaceId } = await signUpAndCreate(page, "Related Owner", "Related Co");
    const [id] = await seedContacts(page, workspaceId, [{ name: "Ivan Petrov" }]);
    await page.goto(`/w/${workspaceId}/contacts/${id}`);
    await expect(page.getByRole("heading", { name: "Conversations are not available yet" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Pipeline records are not available yet" })).toBeVisible();
    await expect(page.getByText(/will appear here/)).toHaveCount(0);
    await expect(page.getByText(/separate from any pipeline/)).toBeVisible();
  });

  test("deleting a contact asks first, removes it, and unknown ids are not-found", async ({ page }) => {
    const { workspaceId } = await signUpAndCreate(page, "Del Owner", "Delete Co");
    const [id] = await seedContacts(page, workspaceId, [{ name: "Jia Li", email: "jia@del.example" }]);
    await page.goto(`/w/${workspaceId}/contacts/${id}`);
    await page.getByRole("button", { name: "More actions" }).click();
    await page.getByRole("menuitem", { name: "Delete contact" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Cancel" }).click();
    await expect(page.getByRole("heading", { name: "Jia Li", level: 1 })).toBeVisible();
    await page.getByRole("button", { name: "More actions" }).click();
    await page.getByRole("menuitem", { name: "Delete contact" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Delete contact" }).click();
    await expect(page).toHaveURL(new RegExp(`/w/${workspaceId}/contacts$`));
    await page.goto(`/w/${workspaceId}/contacts/${id}`);
    await expect(page.getByText("We couldn't find that page")).toBeVisible();
  });
});

