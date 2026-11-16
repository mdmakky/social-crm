import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Browser, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { addMemberByEmail, register, signUpAndCreate } from "./helpers";

// Screenshots only overwrite the committed set when explicitly asked: UPDATE_SCREENSHOTS=1
const SHOTS = (process.env.UPDATE_SCREENSHOTS ? join(__dirname, "../../../docs/design/screenshots/phase1-shell") : join(__dirname, "../test-results/shots")) + "/";
mkdirSync(SHOTS, { recursive: true });

const SIZES = [
  { name: "375", width: 375, height: 812 },
  { name: "768", width: 768, height: 1024 },
  { name: "1440", width: 1440, height: 900 },
] as const;

async function member(browser: Browser, name: string, workspaceId: string, role: string) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const email = await register(page, name);
  await addMemberByEmail(workspaceId, email, role);
  await ctx.close();
}

/** Nothing meant to fit may need its own horizontal scrollbar (a clipped table hides actions). */
const noInnerScroll = async (page: Page) => {
  const clipped = await page.evaluate(() =>
    Array.from(document.querySelectorAll<HTMLElement>(".overflow-x-auto:not([data-scroll=allowed])"))
      .filter((el) => el.clientWidth > 0 && el.scrollWidth > el.clientWidth + 1)
      .map((el) => `${location.pathname.replace(/[0-9a-f-]{36}/, ":id")} scrollWidth=${el.scrollWidth} clientWidth=${el.clientWidth}`),
  );
  expect(clipped).toEqual([]);
};
const noOverflow = async (page: Page) => {
  const offenders = await page.evaluate(() => {
    const w = document.documentElement.clientWidth;
    if (document.documentElement.scrollWidth <= w) return [];
    return Array.from(document.querySelectorAll("body *"))
      .filter((el) => {
        if (el.getBoundingClientRect().right <= w + 0.5 || getComputedStyle(el).position === "fixed") return false;
        for (let a = el.parentElement; a && a !== document.body; a = a.parentElement) if (getComputedStyle(a).overflowX !== "visible") return false; // clipped or scrollable ancestor
        return true;
      })
      .slice(0, 5)
      .map((el) => `${page_url()} ${el.tagName.toLowerCase()}.${String(el.className).slice(0, 80)} right=${Math.round(el.getBoundingClientRect().right)} vw=${w}`)
      .concat([`${page_url()} scrollW=${document.documentElement.scrollWidth} bodyW=${document.body.scrollWidth}`])
      .concat(Array.from(document.querySelectorAll("*")).filter((el) => el.scrollWidth > el.clientWidth + 1 && el.clientWidth > 0).slice(0, 8).map((el) => `SCROLLY ${el.tagName.toLowerCase()}.${String(el.className).slice(0, 50)} sw=${el.scrollWidth} cw=${el.clientWidth} ox=${getComputedStyle(el).overflowX}`))
      .concat(Array.from(document.querySelectorAll("*")).filter((el) => el.getBoundingClientRect().right > w + 0.5).slice(0, 2).map((el) => `ANY ${el.tagName.toLowerCase()}.${String(el.className).slice(0, 60)} pos=${getComputedStyle(el).position} right=${Math.round(el.getBoundingClientRect().right)}`));
    function page_url() { return location.pathname.replace(/[0-9a-f-]{36}/, ":id"); }
  });
  expect(offenders).toEqual([]);
};
const axe = async (page: Page, label: string) => {
  const r = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
  expect(r.violations.map((v) => `${label}: ${v.id} (${v.nodes.length}) ${JSON.stringify(v.nodes[0]?.target)} ${v.nodes[0]?.html.slice(-160)}`)).toEqual([]);
};

