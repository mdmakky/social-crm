import { expect, test } from "@playwright/test";
import { CONTACT_NAMES, seedContacts, signUpAndCreate } from "./helpers";

const people = (n: number) => Array.from({ length: n }, (_, i) => ({ name: `${CONTACT_NAMES[i % 10]} ${Math.floor(i / 10)}`, email: `s${i}@states.example` }));

test.describe("contacts list: failure states (WP-A)", () => {
  test("F1: a 401 on search sends the user to sign in and back", async ({ page }) => {
    const { workspaceId } = await signUpAndCreate(page, "Session Owner", "Session Co");
    await seedContacts(page, workspaceId, people(3));
    await page.goto(`/w/${workspaceId}/contacts`);
    await expect(page.getByText("Showing 3 of 3")).toBeVisible();
    await page.context().clearCookies();
    await page.getByLabel("Search contacts").fill("ana");
    await expect(page).toHaveURL(/\/login\?next=%2Fw%2F.+%2Fcontacts/);
  });

  test("F1: a failed search keeps the old rows but labels them as previous results, with Retry", async ({ page }) => {
    const { workspaceId } = await signUpAndCreate(page, "Stale Owner", "Stale Co");
    await seedContacts(page, workspaceId, people(3));
    await page.goto(`/w/${workspaceId}/contacts`);
    await expect(page.getByText("Showing 3 of 3")).toBeVisible();
    let fail = true;
    await page.route("**/contacts?*search=*", (r) => (fail ? r.fulfill({ status: 500, json: { error: { code: "internal", message: "boom" } } }) : r.continue()));
    await page.getByLabel("Search contacts").fill("ana");
    await expect(page.getByText("Showing previous results", { exact: true })).toBeVisible();
    await expect(page.getByText(/Showing previous results; the last search failed/)).toBeVisible();
    await expect(page.getByText(/match your filters/)).toHaveCount(0);
    fail = false;
    await page.getByRole("button", { name: "Retry" }).click();
    await expect(page.getByText(/match your filters/)).toBeVisible();
    await expect(page.getByText(/last search failed/)).toHaveCount(0);
  });

  test("F2: export downloads contacts.csv with a header row", async ({ page }) => {
    const { workspaceId } = await signUpAndCreate(page, "Export Owner", "Export Co");
    await seedContacts(page, workspaceId, people(2));
    await page.goto(`/w/${workspaceId}/contacts`);
    const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Export", exact: true }).click()]);
    expect(download.suggestedFilename()).toBe("contacts.csv");
    const text = await (await import("node:fs/promises")).readFile((await download.path())!, "utf8");
    expect(text.startsWith("Name,")).toBe(true);
    expect(text).toContain("Ana Costa 0");
  });

  test("F2: a failed export shows the server message and downloads nothing", async ({ page }) => {
    const { workspaceId } = await signUpAndCreate(page, "Export Fail", "Export Fail Co");
    await seedContacts(page, workspaceId, people(1));
    await page.goto(`/w/${workspaceId}/contacts`);
    await page.route("**/contacts/export*", (r) => r.fulfill({ status: 413, json: { error: { code: "too_many_rows", message: "Export up to 10000 contacts at a time. Narrow the filters." } } }));
    let downloaded = false;
    page.on("download", () => { downloaded = true; });
    await page.getByRole("button", { name: "Export", exact: true }).click();
    await expect(page.getByRole("alert").filter({ hasText: "Narrow the filters" })).toBeVisible();
    await page.waitForTimeout(500);
    expect(downloaded).toBe(false);
  });

  test("F6: changing a filter while Load more is in flight does not mix rows", async ({ page }) => {
    const { workspaceId } = await signUpAndCreate(page, "More Owner", "More Co");
    await seedContacts(page, workspaceId, people(30));
    await page.goto(`/w/${workspaceId}/contacts`);
    await expect(page.getByText("Showing 25 of 30")).toBeVisible();
    await page.route("**/contacts?*cursor=*", async (r) => { await new Promise((res) => setTimeout(res, 800)); await r.continue(); });
    await page.getByRole("button", { name: "Load more" }).click();
    await page.getByLabel("Search contacts").fill("okafor");
    await expect(page.getByText("3 contacts match your filters")).toBeVisible();
    await page.waitForTimeout(1200); // let the delayed page arrive
    await expect(page.getByRole("row")).toHaveCount(4); // header + 3 Okafor rows, nothing appended from the old query
    await expect(page.getByText("Showing 3 of 3")).toBeVisible();
  });

  test("F19: the mobile sort select reflects the URL and offers every supported order", async ({ page }) => {
    const { workspaceId } = await signUpAndCreate(page, "Sort Owner", "Sort Co");
    await seedContacts(page, workspaceId, people(3));
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto(`/w/${workspaceId}/contacts?sort=name&dir=desc`);
    await expect(page.getByLabel("Sort by")).toHaveValue("name:desc");
    await page.getByLabel("Sort by").selectOption("created:asc");
    await expect(page).toHaveURL(/sort=created/);
    await expect(page).toHaveURL(/dir=asc/);
    await expect(page.getByRole("status").filter({ hasText: "Sorted by Oldest" })).toBeVisible();
  });

  test("F23: sorting by a column header is announced", async ({ page }) => {
    const { workspaceId } = await signUpAndCreate(page, "Announce Owner", "Announce Co");
    await seedContacts(page, workspaceId, people(3));
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`/w/${workspaceId}/contacts`);
    await page.getByRole("columnheader", { name: /Contact/ }).getByRole("button").click();
    await expect(page.getByRole("status").filter({ hasText: "Sorted by Name A to Z. Showing 3 of 3" })).toBeVisible();
  });

  test("F11: Move up at the top of the Columns dialog hands focus to the opposite arrow", async ({ page }) => {
    const { workspaceId } = await signUpAndCreate(page, "Focus Owner", "Focus Co");
    await seedContacts(page, workspaceId, people(1));
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`/w/${workspaceId}/contacts`);
    await page.getByRole("button", { name: "Columns", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Columns" });
    await dialog.getByRole("button", { name: "Move Stage up" }).click();
    await expect(dialog.getByRole("status")).toHaveText("Stage, position 1 of 8");
    await expect(dialog.getByRole("button", { name: "Move Stage down" })).toBeFocused();
  });
});
