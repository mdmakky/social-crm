import AxeBuilder from "@axe-core/playwright";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { expect, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { register } from "./helpers";

/** Shared by the inbox and integrations specs. Both run on MOCK data: nothing here proves real Meta behaviour. */
export const DB = process.env.CRM_DB_NAME ?? "crm";
export const API_DIR = join(__dirname, "..", "..", "api");
export const WEB = `http://localhost:${process.env.E2E_WEB_PORT ?? "3217"}`;

export const axe = async (page: Page, label: string) => {
  const r = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
  const bad = r.violations.filter((v) => v.impact === "critical" || v.impact === "serious");
  expect(bad.map((v) => `${label}: ${v.id} (${v.impact}) ${v.nodes[0]?.target.join(" ")}`), `axe ${label}`).toEqual([]);
};
/** A keyboard-focused element must show a focus indicator (outline or ring). */
export const focusIndicator = (page: Page) =>
  page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    if (!el || el === document.body) return "none-focused";
    const s = getComputedStyle(el);
    return s.outlineStyle !== "none" && parseFloat(s.outlineWidth) > 0 ? "outline" : s.boxShadow !== "none" ? "ring" : "no-indicator";
  });
export const unreadTotal = async (page: Page) => Number(((await page.getByText(/^\d+ unread$/).first().textContent()) ?? "0").replace(/\D/g, ""));
/** MOCK inbox fixtures (apps/api/dev/seed-inbox.mts) into one workspace of the e2e database. */
export const seed = (workspaceId: string) =>
  execFileSync("pnpm", ["exec", "tsx", "dev/seed-inbox.mts", workspaceId], { cwd: API_DIR, env: { ...process.env, SEED_DATABASE_URL: `postgres://postgres:postgres@127.0.0.1:5436/${DB}` }, stdio: "pipe" });

export async function person(browser: Browser, name: string): Promise<{ ctx: BrowserContext; page: Page; email: string }> {
  const ctx = await browser.newContext({ baseURL: WEB });
  const page = await ctx.newPage();
  const email = await register(page, name);
  return { ctx, page, email };
}