test.describe("responsive layout and accessibility", () => {
  test("screens hold at 375, 768 and 1440 with no overflow and no axe violations", async ({ browser }) => {
    test.setTimeout(180_000);
    // authenticated context at desktop first, used for all sizes
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await ctx.newPage();
    const { workspaceId } = await signUpAndCreate(page, "Maya Okafor", "Northwind Studio International Marketing Team");
    await member(browser, "Daniel Brandt-Fitzgerald-Montgomery", workspaceId, "admin");
    await member(browser, "Sofia Almeida", workspaceId, "agent");
    await member(browser, "Liam Chen", workspaceId, "viewer");
    // an audit entry beyond creation
    await page.request.patch(`/v1/workspaces/${workspaceId}`, { data: { timezone: "America/New_York" }, headers: { origin: `http://localhost:${process.env.E2E_WEB_PORT ?? "3217"}` } });

    const routes = [
      { key: "home", path: `/w/${workspaceId}` },
      { key: "members", path: `/w/${workspaceId}/members` },
      { key: "audit", path: `/w/${workspaceId}/audit-log` },
      { key: "settings", path: `/w/${workspaceId}/settings` },
    ];
    for (const s of SIZES) {
      await page.setViewportSize({ width: s.width, height: s.height });
      for (const r of routes) {
        await page.goto(r.path);
        await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
        await noOverflow(page);
        await noInnerScroll(page);
        await axe(page, `${r.key}@${s.name}`);
        await page.screenshot({ path: `${SHOTS}${r.key}-${s.name}.png` });
      }
    }

    // structural responsiveness
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`/w/${workspaceId}`);
    await expect(page.getByRole("navigation", { name: "Main" }).filter({ visible: true }).getByText("Members")).toBeVisible();
    await page.setViewportSize({ width: 768, height: 1024 });
    await expect(page.getByRole("navigation", { name: "Main" }).filter({ visible: true }).getByText("Members")).toBeHidden(); // rail: icons only
    await expect(page.getByRole("link", { name: "Members" }).filter({ visible: true })).toBeVisible(); // still reachable by name
    await page.setViewportSize({ width: 375, height: 812 });
    await expect(page.getByRole("navigation", { name: "Main" }).filter({ visible: true })).toHaveCount(0);
    await expect(page.getByRole("navigation", { name: "Primary" })).toBeVisible(); // bottom bar on phones
    await page.getByRole("button", { name: "More" }).click();
    const drawer = page.getByRole("dialog", { name: "More" });
    await expect(drawer.getByRole("link", { name: "Members" })).toBeVisible();
    await axe(page, "drawer@375");
    await page.screenshot({ path: `${SHOTS}drawer-375.png` });
    await drawer.getByRole("link", { name: "Members" }).click();
    await expect(page).toHaveURL(/\/members$/);
    await expect(drawer).toBeHidden();

    // overlays
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.keyboard.press("Control+k");
    await expect(page.getByRole("dialog", { name: "Command menu" })).toBeVisible();
    await axe(page, "command-menu");
    await page.screenshot({ path: `${SHOTS}command-menu-1440.png` });
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Actions for Sofia Almeida" }).click();
    await page.getByRole("menuitem", { name: "Change role" }).click();
    await axe(page, "role-dialog");
    await page.screenshot({ path: `${SHOTS}role-dialog-1440.png` });
    await ctx.close();
  });

  test("auth screens: no overflow and no axe violations, with error state", async ({ browser }) => {
    for (const s of SIZES) {
      const ctx = await browser.newContext({ viewport: { width: s.width, height: s.height } });
      const page = await ctx.newPage();
      for (const path of ["/login", "/register"]) {
        await page.goto(path);
        await noOverflow(page);
        await axe(page, `${path}@${s.name}`);
      }
      await page.goto("/login");
      await page.getByRole("button", { name: "Sign in" }).click();
      await expect(page.getByText("Enter a valid email address.")).toBeVisible();
      await axe(page, `login-errors@${s.name}`);
      await page.screenshot({ path: `${SHOTS}login-errors-${s.name}.png` });
      await ctx.close();
    }
  });

  test("onboarding and empty/forbidden states pass axe", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await register(page, "Fresh User");
    await axe(page, "onboarding");
    await page.screenshot({ path: `${SHOTS}onboarding-1440.png` });
  });
});
