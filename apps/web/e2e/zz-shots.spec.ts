import { test } from "@playwright/test";
import { api, signUpAndCreate } from "./helpers";

// Throwaway: screenshots for visual review (not committed).
test("shots", async ({ page }) => {
  test.setTimeout(120_000);
  const { workspaceId } = await signUpAndCreate(page, "Shot Owner", "Shot Co");
  const W = `/v1/workspaces/${workspaceId}`;
  const a = api(page);
  const out = "/tmp/am-shots";
  const url = `/w/${workspaceId}/settings/ad-measurement`;
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(url);
  await page.getByRole("heading", { name: "Start with a dataset" }).waitFor();
  await page.screenshot({ path: `${out}/empty-1440.png` });
  await page.setViewportSize({ width: 375, height: 800 });
  await page.screenshot({ path: `${out}/empty-375.png`, fullPage: true });
  const ds = await (await a.post(`${W}/capi/datasets`, { datasetId: `5${Date.now()}`, name: "Main dataset", accessToken: `EAAB-e2e-token-${"z".repeat(40)}`, events: [] })).json();
  const pipe = (await (await a.get(`${W}/pipelines`)).json()).pipelines[0] as { stages: { id: string; kind: string }[] };
  const open = pipe.stages.filter((s) => s.kind === "open");
  const mk = (b: object) => a.post(`${W}/capi/datasets/${ds.id}/mappings`, { stageId: null, valueMode: "none", fixedValueMinor: null, currency: null, enabled: true, askForValue: false, ...b });
  await mk({ triggerType: "lead_created", eventName: "Lead" });
  await mk({ triggerType: "lead_stage_entered", stageId: open[2]!.id, eventName: "Contact" });
  await mk({ triggerType: "lead_stage_entered", stageId: open[2]!.id, eventName: "Schedule" });
  await mk({ triggerType: "lead_stage_entered", stageId: open[1]!.id, eventName: "Qualified_Lead", enabled: false });
  await a.post(`${W}/capi/datasets/${ds.id}/mappings/x`, {});
  for (const w of [1440, 375]) {
    await page.setViewportSize({ width: w, height: 1100 });
    await page.goto(url);
    await page.getByTestId("stage-map").getByText("When a lead is added").waitFor();
    await page.screenshot({ path: `${out}/map-${w}.png`, fullPage: true });
    await page.getByRole("button", { name: /^Event for .*Lead\. Change/ }).first().click();
    await page.waitForTimeout(300);
    await page.screenshot({ path: `${out}/event-pop-${w}.png` });
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: /^Value for Purchase/ }).click();
    await page.waitForTimeout(300);
    await page.screenshot({ path: `${out}/value-pop-${w}.png` });
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: /more rule/ }).click();
    await page.waitForTimeout(300);
    await page.screenshot({ path: `${out}/more-${w}.png` });
    await page.keyboard.press("Escape");
  }
  // dialog
  const won = (pipe.stages.find((s) => s.kind === "won"))!;
  const c = await (await a.post(`${W}/contacts`, { name: "Ana Costa", email: `ana${Date.now()}@example.com`, phone: `+8801711${String(Date.now()).slice(-6)}` })).json();
  await a.post(`${W}/contacts/${c.id}/ad-consent`, { status: "granted", source: "manual" });
  await a.post(`${W}/leads`, { title: "Ana", primaryContactId: c.id });
  const maps = (await (await a.get(`${W}/capi/datasets/${ds.id}/mappings`)).json()).items as { id: string; triggerType: string }[];
  const wm = maps.find((m) => m.triggerType === "lead_won")!;
  await page.request.put(`${W}/capi/datasets/${ds.id}/mappings/${wm.id}`, { data: { triggerType: "lead_won", stageId: null, eventName: "Purchase", valueMode: "lead_value", fixedValueMinor: null, currency: null, enabled: true, askForValue: true }, headers: { origin: `http://localhost:${process.env.E2E_WEB_PORT}` } });
  void wm; void won;
  for (const w of [1440, 375]) {
    await page.setViewportSize({ width: w, height: 800 });
    await page.goto(`/w/${workspaceId}/contacts/${c.id}`);
    await page.getByRole("button", { name: "Won", exact: true }).click();
    await page.getByRole("dialog", { name: "Add a deal value" }).waitFor();
    await page.getByLabel("Deal value").fill("1500");
    await page.waitForTimeout(300);
    await page.screenshot({ path: `${out}/dialog-${w}.png` });
    await page.getByRole("button", { name: "Cancel" }).click();
  }
});
