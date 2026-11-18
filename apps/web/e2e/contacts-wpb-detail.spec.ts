import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { api, seedContacts, signUpAndCreate, openDetails } from "./helpers";

const SIZES = [{ width: 375, height: 812 }, { width: 768, height: 1024 }, { width: 1440, height: 900 }] as const;

test.describe("contact detail (WP-B)", () => {
  test("F9: a version conflict keeps my edits and 'Apply my changes on top' saves them over the latest", async ({ page }) => {
    const { workspaceId } = await signUpAndCreate(page, "Conf Owner", "Conf Co");
    const [id] = await seedContacts(page, workspaceId, [{ name: "Gus Hall", email: "gus@conf.example", company: "Hall & Co" }]);
    await page.goto(`/w/${workspaceId}/contacts/${id}`);
    await openDetails(page);
    const current = await (await api(page).get(`/v1/workspaces/${workspaceId}/contacts/${id}`)).json();
    await api(page).patch(`/v1/workspaces/${workspaceId}/contacts/${id}`, { expectedVersion: current.version, name: "Gus Hall Jr" });
    await page.getByLabel("Company").fill("Mine Co");
    await page.getByRole("button", { name: "Save changes" }).click();
    const alert = page.locator("form").filter({ hasText: "Someone else changed this lead." });
    await expect(alert).toContainText("They changed: Name");
    await expect(page.getByLabel("Company")).toHaveValue("Mine Co"); // edits are still there
    await alert.getByRole("button", { name: "Apply my changes on top" }).click();
    await expect(page.getByLabel("Name")).toHaveValue("Gus Hall Jr"); // their change is kept
    await expect(page.getByLabel("Company")).toHaveValue("Mine Co");
    await page.getByRole("button", { name: "Save changes" }).click();
    await expect(page.getByText("Saved.")).toBeVisible();
    const after = await (await api(page).get(`/v1/workspaces/${workspaceId}/contacts/${id}`)).json();
    expect([after.name, after.company]).toEqual(["Gus Hall Jr", "Mine Co"]);
  });

  test("F9: 'Discard mine, load latest' drops my edits", async ({ page }) => {
    const { workspaceId } = await signUpAndCreate(page, "Disc Owner", "Disc Co");
    const [id] = await seedContacts(page, workspaceId, [{ name: "Ida Ray", company: "Ray Co" }]);
    await page.goto(`/w/${workspaceId}/contacts/${id}`);
    await openDetails(page);
    const current = await (await api(page).get(`/v1/workspaces/${workspaceId}/contacts/${id}`)).json();
    await api(page).patch(`/v1/workspaces/${workspaceId}/contacts/${id}`, { expectedVersion: current.version, name: "Ida Ray II" });
    await page.getByLabel("Company").fill("Mine Co");
    await page.getByRole("button", { name: "Save changes" }).click();
    await page.getByRole("button", { name: "Discard mine, load latest" }).click();
    await expect(page.getByLabel("Name")).toHaveValue("Ida Ray II");
    await expect(page.getByLabel("Company")).toHaveValue("Ray Co");
  });

  test("F16: email and phone are mailto/tel links on the detail page", async ({ page }) => {
    const { workspaceId } = await signUpAndCreate(page, "Link Owner", "Link Co");
    const [id] = await seedContacts(page, workspaceId, [{ name: "Ana Costa", email: "ana@links.example", phone: "+1 555 010 2030" }]);
    await page.goto(`/w/${workspaceId}/contacts/${id}`);
    await openDetails(page);
    await expect(page.getByRole("link", { name: "ana@links.example" })).toHaveAttribute("href", "mailto:ana@links.example");
    await expect(page.getByRole("link", { name: "+1 555 010 2030" })).toHaveAttribute("href", "tel:+15550102030");
    await expect(page.getByRole("link", { name: "Send email" })).toHaveAttribute("href", "mailto:ana@links.example");
    await expect(page.getByRole("link", { name: "Call" })).toHaveAttribute("href", "tel:+15550102030");
    await page.setViewportSize({ width: 375, height: 812 });
    const w = await page.evaluate(() => ({ s: document.documentElement.scrollWidth, c: document.documentElement.clientWidth }));
    expect(w.s).toBeLessThanOrEqual(w.c);
  });

  test("F21: adding a note keeps the older activity already loaded", async ({ page }) => {
    const { workspaceId } = await signUpAndCreate(page, "Act Owner", "Act Co");
    const [id] = await seedContacts(page, workspaceId, [{ name: "Kai Lund" }]);
    for (let i = 0; i < 25; i++) await api(page).post(`/v1/workspaces/${workspaceId}/contacts/${id}/notes`, { body: `seed note ${i}` });
    await page.goto(`/w/${workspaceId}/contacts/${id}`);
    await openDetails(page);
    const rows = page.getByRole("list").filter({ has: page.locator("time") }).last().getByRole("listitem");
    await page.getByRole("button", { name: "Load older activity" }).click();
    await expect(rows.first()).toBeVisible();
    await expect.poll(() => rows.count()).toBeGreaterThan(20);
    const before = await rows.count();
    await page.getByLabel("Add a note").fill("fresh note");
    await page.getByRole("button", { name: "Add note" }).click();
    await expect(rows.first()).toContainText("fresh note");
    await expect.poll(() => rows.count()).toBe(before + 1);
  });

  test("F23: unsaved edits trigger the beforeunload prompt; clean forms do not", async ({ page }) => {
    const { workspaceId } = await signUpAndCreate(page, "Guard Owner", "Guard Co");
    const [id] = await seedContacts(page, workspaceId, [{ name: "Lia Moss" }]);
    await page.goto(`/w/${workspaceId}/contacts/${id}`);
    await openDetails(page);
    let prompts = 0;
    page.on("dialog", (d) => { prompts++; void d.accept(); });
    await page.reload(); // clean
    expect(prompts).toBe(0);
    await openDetails(page);
    await page.getByLabel("Company").fill("Dirty Co");
    await page.reload({ waitUntil: "load" });
    expect(prompts).toBe(1);
  });
});

