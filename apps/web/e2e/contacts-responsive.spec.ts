import AxeBuilder from "@axe-core/playwright";
import { devices, expect, test, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { CONTACT_NAMES, seedContacts, signUpAndCreate } from "./helpers";

const SHOTS = (process.env.UPDATE_SCREENSHOTS ? join(__dirname, "../../../docs/design/screenshots/phase2-contacts") : join(__dirname, "../test-results/shots-contacts")) + "/";
mkdirSync(SHOTS, { recursive: true });

const SIZES = [{ name: "375", width: 375, height: 812 }, { name: "768", width: 768, height: 1024 }, { name: "1440", width: 1440, height: 900 }] as const;

const axe = async (page: Page, label: string) => {
  const r = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
  expect(r.violations.map((v) => `${label}: ${v.id} ${JSON.stringify(v.nodes[0]?.target)} ${v.nodes[0]?.html.slice(0, 100)}`)).toEqual([]);
};
const noPageOverflow = async (page: Page, label: string) => {
  const w = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }));
  expect(w.scroll, `${label}: page scrolls sideways`).toBeLessThanOrEqual(w.client);
  const clipped = await page.evaluate(() => Array.from(document.querySelectorAll<HTMLElement>(".overflow-x-auto:not([data-scroll=allowed])")).filter((e) => e.clientWidth > 0 && e.scrollWidth > e.clientWidth + 1).length);
  expect(clipped, `${label}: a container needs its own scrollbar`).toBe(0);
};

test("contacts screens hold at 375, 768 and 1440: no page overflow, no axe violations, purpose-built mobile layout", async ({ page }) => {
  test.setTimeout(240_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  const { workspaceId } = await signUpAndCreate(page, "Maya Okafor", "Northwind Studio");
  const ids = await seedContacts(page, workspaceId, [
    ...Array.from({ length: 12 }, (_, i) => ({ name: `${CONTACT_NAMES[i % 10]} ${["Thomas-Montgomery", "Li", "Fitzgerald-Brandt"][i % 3]}`, email: `person${i}.with.a.rather.long.address@example-company-domain.com`, phone: `+1 555 01${String(i).padStart(2, "0")} 0000`, company: i % 2 ? "Umbrella Corporation International" : "Globex" })),
  ]);
  const a = (path: string, data: unknown) => page.request.post(path, { data, headers: { origin: `http://localhost:${process.env.E2E_WEB_PORT ?? "3217"}` } });
  await a(`/v1/workspaces/${workspaceId}/contacts/${ids[0]}/tags`, { name: "wholesale" });
  await a(`/v1/workspaces/${workspaceId}/contacts/${ids[0]}/tags`, { name: "vip" });
  await a(`/v1/workspaces/${workspaceId}/contacts/${ids[0]}/tags`, { name: "renewal-2026" });
  await a(`/v1/workspaces/${workspaceId}/contacts/${ids[0]}/notes`, { body: "Prefers calls after 4pm. Asked for a revised quote including onboarding and training for a team of twelve." });
  await a(`/v1/workspaces/${workspaceId}/contacts/${ids[0]}/tasks`, { title: "Send the revised quote and onboarding schedule", dueAt: "2026-12-20T09:00:00Z" });

  const routes = [
    { key: "list", path: `/w/${workspaceId}/contacts`, heading: "Contacts" },
    { key: "detail", path: `/w/${workspaceId}/contacts/${ids[0]}`, heading: /Ana Costa/ },
    { key: "import", path: `/w/${workspaceId}/contacts/import`, heading: "Import contacts" },
    { key: "settings", path: `/w/${workspaceId}/settings/contacts`, heading: "Contact fields" },
  ];
  for (const s of SIZES) {
    await page.setViewportSize({ width: s.width, height: s.height });
    for (const r of routes) {
      await page.goto(r.path);
      await expect(page.getByRole("heading", { level: 1, name: r.heading })).toBeVisible();
      await noPageOverflow(page, `${r.key}@${s.name}`);
      await axe(page, `${r.key}@${s.name}`);
      await page.screenshot({ path: `${SHOTS}${r.key}-${s.name}.png` });
    }
  }

  // phones get cards, desktops get the table
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto(`/w/${workspaceId}/contacts`);
  await expect(page.getByRole("table")).toBeHidden();
  const card = page.getByRole("link", { name: /Ana Costa/ }).first();
  await expect(card).toBeVisible();
  expect((await card.boundingBox())!.height).toBeGreaterThanOrEqual(56);
  await expect(page.getByRole("button", { name: "Filters" })).toBeVisible();
  await expect(page.getByLabel("Lifecycle stage")).toBeHidden();
  await page.getByRole("button", { name: "Filters" }).click();
  await expect(page.getByLabel("Lifecycle stage")).toBeVisible();
  await axe(page, "list-filters-open@375");
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(page.getByRole("table")).toBeVisible();
  await expect(page.getByRole("columnheader")).toHaveCount(9); // eight default columns plus the select column

  // overlays
  await page.getByRole("button", { name: "Add contact" }).first().click();
  await axe(page, "new-contact-dialog");
  await page.screenshot({ path: `${SHOTS}new-contact-dialog-1440.png` });
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Columns", exact: true }).click();
  await axe(page, "columns-dialog");
  await page.keyboard.press("Escape");
});

const { defaultBrowserType: _browser, ...pixel7 } = devices["Pixel 7"];
test.describe("touch", () => {
  test.use(pixel7);
  test("contact actions are comfortable to tap", async ({ page }) => {
    const { workspaceId } = await signUpAndCreate(page, "Touch Contacts", "Touch Contacts Co");
    const [id] = await seedContacts(page, workspaceId, [{ name: "Tap Target", email: "tap@x.example" }]);
    await page.goto(`/w/${workspaceId}/contacts`);
    for (const name of ["Add contact", "Filters", "Views"]) {
      const b = await page.getByRole("button", { name: name, exact: name !== "Add contact" }).first().boundingBox();
      expect(b!.height, name).toBeGreaterThanOrEqual(44);
    }
    expect((await page.getByLabel("Search contacts").boundingBox())!.height).toBeGreaterThanOrEqual(44);
    expect(await page.getByLabel("Search contacts").evaluate((e) => getComputedStyle(e).fontSize)).toBe("16px");
    await page.goto(`/w/${workspaceId}/contacts/${id}`);
    for (const label of ["Name", "Email", "Add a note", "New task"]) {
      const field = page.getByLabel(label, { exact: true }).first();
      await field.waitFor(); // the page streams in behind a skeleton; measure only once the field exists
      const box = await field.boundingBox();
      expect(box!.height, label).toBeGreaterThanOrEqual(44);
    }
    await page.getByRole("button", { name: "Add task" }).waitFor();
    const check = await page.getByRole("button", { name: "Add task" }).boundingBox();
    expect(check!.height).toBeGreaterThanOrEqual(44);
  });
});
