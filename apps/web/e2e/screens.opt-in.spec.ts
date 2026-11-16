import { mkdirSync } from "node:fs";
import { test } from "@playwright/test";
import { api, seedContacts, signUpAndCreate } from "./helpers";

// Opt-in visual review: SHOTS=1 pnpm exec playwright test screens.opt-in. Writes PNGs to SHOTS_DIR (default /tmp/int_shots).
test.skip(!process.env.SHOTS, "set SHOTS=1 to capture review screenshots");
const OUT = process.env.SHOTS_DIR ?? "/tmp/int_shots";

test("capture review screenshots at 1440 and 375", async ({ page }) => {
  test.setTimeout(240_000);
  mkdirSync(OUT, { recursive: true });
  const { workspaceId } = await signUpAndCreate(page, "Shot Owner", "Shots Co");
  const [contactId] = await seedContacts(page, workspaceId, [{ name: "Ana Costa", email: "ana@example.com", phone: "+15551230001", company: "Costa Ltd" }]);
  const cfg = await (await page.request.get(`/v1/workspaces/${workspaceId}/pipelines`)).json();
  const lead = await api(page).post(`/v1/workspaces/${workspaceId}/leads`, { title: "Website redesign", primaryContactId: contactId, valueMinor: 120000, currency: "USD" });
  const leadId = lead.ok() ? (await lead.json()).id : null;
  void cfg;
  await page.goto(`/w/${workspaceId}/members`);
  await page.getByRole("button", { name: "Invite people" }).click();
  await page.getByRole("textbox", { name: "Email" }).fill("guest@example.com");
  await page.getByRole("button", { name: "Create invite" }).click();
  await page.getByTestId("invite-link").waitFor();

  const pages: [string, string][] = [
    ["home", ""], ["inbox", "/inbox"], ["contacts", "/contacts"], ["contact-detail", `/contacts/${contactId}`], ["leads", "/leads"],
    ["lead-detail", `/leads/${leadId}`], ["tasks", "/tasks"], ["reports", "/reports"], ["settings", "/settings"], ["settings-general", "/settings"],
    ["settings-ai", "/settings/ai"], ["integrations", "/integrations"], ["ad-measurement", "/settings/ad-measurement"], ["members", "/members"], ["lead-stages", "/settings/pipelines"],
  ];
  for (const [w, h] of [[1440, 900], [375, 812]]) {
    await page.setViewportSize({ width: w!, height: h! });
    for (const [name, path] of pages) {
      await page.goto(`/w/${workspaceId}${path}`);
      await page.waitForLoadState("networkidle");
      await page.screenshot({ path: `${OUT}/${name}-${w}.png`, fullPage: false });
    }
  }
});