const axe = async (page: Page, label: string) => {
  const r = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
  expect(r.violations.map((v) => `${label}: ${v.id} ${JSON.stringify(v.nodes[0]?.target)}`)).toEqual([]);
};

test("F7, F15, F22: labelled inputs, 24px targets, distinct note button names, axe at 3 widths", async ({ page }) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  const { workspaceId } = await signUpAndCreate(page, "Ana Owner", "A11y Co");
  const [id] = await seedContacts(page, workspaceId, [{ name: "Mia Fox", email: "mia@a11y.example", phone: "+1 555 000 1111" }]);
  await api(page).post(`/v1/workspaces/${workspaceId}/contacts/${id}/tags`, { name: "vip" });
  for (const b of ["first note", "second note"]) await api(page).post(`/v1/workspaces/${workspaceId}/contacts/${id}/notes`, { body: b });
  await page.goto(`/w/${workspaceId}/contacts/${id}`);

  await openDetails(page);
  for (const name of ["Add a tag", "Add a note", "New task", "Due", "Assign to"]) {
    await expect(page.getByLabel(name, { exact: true })).toBeVisible();
    await expect(page.locator("label", { hasText: new RegExp(`^${name}$`) })).toBeVisible();
  }

  const edits = page.getByRole("button", { name: /^Edit note by / });
  await expect(edits).toHaveCount(2);
  const names = await edits.evaluateAll((els) => els.map((e) => e.getAttribute("aria-label")));
  expect(new Set(names).size).toBe(2); // distinct only if timestamps differ; author+time disambiguates per note
  await expect(page.getByRole("button", { name: /^Delete note by Ana Owner on / })).toHaveCount(2);

  const box = await page.getByRole("button", { name: "Remove tag vip" }).boundingBox();
  expect(box!.width).toBeGreaterThanOrEqual(24);
  expect(box!.height).toBeGreaterThanOrEqual(24);

  for (const s of SIZES) {
    await page.setViewportSize(s);
    await page.reload();
    await expect(page.getByRole("heading", { name: "Mia Fox", level: 1 })).toBeVisible();
    const w = await page.evaluate(() => ({ s: document.documentElement.scrollWidth, c: document.documentElement.clientWidth }));
    expect(w.s, `${s.width}: page scrolls sideways`).toBeLessThanOrEqual(w.c);
    await axe(page, `detail ${s.width}`);
  }
});
