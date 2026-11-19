import AxeBuilder from "@axe-core/playwright";
import { devices, expect, test, type Page } from "@playwright/test";
import { api, PASSWORD, signOut, signUpAndCreate } from "./helpers";

// Settings > General: region and format, business info, logo, your name and password, and where the preferences show up.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
const save = (p: Page) => p.getByRole("button", { name: "Save changes" });
const bar = (p: Page) => p.getByRole("region", { name: "Unsaved changes" });

test("save bar appears only when something changed; discard resets; saved values stay after a reload and drive the rest of the app", async ({ page }) => {
  test.setTimeout(120_000);
  const { workspaceId } = await signUpAndCreate(page, "Prefs Owner", "Prefs Co");
  await page.goto(`/w/${workspaceId}/settings`);
  await expect(bar(page)).toHaveCount(0);
  await page.getByLabel("Workspace name").fill("Prefs Studio");
  await expect(bar(page)).toBeVisible();
  await bar(page).getByRole("button", { name: "Discard" }).click();
  await expect(bar(page)).toHaveCount(0);
  await expect(page.getByLabel("Workspace name")).toHaveValue("Prefs Co");

  await page.getByLabel("Default currency").selectOption("BDT");
  await page.getByRole("group", { name: "Time format" }).getByRole("button", { name: "24-hour" }).click();
  await page.getByRole("group", { name: "Week starts on" }).getByRole("button", { name: "Saturday" }).click();
  await page.getByLabel("Phone").fill("+880 1700 000000");
  await page.getByLabel("Support email").fill("hello@prefs.example");
  await page.getByLabel("Website").fill("https://prefs.example");
  await page.getByLabel("Choose a logo image").setInputFiles({ name: "logo.png", mimeType: "image/png", buffer: PNG });
  await expect(page.getByRole("img", { name: "Workspace logo" })).toBeVisible();
  await save(page).click();
  await expect(page.getByText("Settings saved.")).toBeVisible();
  await expect(bar(page)).toHaveCount(0);

  await page.reload();
  await expect(page.getByLabel("Default currency")).toHaveValue("BDT");
  await expect(page.getByRole("group", { name: "Time format" }).getByRole("button", { name: "24-hour" })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("group", { name: "Week starts on" }).getByRole("button", { name: "Saturday" })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByLabel("Phone")).toHaveValue("+880 1700 000000");
  await expect(page.getByRole("img", { name: "Workspace logo" })).toBeVisible();
  // the sidebar tile shows the logo
  await expect(page.getByRole("button", { name: /Switch workspace/ }).first().locator("img")).toBeVisible();

  // a new pipeline starts with the workspace currency
  await page.goto(`/w/${workspaceId}/settings/pipelines`);
  await page.getByRole("button", { name: "New pipeline" }).click();
  await expect(page.getByRole("dialog").getByLabel("Default currency")).toHaveValue("BDT");
});

test("bad business info is explained and cannot be saved; empty values clear a field", async ({ page }) => {
  const { workspaceId } = await signUpAndCreate(page, "Prefs Bad", "Bad Co");
  await page.goto(`/w/${workspaceId}/settings`);
  await page.getByLabel("Website").fill("example.com");
  await page.getByLabel("Support email").fill("nope");
  await expect(page.getByText("Start the website with http:// or https://")).toBeVisible();
  await expect(save(page)).toBeDisabled();
  await page.getByLabel("Website").fill("https://ok.example");
  await page.getByLabel("Support email").fill("");
  await expect(save(page)).toBeEnabled();
  await save(page).click();
  await expect(page.getByText("Settings saved.")).toBeVisible();
});

test("your name and your password", async ({ page }) => {
  test.setTimeout(120_000);
  const { workspaceId } = await signUpAndCreate(page, "Name Owner", "Account Co");
  const email = (await (await api(page).get("/v1/me")).json()).email as string;
  await page.goto(`/w/${workspaceId}/settings`);
  await page.getByLabel("Your name").fill("Renamed Person");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText("Name saved.")).toBeVisible();
  expect((await (await api(page).get("/v1/me")).json()).name).toBe("Renamed Person");

  await page.getByRole("button", { name: "Change password" }).click();
  await page.getByLabel("Current password").fill("not-the-password");
  await page.getByLabel("New password", { exact: true }).fill("a-brand-new-password");
  await page.getByLabel("New password again").fill("a-brand-new-password");
  await page.getByRole("button", { name: "Change password" }).last().click();
  await expect(page.getByRole("alert").filter({ hasText: /password/i }).first()).toBeVisible();
  await page.getByLabel("Current password").fill(PASSWORD);
  await page.getByLabel("New password again").fill("different-one-here");
  await expect(page.getByText("The two passwords do not match.")).toBeVisible();
  await page.getByLabel("New password again").fill("a-brand-new-password");
  await page.getByRole("button", { name: "Change password" }).last().click();
  await expect(page.getByText("Password changed. Other devices were signed out.")).toBeVisible();

  await signOut(page);
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: /Sign in|Log in/ }).click();
  await expect(page.getByText(/incorrect|invalid/i).first()).toBeVisible();
  await page.getByLabel("Password").fill("a-brand-new-password");
  await page.getByRole("button", { name: /Sign in|Log in/ }).click();
  await page.waitForURL(/\/w\//);
});

const { defaultBrowserType: _browser, ...pixel7 } = devices["Pixel 7"];
test.describe("phone", () => {
  test.use(pixel7);
  test("the save bar sits above the bottom bar, targets are 44px, no sideways scroll, axe clean", async ({ page }) => {
    test.setTimeout(120_000);
    const { workspaceId } = await signUpAndCreate(page, "Prefs Phone", "Phone Co");
    await page.goto(`/w/${workspaceId}/settings/general`);
    await expect(page.getByRole("heading", { name: "General", level: 1 })).toBeVisible();
    await page.getByLabel("Workspace name").fill("Phone Studio");
    await page.getByLabel("Workspace name").blur(); // the bottom bar steps aside while typing
    await expect(page.getByRole("navigation", { name: "Primary" })).toBeVisible();
    const b = (await bar(page).boundingBox())!;
    const nav = (await page.getByRole("navigation", { name: "Primary" }).boundingBox())!;
    expect(b.y + b.height).toBeLessThanOrEqual(nav.y + 1);
    for (const name of ["Discard", "Save changes"]) expect((await bar(page).getByRole("button", { name }).boundingBox())!.height, name).toBeGreaterThanOrEqual(44);
    for (const name of ["24-hour", "Saturday", "Change", "Change password", "Upload logo"]) expect((await page.getByRole("button", { name }).first().boundingBox())!.height, name).toBeGreaterThanOrEqual(44);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    const r = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
    expect(r.violations.map((v) => `${v.id} ${JSON.stringify(v.nodes[0]?.target)}`)).toEqual([]);
  });
});
