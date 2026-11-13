import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { api, seedContacts, signUpAndCreate, CONTACT_NAMES } from "./helpers";
// Screenshots and a text report land in SHOT_DIR (default: test-results/ux-audit); the test fails on any horizontal overflow or critical/serious axe violation.
const OUT = process.env.SHOT_DIR ?? "test-results/ux-audit";
const DAY = 86_400_000;
const inDays = (d: number) => new Date(Date.now() + d * DAY).toISOString();
test("audit all screens", async ({ page }) => {
  test.setTimeout(400_000);
  const { workspaceId: w } = await signUpAndCreate(page, "Olive Owner", "Costa Studio");
  const ids = await seedContacts(page, w, CONTACT_NAMES.map((n, i) => ({ name: n, email: n.split(" ")[0]!.toLowerCase() + "@example.com", company: ["Northwind", "Acme Co", "Globex", "Initech"][i % 4] })));
  const a = api(page);
  const leadIds: string[] = [];
  for (let i = 0; i < 6; i++) { const r = await a.post(`/v1/workspaces/${w}/leads`, { title: ["Website redesign", "Annual retainer", "Pop-up store", "Photo shoot", "Brand kit", "Ad campaign"][i], primaryContactId: ids[i], valueMinor: 120000 * (i + 1), currency: "USD" }); leadIds.push((await r.json()).id); }
  for (let i = 0; i < 5; i++) await a.post(`/v1/workspaces/${w}/tasks`, { title: ["Chase the late payment", "Prepare renewal deck", "Send proposal", "Call back", "Review contract"][i], dueAt: inDays(i - 2), priority: ["urgent", "high", "normal", "low", "high"][i], contactId: ids[i] });
  const pages: [string, string][] = [["dashboard", ""], ["contacts", "/contacts"], ["contact", `/contacts/${ids[0]}`], ["leads", "/leads"], ["lead", `/leads/${leadIds[0]}`], ["pipeline", "/pipeline"], ["tasks", "/tasks"], ["notifications", "/notifications"], ["settings", "/settings"], ["settings-pipelines", "/settings/pipelines"], ["settings-contacts", "/settings/contacts"], ["settings-notifications", "/settings/notifications"], ["members", "/members"], ["audit", "/audit-log"], ["reports", "/reports"]];
  mkdirSync(OUT, { recursive: true });
  const rows: string[] = [];
  const bad: string[] = [];
  for (const [vw, width, height] of [["desktop", 1440, 900], ["tablet", 768, 1024], ["mobile", 375, 800]] as const) {
    await page.setViewportSize({ width, height });
    for (const [name, path] of pages) {
      await page.goto(`/w/${w}${path}`);
      await page.waitForLoadState("networkidle");
      await page.screenshot({ path: `${OUT}/${vw}-${name}.png` });
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      const axe = (await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze()).violations.filter((v) => v.impact === "critical" || v.impact === "serious");
      const line = `${vw} ${name}: overflow=${overflow}px axe=${axe.length ? axe.map((v) => `${v.id}(${v.nodes.length}) ${v.nodes[0]?.target}`).join("; ") : "0 critical/serious"}`;
      rows.push(line);
      if (overflow > 0 || axe.length) bad.push(line);
    }
  }
  writeFileSync(`${OUT}/report.txt`, rows.join("\n"));
  expect(bad).toEqual([]);
});
