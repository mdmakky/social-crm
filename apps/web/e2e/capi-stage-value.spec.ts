import { expect, test, type Page } from "@playwright/test";
import { addMemberByEmail, api, register, signUpAndCreate } from "./helpers";
import { axe } from "./channel-helpers";

/**
 * "Ask if missing": a stage change that fires an ad rule needing a deal value the lead lacks opens the deal-value dialog (D330-D339).
 * Mock mode: the queue and delivery history are checked, nothing reaches Meta. Needs E2E_META_MOCK=1.
 */
const noSideScroll = (p: Page) => p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
let seq = 0;

test("configure Purchase on Won with ask, then move from the list and the lead page: dialog, Save and move, Move without value, Cancel, conflict, bulk, no-permission agent, phone layout, axe", async ({ page, browser }) => {
  test.setTimeout(240_000);
  const { workspaceId } = await signUpAndCreate(page, "Val Owner", "Value Co");
  const W = `/v1/workspaces/${workspaceId}`;
  const a = api(page);
  const ds = await a.post(`${W}/capi/datasets`, { datasetId: `6${Date.now()}`, name: "Main dataset", accessToken: `EAAB-e2e-token-${"y".repeat(40)}`, events: [] });
  expect(ds.status()).toBe(201);
  const dsId = (await ds.json()).id as string;
  const pipe = (await (await a.get(`${W}/pipelines`)).json()).pipelines[0] as { stages: { id: string; name: string; kind: string }[] };
  const won = pipe.stages.find((s) => s.kind === "won")!;
  const mk = async (name: string) => {
    const c = await (await a.post(`${W}/contacts`, { name, email: `v${seq++}-${Date.now()}@example.com`, phone: `+8801711${String(Date.now() + seq).slice(-6)}` })).json();
    expect((await a.post(`${W}/contacts/${c.id}/ad-consent`, { status: "granted", source: "manual" })).status()).toBe(200);
    const l = await (await a.post(`${W}/leads`, { title: name, primaryContactId: c.id })).json();
    return { contactId: c.id as string, leadId: l.id as string };
  };
  const leadOf = async (id: string) => (await (await a.get(`${W}/leads/${id}`)).json()) as { stageId: string; valueMinor: number | null; currency: string | null; version: number };
  const events = async () => (await (await a.get(`${W}/capi/events?limit=100`)).json()).items as { eventName: string; status: string; lastError: string | null }[];

  // Configure on the page: Purchase on the Won row defaults to "ask if missing".
  await page.goto(`/w/${workspaceId}/settings/ad-measurement`);
  const wonRow = page.getByTestId("stage-map").getByRole("listitem").filter({ has: page.getByRole("button", { name: new RegExp(`Event for ${won.name}`) }) });
  await wonRow.getByRole("switch").click(); // the seeded default Purchase rule is off: switch it on
  await expect(wonRow.getByRole("switch", { name: /^On: Purchase/ })).toHaveAttribute("aria-checked", "true");
  await wonRow.getByRole("button", { name: /^Value for Purchase/ }).click();
  await page.getByRole("dialog", { name: "Value for Purchase" }).getByRole("button", { name: /Deal value, ask if missing/ }).click();
  await expect.poll(async () => ((await (await a.get(`${W}/capi/datasets/${dsId}/mappings`)).json()).items as { askForValue: boolean; enabled: boolean }[]).filter((m) => m.askForValue && m.enabled).length).toBe(1);

  const ana = await mk("Ana Costa");
  const ben = await mk("Ben Okafor");
  const cy = await mk("Cy Dalton");
  const dee = await mk("Dee Evans");

  // 1. Leads list menu: the dialog explains, shows what will be sent, Cancel leaves everything as it was.
  await page.goto(`/w/${workspaceId}/contacts`);
  await page.getByRole("button", { name: /^Stage of Ana Costa:/ }).click();
  await page.getByRole("menuitem", { name: won.name }).click();
  const dlg = page.getByRole("dialog", { name: "Add a deal value" });
  await expect(dlg).toBeVisible();
  await expect(dlg).toContainText("Moving Ana Costa to");
  await expect(dlg).toContainText("sends Purchase to Meta, and Purchase needs a value.");
  await expect(dlg.getByText("Granted, will be sent")).toBeVisible();
  await expect(dlg.getByText("MOCK")).toBeVisible();
  await axe(page, "deal value dialog 1440");
  await dlg.getByRole("button", { name: "Cancel" }).click();
  await expect(dlg).toBeHidden();
  expect((await leadOf(ana.leadId)).stageId).not.toBe(won.id);
  expect((await events()).filter((e) => e.eventName === "Purchase")).toHaveLength(0);

  // 2. Move without value: the lead moves, the event is recorded as skipped (no value).
  await page.getByRole("button", { name: /^Stage of Ana Costa:/ }).click();
  await page.getByRole("menuitem", { name: won.name }).click();
  await page.getByRole("dialog", { name: "Add a deal value" }).getByRole("button", { name: "Move without value" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Ana Costa is now" }).first()).toContainText("the ad event was skipped");
  expect((await leadOf(ana.leadId)).stageId).toBe(won.id);
  await expect.poll(async () => (await events()).filter((e) => e.eventName === "Purchase" && e.status === "skipped" && e.lastError === "no_value").length).toBe(1);

  // 3. Save and move: validation first, then the lead has the value and a Purchase is queued in the same step.
  await page.getByRole("button", { name: /^Stage of Ben Okafor:/ }).click();
  await page.getByRole("menuitem", { name: won.name }).click();
  const d2 = page.getByRole("dialog", { name: "Add a deal value" });
  await d2.getByRole("button", { name: "Save and move" }).click();
  await expect(d2.getByText("Enter an amount above 0.")).toBeVisible();
  await d2.getByLabel("Deal value").fill("12.345");
  await d2.getByRole("button", { name: "Save and move" }).click();
  await expect(d2.getByText("USD allows at most 2 decimals.")).toBeVisible();
  await d2.getByLabel("Deal value").fill("1,500.50");
  await expect(d2.getByText("$1,500.50")).toBeVisible(); // the "what will be sent" block follows what is typed
  await d2.getByRole("button", { name: "Save and move" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Ben Okafor is now" }).first()).toBeVisible();
  const b = await leadOf(ben.leadId);
  expect(b).toMatchObject({ stageId: won.id, valueMinor: 150050, currency: "USD" });
  await expect.poll(async () => (await events()).filter((e) => e.eventName === "Purchase" && (e.status === "pending" || e.status === "sent")).length).toBe(1);

  // 4. The lead page stepper (Won button), and a stale version: someone else changed the lead while the dialog was open.
  await page.goto(`/w/${workspaceId}/contacts/${cy.contactId}`);
  await page.getByRole("button", { name: won.name, exact: true }).click();
  const d3 = page.getByRole("dialog", { name: "Add a deal value" });
  await expect(d3).toBeVisible();
  const cur = await leadOf(cy.leadId);
  expect((await a.patch(`${W}/leads/${cy.leadId}`, { expectedVersion: cur.version, title: "Cy renamed" })).status()).toBe(200);
  await d3.getByLabel("Deal value").fill("80");
  await d3.getByRole("button", { name: "Save and move" }).click();
  await expect(page.getByText(/changed by someone else|Someone else changed/i).first()).toBeVisible();
  expect((await leadOf(cy.leadId)).stageId).not.toBe(won.id);
  await page.reload();
  await page.getByRole("button", { name: won.name, exact: true }).click();
  await page.getByRole("dialog", { name: "Add a deal value" }).getByLabel("Deal value").fill("80");
  await page.getByRole("dialog", { name: "Add a deal value" }).getByRole("button", { name: "Save and move" }).click();
  await expect.poll(async () => (await leadOf(cy.leadId)).valueMinor).toBe(8000);
  expect((await leadOf(cy.leadId)).stageId).toBe(won.id);

  // 5. Phone: the dialog is a bottom sheet, targets are big, nothing scrolls sideways, axe is clean (375 and 320).
  for (const w of [375, 320]) {
    await page.setViewportSize({ width: w, height: 760 });
    await page.goto(`/w/${workspaceId}/contacts/${dee.contactId}`);
    await page.getByRole("button", { name: won.name, exact: true }).click();
    const sheet = page.getByRole("dialog", { name: "Add a deal value" });
    await expect(sheet).toBeVisible();
    const box = (await sheet.boundingBox())!;
    expect(box.y + box.height).toBeGreaterThan(740); // anchored to the bottom
    for (const n of ["Save and move", "Move without value", "Cancel"]) expect((await sheet.getByRole("button", { name: n }).boundingBox())!.height).toBeGreaterThanOrEqual(43);
    expect(await noSideScroll(page)).toBe(true);
    if (w === 375) await axe(page, "deal value dialog 375");
    await sheet.getByRole("button", { name: "Cancel" }).click();
  }
  await page.setViewportSize({ width: 768, height: 900 });
  await page.getByRole("button", { name: won.name, exact: true }).click();
  await axe(page, "deal value dialog 768");
  await page.getByRole("dialog", { name: "Add a deal value" }).getByRole("button", { name: "Cancel" }).click();
  await page.setViewportSize({ width: 1440, height: 900 });

  // 6. Bulk: no popup per lead. Leads that needed a value move anyway, their events are skipped, and the message says how many and how to fix it.
  const eli = await mk("Eli Fox");
  const fay = await mk("Fay Gray");
  await page.goto(`/w/${workspaceId}/contacts`);
  await page.getByLabel("Select Eli Fox").check();
  await page.getByLabel("Select Fay Gray").check();
  await page.getByRole("button", { name: "Change stage", exact: true }).click();
  const bulk = page.getByRole("dialog", { name: /Change stage of 2 leads/ });
  await bulk.getByLabel("New stage").selectOption({ label: won.name });
  await bulk.getByRole("button", { name: "Move 2 leads" }).click();
  await expect(page.getByRole("dialog", { name: "Add a deal value" })).toHaveCount(0);
  await expect(page.getByRole("status").filter({ hasText: "2 leads moved" }).first()).toContainText("2 had no deal value");
  expect((await leadOf(eli.leadId)).stageId).toBe(won.id);
  expect((await leadOf(fay.leadId)).stageId).toBe(won.id);

  // 7. An agent without access to the value: the dialog says an owner or admin must add it; only "Move without value" and Cancel.
  const gus = await mk("Gus Hill");
  const ctx = await browser.newContext();
  const ap = await ctx.newPage();
  const email = await register(ap, "Agent Ann");
  await addMemberByEmail(workspaceId, email, "agent");
  await ap.goto(`/w/${workspaceId}/contacts`);
  await ap.getByRole("button", { name: /^Stage of Gus Hill:/ }).click();
  await ap.getByRole("menuitem", { name: won.name }).click();
  const ad = ap.getByRole("dialog", { name: "Add a deal value" });
  await expect(ad).toContainText("An owner or admin needs to add it on the lead");
  await expect(ad.getByLabel("Deal value")).toHaveCount(0);
  await expect(ad.getByRole("button", { name: "Save and move" })).toHaveCount(0);
  await ad.getByRole("button", { name: "Cancel" }).click();
  expect((await leadOf(gus.leadId)).stageId).not.toBe(won.id);
  await ap.getByRole("button", { name: /^Stage of Gus Hill:/ }).click();
  await ap.getByRole("menuitem", { name: won.name }).click();
  await ap.getByRole("dialog", { name: "Add a deal value" }).getByRole("button", { name: "Move without value" }).click();
  await expect.poll(async () => (await leadOf(gus.leadId)).stageId).toBe(won.id);
  expect((await leadOf(gus.leadId)).valueMinor).toBeNull();
  await ctx.close();
});
