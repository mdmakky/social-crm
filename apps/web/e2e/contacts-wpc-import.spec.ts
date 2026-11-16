import { readFile } from "node:fs/promises";
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { seedContacts, signUpAndCreate } from "./helpers";

const file = (name: string, csv: string) => ({ name, mimeType: "text/csv", buffer: Buffer.from(csv) });
const json = (status: number, code: string, message = code) => ({ status, contentType: "application/json", body: JSON.stringify({ error: { code, message } }) });
const HEADER = "Name,Email,Phone,Company,Stage,Owner email,Tags";

async function toReview(page: Page, csv: string) {
  await page.getByLabel("CSV file").setInputFiles(file("people.csv", csv));
  await expect(page.getByRole("heading", { name: "Match columns" })).toBeFocused();
  await page.getByRole("button", { name: "Check my data" }).click();
  await expect(page.getByRole("heading", { name: "Review before importing" })).toBeVisible();
}

test.describe("import wizard: plan consistency (F5)", () => {
  test("a slow preview cannot be committed as a different plan", async ({ page }) => {
    const { workspaceId } = await signUpAndCreate(page, "Race Owner", "Race Co");
    await seedContacts(page, workspaceId, [{ name: "Existing Erin", email: "erin@exist.example" }]);
    await page.goto(`/w/${workspaceId}/contacts/import`);
    await toReview(page, [HEADER, "New Nia,nia@i.example,,,,,", "Erin Again,erin@exist.example,,,,,"].join("\n"));
    await expect(page.getByRole("button", { name: /^Import 1 contact$/ })).toBeEnabled();

    const previews: string[] = [];
    const commits: string[] = [];
    let first = true;
    await page.route("**/imports/*/preview", async (r) => {
      previews.push(r.request().postData() ?? "");
      if (first) { first = false; await new Promise((res) => setTimeout(res, 800)); }
      await r.continue();
    });
    await page.route("**/imports/*/commit", (r) => { commits.push(r.request().postData() ?? ""); return r.continue(); });

    await page.getByLabel("Decision for row 3").selectOption({ label: "Import them anyway" });
    // while the preview is in flight nothing can change the plan or be committed
    await expect(page.getByLabel("Decision for row 3")).toBeDisabled();
    await expect(page.getByLabel("Import them anyway").first()).toBeDisabled();
    await expect(page.getByRole("button", { name: /^Import / })).toBeDisabled();
    const next = page.getByRole("button", { name: /^Import 2 contacts$/ });
    await expect(next).toBeEnabled();
    await next.click();
    await expect(page.getByText("2 added · 0 updated · 0 skipped.")).toBeVisible();
    expect(commits).toHaveLength(1);
    expect(JSON.parse(commits[0]!)).toEqual(JSON.parse(previews[previews.length - 1]!));
  });

  test("a failed preview refresh leaves Import disabled until it is refreshed", async ({ page }) => {
    const { workspaceId } = await signUpAndCreate(page, "Stale Owner", "Stale Co");
    await seedContacts(page, workspaceId, [{ name: "Existing Erin", email: "erin@exist.example" }]);
    await page.goto(`/w/${workspaceId}/contacts/import`);
    await toReview(page, [HEADER, "New Nia,nia@i.example,,,,,", "Erin Again,erin@exist.example,,,,,"].join("\n"));
    await page.route("**/imports/*/preview", (r) => r.fulfill(json(500, "internal")));
    await page.getByLabel("Update the existing contact").check();
    await expect(page.getByRole("alert").filter({ hasText: "Something went wrong" })).toBeVisible();
    await expect(page.getByRole("button", { name: /^Import / })).toBeDisabled();
    await page.unroute("**/imports/*/preview");
    await page.getByRole("button", { name: "Refresh preview" }).click();
    await expect(page.getByRole("button", { name: /^Import 2 contacts$/ })).toBeEnabled();
  });

  test("skip-problem-rows toggle re-runs the preview and commits the same plan", async ({ page }) => {
    const { workspaceId } = await signUpAndCreate(page, "Skip Owner", "Skip Co");
    await page.goto(`/w/${workspaceId}/contacts/import`);
    await toReview(page, [HEADER, "Good Gia,gia@i.example,,,,,", "Bad Bo,not-an-email,,,,,"].join("\n"));
    const importBtn = page.getByRole("button", { name: /^Import 1 contact$/ });
    await expect(importBtn).toBeDisabled();
    const previews: string[] = [];
    const commits: string[] = [];
    await page.route("**/imports/*/preview", (r) => { previews.push(r.request().postData() ?? ""); return r.continue(); });
    await page.route("**/imports/*/commit", (r) => { commits.push(r.request().postData() ?? ""); return r.continue(); });
    await page.getByLabel(/Skip the 1 problem row/).check();
    await expect(importBtn).toBeEnabled();
    expect(previews).toHaveLength(1);
    expect(JSON.parse(previews[0]!).skipInvalid).toBe(true);
    await importBtn.click();
    await expect(page.getByText("1 added · 0 updated · 0 skipped.")).toBeVisible();
    expect(JSON.parse(commits[0]!)).toEqual(JSON.parse(previews[0]!));
  });

  test("going back and changing columns starts from fresh duplicate choices", async ({ page }) => {
    const { workspaceId } = await signUpAndCreate(page, "Back Owner", "Back Co");
    await seedContacts(page, workspaceId, [{ name: "Existing Erin", email: "erin@exist.example" }]);
    await page.goto(`/w/${workspaceId}/contacts/import`);
    await toReview(page, [HEADER, "Erin Again,erin@exist.example,,,,,"].join("\n"));
    await page.getByLabel("Update the existing contact").check();
    await expect(page.getByRole("button", { name: /^Import 1 contact$/ })).toBeEnabled();
    await page.getByRole("button", { name: "Back to columns" }).click();
    await page.getByRole("button", { name: "Check my data" }).click();
    await expect(page.getByLabel("Skip them")).toBeChecked();
    await expect(page.getByRole("button", { name: "Nothing to import" })).toBeDisabled();
  });
});

