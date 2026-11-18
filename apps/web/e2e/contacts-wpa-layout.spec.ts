import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { seedContacts, signUpAndCreate } from "./helpers";

test("list details: no stray sort chevron on desktop (F10), 24px targets (F15), stage is not a pill (F18)", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const { workspaceId } = await signUpAndCreate(page, "Detail Owner", "Detail Co");
  await seedContacts(page, workspaceId, [{ name: "Pill Check", email: "pill@x.example" }]);
  await page.goto(`/w/${workspaceId}/contacts`);
  await expect(page.getByRole("row")).toHaveCount(2);
  // F10: the mobile-only Sort select leaves no chevron or wrapper box behind
  await expect(page.getByLabel("Sort by")).toBeHidden();
  expect(await page.locator("div.relative", { has: page.locator('select[aria-label="Sort by"]') }).boundingBox()).toBeNull();
  // F15: WCAG 2.5.8 minimum target size for the sort buttons and the focused skip link
  for (const b of await page.getByRole("columnheader").getByRole("button").all()) {
    const box = (await b.boundingBox())!;
    expect(box.width).toBeGreaterThanOrEqual(24);
    expect(box.height).toBeGreaterThanOrEqual(24);
  }
  await page.keyboard.press("Tab");
  const skip = page.getByRole("link", { name: "Skip to content" });
  await expect(skip).toBeFocused();
  const sb = (await skip.boundingBox())!;
  expect(sb.width).toBeGreaterThanOrEqual(24);
  expect(sb.height).toBeGreaterThanOrEqual(24);
  // F18: the stage is dot plus text, with no pill background or border
  const stage = page.getByRole("row").nth(1).getByRole("cell").nth(2).getByRole("button").locator("span").first(); // cell 0 is the row checkbox, 1 the contact, 2 the stage
  await expect(stage).toHaveText(/\w/);
  const style = await stage.evaluate((e) => { const s = getComputedStyle(e); return { bg: s.backgroundColor, radius: s.borderRadius, border: s.borderTopWidth }; });
  expect(style).toEqual({ bg: "rgba(0, 0, 0, 0)", radius: "0px", border: "0px" });

  for (const [width, height] of [[375, 812], [768, 1024], [1440, 900]] as const) {
    await page.setViewportSize({ width, height });
    const r = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
    expect(r.violations.map((v) => `${width}: ${v.id} ${JSON.stringify(v.nodes[0]?.target)}`)).toEqual([]);
  }
});
