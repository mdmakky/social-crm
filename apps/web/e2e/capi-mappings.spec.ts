import { expect, test, type Locator, type Page } from "@playwright/test";
import { addMemberByEmail, api, register, signUpAndCreate } from "./helpers";
import { axe } from "./channel-helpers";

/**
 * The Ad measurement stage map (mock mode: nothing reaches Meta). Which stage sends which event is configured on the page, per workspace, through the normal rules API.
 * Needs E2E_META_MOCK=1 (secret storage + the mock CAPI worker). Replaces the old rule-list spec: same ground (create, send, off, test with a lead, delete, viewer refused), new UI.
 */
const noSideScroll = (p: Page) => p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);

test("stage map: empty state, choose events from the page, a move sends, off stays silent, +N more, layouts and axe, viewer refused", async ({ page, browser }) => {
  const { workspaceId } = await signUpAndCreate(page, "Mona Mapper", "Mapping Co");
  const W = `/v1/workspaces/${workspaceId}`;
  const a = api(page);
  const url = `/w/${workspaceId}/settings/ad-measurement`;

  // No dataset yet: the three-step card, the connect form is the first step.
  await page.goto(url);
  await expect(page.getByRole("heading", { name: "Start with a dataset" })).toBeVisible();
  await expect(page.getByText("Locked until a dataset is connected.")).toBeVisible();
  await expect(page.getByRole("form", { name: "Connect a dataset" })).toBeVisible();
  await axe(page, "ad measurement empty");

  // Connect through the API (the token is sealed server-side), two contacts with consent.
  const ds = await a.post(`${W}/capi/datasets`, { datasetId: `7${Date.now()}`, name: "Main dataset", accessToken: `EAAB-e2e-token-${"x".repeat(40)}`, events: [] });
  expect(ds.status()).toBe(201);
  const dsId = (await ds.json()).id as string;
  const pipe = (await (await a.get(`${W}/pipelines`)).json()).pipelines[0] as { stages: { id: string; name: string; kind: string }[] };
  const stage = pipe.stages.filter((s) => s.kind === "open")[1]!;
  const lead = async (title: string) => {
    const c = await (await a.post(`${W}/contacts`, { name: `${title} Person`, email: `${title.toLowerCase()}-${Date.now()}@example.com`, phone: `+8801711${String(Date.now()).slice(-6)}` })).json();
    expect((await a.post(`${W}/contacts/${c.id}/ad-consent`, { status: "granted", source: "manual" })).status()).toBe(200);
    return (await (await a.post(`${W}/leads`, { title, primaryContactId: c.id, valueMinor: 5000, currency: "USD" })).json()) as { id: string };
  };
  const moveTo = async (l: { id: string }, stageId: string) => {
    const cur = await (await a.get(`${W}/leads/${l.id}`)).json();
    expect((await a.post(`${W}/leads/${l.id}/move`, { expectedVersion: cur.version, stageId })).status()).toBe(200);
  };
  const rulesApi = async () => (await (await a.get(`${W}/capi/datasets/${dsId}/mappings`)).json()).items as { id: string; triggerType: string; stageId: string | null; eventName: string; valueMode: string; askForValue: boolean; enabled: boolean }[];

  await page.reload();
  const map = page.getByTestId("stage-map");
  const history = page.getByRole("region", { name: "Delivery history" });
  const row = (label: string): Locator => map.getByRole("listitem").filter({ has: page.getByRole("button", { name: new RegExp(`(Event for|Add an event for) ${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`) }) });
  await expect(page.getByText("MOCK").first()).toBeVisible();
  await expect(page.getByText("Not tested live")).toBeVisible();
  await expect(page.getByRole("combobox", { name: "Dataset" })).toBeVisible();

  // The seeded default (lead won -> Purchase) is on its own row, off, and one row exists per open stage plus "when a lead is added".
  await expect(map.getByText("When a lead is added")).toBeVisible();
  for (const s of pipe.stages.filter((x) => x.kind === "open")) await expect(row(s.name)).toHaveCount(1);
  const won = pipe.stages.find((s) => s.kind === "won")!;
  await expect(row(won.name).getByRole("switch", { name: /^Off: Purchase/ })).toHaveAttribute("aria-checked", "false");
  await expect(map.getByText("FINAL STAGES")).toBeVisible();
  await expect(map.getByLabel("What gets sent")).toContainText("Nothing yet");

  // Choose an event on a stage: Lead, no value. The picker validates custom names and refuses PageView.
  await row(stage.name).getByRole("button", { name: `Add an event for ${stage.name}` }).click();
  const pop = page.getByRole("dialog", { name: `Event for ${stage.name}` });
  await pop.getByLabel("Custom event").fill("bad name");
  await pop.getByRole("button", { name: "Use" }).click();
  await expect(pop.getByText(/Start with a letter/)).toBeVisible();
  await pop.getByLabel("Custom event").fill("PageView");
  await pop.getByRole("button", { name: "Use" }).click();
  await expect(pop.getByText("PageView is sent by your website Pixel, not the CRM.")).toBeVisible();
  await expect(pop.getByText(/custom event until you set it up/)).toBeVisible();
  await pop.getByRole("button", { name: /^Lead\b/ }).click();
  await expect(pop).toBeHidden();
  await expect(page.getByRole("button", { name: `Event for ${stage.name}: Lead. Change` })).toBeFocused(); // focus returns to the chip
  await expect(map.getByText("Saved")).toBeVisible();
  let r = (await rulesApi()).find((x) => x.stageId === stage.id)!;
  expect(r).toMatchObject({ triggerType: "lead_stage_entered", eventName: "Lead", valueMode: "none", enabled: true });
  await expect(map.getByLabel("What gets sent")).toContainText("Lead");

  // Won row: turn the default Purchase on, then set its value mode. "No value" is not allowed for a Purchase.
  await row(won.name).getByRole("switch", { name: /Purchase/ }).click();
  await expect(row(won.name).getByRole("switch", { name: /^On: Purchase/ })).toHaveAttribute("aria-checked", "true");
  await row(won.name).getByRole("button", { name: /^Value for Purchase/ }).click();
  const vp = page.getByRole("dialog", { name: "Value for Purchase" });
  await expect(vp.getByRole("button", { name: /^No value/ })).toBeDisabled();
  await vp.getByRole("button", { name: /Deal value, ask if missing/ }).click();
  await expect.poll(async () => (await rulesApi()).find((x) => x.triggerType === "lead_won")!.askForValue).toBe(true);
  await row(won.name).getByRole("button", { name: /^Value for Purchase/ }).click();
  await page.getByRole("dialog", { name: "Value for Purchase" }).getByRole("button", { name: /Fixed amount/ }).click();
  const fx = page.getByRole("dialog", { name: "Value for Purchase" });
  await fx.getByLabel("Fixed amount").fill("");
  await fx.getByRole("button", { name: "Use this amount" }).click();
  await expect(fx.getByText("Enter an amount, for example 25.")).toBeVisible();
  await fx.getByLabel("Fixed amount").fill("25");
  await fx.getByRole("button", { name: "Use this amount" }).click();
  await expect.poll(async () => (await rulesApi()).find((x) => x.triggerType === "lead_won")!).toMatchObject({ valueMode: "fixed", askForValue: false });
  await row(won.name).getByRole("button", { name: /^Value for Purchase/ }).click();
  await page.getByRole("dialog", { name: "Value for Purchase" }).getByRole("button", { name: /Deal value, skip if missing/ }).click();
  await expect.poll(async () => (await rulesApi()).find((x) => x.triggerType === "lead_won")).toMatchObject({ valueMode: "lead_value", askForValue: false });

  // A lead enters the stage: the delivery history shows the event.
  const first = await lead("Alpha");
  await moveTo(first, stage.id);
  await page.reload();
  await expect(history.getByRole("row").filter({ hasText: "Main dataset" })).toHaveCount(1);
  await expect(history.getByRole("row").filter({ hasText: "Lead" })).toHaveCount(1);

  // Test with a lead (nothing queued).
  await page.getByText("Test with a lead").click();
  await page.getByLabel("Lead", { exact: true }).selectOption({ label: "Alpha (Alpha Person)" });
  const result = page.getByRole("list", { name: "Test result" });
  await expect(result.getByText("Would send").first()).toBeVisible();
  await expect(history.getByRole("row").filter({ hasText: "Lead" })).toHaveCount(1);

  // Off: the next lead entering the stage sends nothing.
  await row(stage.name).getByRole("switch", { name: /^On: Lead/ }).click();
  await expect(row(stage.name).getByRole("switch", { name: /^Off: Lead/ })).toHaveAttribute("aria-checked", "false");
  await expect.poll(async () => (await rulesApi()).find((x) => x.stageId === stage.id)!.enabled).toBe(false);
  await moveTo(await lead("Bravo"), stage.id);
  await page.reload();
  await expect(history.getByRole("row").filter({ hasText: "Lead" })).toHaveCount(1);

  // More than one rule on one stage (only possible through the API): the first shows, "+1 more" lists every rule so nothing is hidden.
  expect((await a.post(`${W}/capi/datasets/${dsId}/mappings`, { triggerType: "lead_stage_entered", stageId: stage.id, eventName: "Contact", valueMode: "none", fixedValueMinor: null, currency: null, enabled: true, askForValue: false })).status()).toBe(201);
  await page.reload();
  const more = row(stage.name).getByRole("button", { name: /1 more rule for/ });
  await expect(more).toHaveText("+1 more");
  await more.click();
  const all = page.getByRole("dialog", { name: `All rules for ${stage.name}` });
  await expect(all.getByRole("listitem")).toHaveCount(2);
  await all.getByRole("switch", { name: /Contact/ }).click();
  await expect.poll(async () => (await rulesApi()).find((x) => x.eventName === "Contact")!.enabled).toBe(false);
  await page.keyboard.press("Escape");
  await expect(all).toBeHidden();
  await expect(more).toBeFocused();
  await more.click();
  page.once("dialog", (d) => void d.accept());
  await page.getByRole("dialog", { name: `All rules for ${stage.name}` }).getByRole("button", { name: "Remove Contact" }).click();
  await expect.poll(async () => (await rulesApi()).filter((x) => x.stageId === stage.id).length).toBe(1);

  // Layout and a11y: no sideways scroll, axe clean, with a picker open as well.
  for (const w of [1440, 768, 375, 320]) {
    await page.setViewportSize({ width: w, height: 900 });
    await expect(map.getByText("When a lead is added")).toBeVisible();
    expect(await noSideScroll(page), `no horizontal scroll at ${w}`).toBe(true);
  }
  for (const w of [1440, 768, 375]) {
    await page.setViewportSize({ width: w, height: 900 });
    await axe(page, `ad measurement ${w}`);
  }
  await page.getByRole("button", { name: `Event for ${stage.name}: Lead. Change` }).click();
  await axe(page, "ad measurement event picker 375");
  await page.keyboard.press("Escape");

  // Remove the event from a stage with "Don't send anything".
  await page.setViewportSize({ width: 1440, height: 900 });
  await row(stage.name).getByRole("button", { name: `Event for ${stage.name}: Lead. Change` }).click();
  await page.getByRole("dialog", { name: `Event for ${stage.name}` }).getByRole("button", { name: /Don't send anything/ }).click();
  await expect.poll(async () => (await rulesApi()).filter((x) => x.stageId === stage.id).length).toBe(0);

  // A viewer sees no map and the API refuses.
  const ctx = await browser.newContext();
  const v = await ctx.newPage();
  const email = await register(v, "Vic Viewer");
  await addMemberByEmail(workspaceId, email, "viewer");
  await v.goto(url);
  await expect(v.getByTestId("stage-map")).toHaveCount(0);
  await expect(v.getByText("Only owners and admins can manage ad measurement.")).toBeVisible();
  const body = { triggerType: "lead_created", stageId: null, eventName: "Lead", valueMode: "none", fixedValueMinor: null, currency: null, enabled: true, askForValue: false };
  expect((await api(v).post(`${W}/capi/datasets/${dsId}/mappings`, body)).status()).toBe(403);
  expect((await api(v).get(`${W}/capi/datasets/${dsId}/mappings`)).status()).toBe(403);
  await ctx.close();
});
