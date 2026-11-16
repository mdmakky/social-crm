import { expect, test } from "@playwright/test";
import { addMemberByEmail, api, register, signUpAndCreate } from "./helpers";
import { axe } from "./channel-helpers";

/** Configurable CAPI event mappings (mock mode: nothing reaches Meta). Proves our rules, UI and permissions end to end. Needs E2E_META_MOCK=1 (secret storage + the mock CAPI worker). */
test("rule for a stage: create, a move sends the event, disabled stays silent, test with a lead; viewer cannot edit", async ({ page, browser }) => {
  const { workspaceId } = await signUpAndCreate(page, "Mona Mapper", "Mapping Co");
  const W = `/v1/workspaces/${workspaceId}`;
  const a = api(page);

  // Setup through the API: a dataset (token is sealed server-side), two contacts with consent, a pipeline stage to watch.
  const ds = await a.post(`${W}/capi/datasets`, { datasetId: `7${Date.now()}`, name: "Main dataset", accessToken: `EAAB-e2e-token-${"x".repeat(40)}`, events: [] });
  expect(ds.status()).toBe(201);
  const pipe = (await (await a.get(`${W}/pipelines`)).json()).pipelines[0] as { stages: { id: string; name: string; kind: string }[] };
  const stage = pipe.stages.filter((s) => s.kind === "open")[1]!;
  const lead = async (title: string) => {
    const c = await (await a.post(`${W}/contacts`, { name: `${title} Person`, email: `${title.toLowerCase()}-${Date.now()}@example.com` })).json();
    expect((await a.post(`${W}/contacts/${c.id}/ad-consent`, { status: "granted", source: "manual" })).status()).toBe(200);
    const l = await (await a.post(`${W}/leads`, { title, primaryContactId: c.id, valueMinor: 5000, currency: "USD" })).json();
    return l as { id: string; version: number };
  };
  const moveTo = async (l: { id: string }, stageId: string) => {
    const cur = await (await a.get(`${W}/leads/${l.id}`)).json();
    expect((await a.post(`${W}/leads/${l.id}/move`, { expectedVersion: cur.version, stageId })).status()).toBe(200);
  };

  const rules = page.getByRole("region", { name: "Event rules" });
  const history = page.getByRole("region", { name: "Delivery history" });
  await page.goto(`/w/${workspaceId}/settings/ad-measurement`);

  // The default rule exists (off, the dataset did not opt in) and can be deleted or edited like any other.
  await expect(rules.getByText("A lead is won")).toBeVisible();
  await expect(rules.getByRole("switch", { name: /Off: A lead is won, send Purchase/ })).not.toBeChecked();

  // Add: a lead enters the stage -> Lead, no value. Inline validation first.
  await rules.getByRole("button", { name: "Add rule" }).click();
  const dlg = page.getByRole("dialog", { name: "Add rule" });
  await dlg.getByLabel("When this happens").selectOption("lead_stage_entered");
  await dlg.getByRole("button", { name: "Add rule" }).click();
  await expect(dlg.getByText("Choose the stage.")).toBeVisible();
  await dlg.getByLabel("Stage").selectOption({ label: stage.name });
  await dlg.getByLabel("Send this event").selectOption("Lead");
  await dlg.getByLabel("Value sent").selectOption("none");
  await dlg.getByLabel("Send this event").selectOption("Purchase");
  await expect(dlg.getByLabel("Value sent")).toHaveValue("lead_value"); // a Purchase always carries a value
  await dlg.getByLabel("Send this event").selectOption("__custom");
  await expect(dlg.getByText(/custom event until you set it up/)).toBeVisible();
  await dlg.getByLabel("Custom event name").fill("bad name");
  await dlg.getByRole("button", { name: "Add rule" }).click();
  await expect(dlg.getByText(/Start with a letter/)).toBeVisible();
  await dlg.getByLabel("Send this event").selectOption("Lead");
  await dlg.getByLabel("Value sent").selectOption("none");
  await dlg.getByRole("button", { name: "Add rule" }).click();
  await expect(dlg).toBeHidden();
  const rule = rules.getByRole("listitem").filter({ hasText: `A lead enters ${stage.name}` });
  await expect(rule).toContainText("Lead");
  await expect(rule.getByRole("switch")).toBeChecked();

  // A lead enters the stage: the delivery history shows the event.
  const first = await lead("Alpha");
  await moveTo(first, stage.id);
  await page.reload();
  await expect(history.getByRole("row").filter({ hasText: "Main dataset" })).toHaveCount(1);
  await expect(history.getByRole("row").filter({ hasText: "Lead" })).toHaveCount(1);

  // Test with a lead (nothing queued).
  await rules.getByLabel("Lead", { exact: true }).selectOption({ label: "Alpha (Alpha Person)" });
  const result = rules.getByRole("list", { name: "Test result" });
  await expect(result.getByText("Would send")).toBeVisible();
  await expect(result.getByText("Skipped").first()).toBeVisible();
  await expect(history.getByRole("row").filter({ hasText: "Lead" })).toHaveCount(1);

  // Turn the rule off: the next lead entering the stage sends nothing.
  await rules.getByRole("listitem").filter({ hasText: `A lead enters ${stage.name}` }).getByRole("switch").click(); // controlled: it flips after the server confirms
  await expect(rule.getByRole("switch")).not.toBeChecked();
  const second = await lead("Bravo");
  await moveTo(second, stage.id);
  await page.reload();
  await expect(history.getByRole("row").filter({ hasText: "Lead" })).toHaveCount(1);

  // Layout, a11y.
  for (const w of [375, 768, 1440]) {
    await page.setViewportSize({ width: w, height: 900 });
    await expect(rules.getByRole("heading", { name: "Event rules" })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  }
  await axe(page, "capi event rules");

  // Delete the rule.
  page.once("dialog", (d) => void d.accept());
  await rule.getByRole("button", { name: /Delete rule/ }).click();
  await expect(rule).toHaveCount(0);

  // A viewer sees no rules and the API refuses.
  const ctx = await browser.newContext();
  const vp = await ctx.newPage();
  const email = await register(vp, "Vic Viewer");
  await addMemberByEmail(workspaceId, email, "viewer");
  await vp.goto(`/w/${workspaceId}/settings/ad-measurement`);
  await expect(vp.getByRole("region", { name: "Event rules" })).toHaveCount(0);
  const dsId = (await (await a.get(`${W}/capi/datasets`)).json()).items[0].id as string;
  const body = { triggerType: "lead_created", stageId: null, eventName: "Lead", valueMode: "none", fixedValueMinor: null, currency: null, enabled: true };
  expect((await api(vp).post(`${W}/capi/datasets/${dsId}/mappings`, body)).status()).toBe(403);
  expect((await api(vp).get(`${W}/capi/datasets/${dsId}/mappings`)).status()).toBe(403);
  await ctx.close();
});