test.describe("import wizard: API errors and warnings (mocked responses)", () => {
  test("upload 413 and 429 give actionable messages and stay on step 1", async ({ page }) => {
    const { workspaceId } = await signUpAndCreate(page, "Err Owner", "Err Co");
    await page.goto(`/w/${workspaceId}/contacts/import`);
    await page.route("**/v1/workspaces/*/imports", (r) => r.fulfill(json(413, "too_large")));
    await page.getByLabel("CSV file").setInputFiles(file("big.csv", "Name\nA"));
    await expect(page.getByRole("alert").filter({ hasText: /too large.*Split it/ })).toBeVisible();
    await page.unroute("**/v1/workspaces/*/imports");
    await page.route("**/v1/workspaces/*/imports", (r) => r.fulfill(json(429, "rate_limited")));
    await page.getByLabel("CSV file").setInputFiles(file("big.csv", "Name\nA"));
    await expect(page.getByRole("alert").filter({ hasText: /too many imports.*Wait a few minutes/ })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Choose a CSV file" })).toBeVisible();
  });

  test("preview 409 import_expired offers a fresh upload", async ({ page }) => {
    const { workspaceId } = await signUpAndCreate(page, "Exp Owner", "Exp Co");
    await page.goto(`/w/${workspaceId}/contacts/import`);
    await page.getByLabel("CSV file").setInputFiles(file("p.csv", `${HEADER}\nA Person,a@i.example,,,,,`));
    await page.route("**/imports/*/preview", (r) => r.fulfill(json(409, "import_expired")));
    await page.getByRole("button", { name: "Check my data" }).click();
    const alert = page.getByRole("alert").filter({ hasText: "upload expired" });
    await expect(alert).toContainText("Nothing was imported");
    await alert.getByRole("button", { name: "Upload a new file" }).click();
    await expect(page.getByRole("heading", { name: "Choose a CSV file" })).toBeFocused();
    await expect(page.getByRole("alert").filter({ hasText: "upload expired" })).toHaveCount(0);
  });

  test("preview 429 and commit 409 import_busy are explained", async ({ page }) => {
    const { workspaceId } = await signUpAndCreate(page, "Busy Owner", "Busy Co");
    await page.goto(`/w/${workspaceId}/contacts/import`);
    await page.getByLabel("CSV file").setInputFiles(file("p.csv", `${HEADER}\nA Person,a@i.example,,,,,`));
    await page.route("**/imports/*/preview", (r) => r.fulfill(json(429, "rate_limited")));
    await page.getByRole("button", { name: "Check my data" }).click();
    await expect(page.getByRole("alert").filter({ hasText: /too many imports/ })).toBeVisible();
    await page.unroute("**/imports/*/preview");
    await page.getByRole("button", { name: "Check my data" }).click();
    await expect(page.getByRole("heading", { name: "Review before importing" })).toBeFocused();
    await page.route("**/imports/*/commit", (r) => r.fulfill(json(409, "import_busy")));
    await page.getByRole("button", { name: /^Import 1 contact$/ }).click();
    await expect(page.getByRole("alert").filter({ hasText: /Another import is running.*Wait a moment/ })).toBeVisible();
    await expect(page.getByRole("button", { name: /^Import 1 contact$/ })).toBeEnabled(); // can retry
  });

  test("preview warnings are listed with their reasons", async ({ page }) => {
    const { workspaceId } = await signUpAndCreate(page, "Warn Owner", "Warn Co");
    await page.goto(`/w/${workspaceId}/contacts/import`);
    await page.getByLabel("CSV file").setInputFiles(file("p.csv", `${HEADER}\nA Person,a@i.example,,,,,\nB Person,b@i.example,,,,,`));
    // mocked preview: the contract shape is real, the warning content is simulated
    await page.route("**/imports/*/preview", (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ total: 2, valid: 2, invalid: 0, willCreate: 1, willUpdate: 0, willSkip: 1, errors: [], duplicates: [], warnings: [{ row: 2, message: "Skipped: the earlier row with the same email or phone was skipped, so there is no contact to update." }], truncated: false }) }));
    await page.getByRole("button", { name: "Check my data" }).click();
    await expect(page.getByRole("heading", { name: "1 row will be skipped" })).toBeVisible();
    await expect(page.getByText("Row 3:")).toBeVisible();
    await expect(page.getByText(/no contact to update/)).toBeVisible();
    for (const width of [375, 768, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      const r = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
      expect(r.violations.map((v) => `${width}: ${v.id}`)).toEqual([]);
    }
  });
});

test("problem rows can be downloaded as a CSV (F13)", async ({ page }) => {
  const { workspaceId } = await signUpAndCreate(page, "Dl Owner", "Dl Co");
  await page.goto(`/w/${workspaceId}/contacts/import`);
  await toReview(page, [HEADER, "Good Gia,gia@i.example,,,,,", "Bad Bo,not-an-email,,,,,"].join("\n"));
  await expect(page.getByRole("alert").filter({ hasText: "1 row has problems" })).toBeFocused();
  const [dl] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Download problem rows" }).click()]);
  expect(dl.suggestedFilename()).toBe("problem-rows.csv");
  const text = await readFile((await dl.path())!, "utf8");
  expect(text).toMatch(/^Row,Problems\n3,"""not-an-email"" is not a valid email/);
});
