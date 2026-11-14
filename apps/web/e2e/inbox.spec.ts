import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { addMemberByEmail, createWorkspace } from "./helpers";
import { axe, focusIndicator, person, seed, unreadTotal, WEB } from "./channel-helpers";

/**
 * Inbox Slice 4 end to end, on MOCK fixtures (apps/api/dev/seed-inbox.mts); nothing here proves real Meta behaviour.
 * Needs a fresh database per run: see docs/project/testing-report.md.
 */
test.describe.serial("Inbox (mock fixtures)", () => {
  let owner: { ctx: BrowserContext; page: Page; email: string };
  let agent: { ctx: BrowserContext; page: Page; email: string };
  let outsider: { ctx: BrowserContext; page: Page; email: string };
  let wsInbox = "";
  let wsOutsider = "";
  let ownerTotal = 0;

  test.beforeAll(async ({ browser }) => {
    owner = await person(browser, "Owner One");
    wsInbox = await createWorkspace(owner.page, "Inbox Co");
    agent = await person(browser, "Agent Two");
    await addMemberByEmail(wsInbox, agent.email, "agent");
    outsider = await person(browser, "Outsider Three");
    wsOutsider = await createWorkspace(outsider.page, "Outsider Co");
    seed(wsInbox);
  });
  test.afterAll(async () => {
    await Promise.all([owner?.ctx.close(), agent?.ctx.close(), outsider?.ctx.close()]);
  });

  test("inbox list and unread @1440", async () => {
    const page = owner.page;
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`/w/${wsInbox}/inbox`);
    await expect(page.getByRole("link", { name: /Maria Lopez/ })).toBeVisible();
    ownerTotal = await unreadTotal(page);
    expect(ownerTotal).toBeGreaterThan(0);
    await axe(page, "inbox-list@1440");
    // keyboard reaches the list and shows a focus indicator
    await page.getByRole("link", { name: /Maria Lopez/ }).focus();
    expect(["outline", "ring"]).toContain(await focusIndicator(page));
  });

  test("opening a thread marks it read for this user only (per-user cursor)", async () => {
    const page = owner.page;
    await page.goto(`/w/${wsInbox}/inbox`);
    const before = await unreadTotal(page);
    await page.getByRole("link", { name: /Maria Lopez/ }).click();
    await expect(page).toHaveURL(/\/inbox\/[0-9a-f-]{36}$/);
    await expect(page.getByRole("log", { name: /Messages with Maria Lopez/ })).toContainText("Hi, is the blue one available in size 38?");
    await expect.poll(() => unreadTotal(page), { timeout: 15_000 }).toBeLessThan(before);
    // the agent has an independent cursor: nothing the owner read is read for the agent
    await agent.page.goto(`/w/${wsInbox}/inbox`);
    expect(await unreadTotal(agent.page)).toBe(ownerTotal);
    await agent.page.getByRole("link", { name: /Jon Park/ }).click();
    await expect(agent.page.getByRole("log", { name: /Messages with Jon Park/ })).toBeVisible();
    await expect.poll(() => unreadTotal(agent.page), { timeout: 15_000 }).toBeLessThan(ownerTotal);
    // and the agent reading Jon does not clear the owner's unread for Jon
    await page.goto(`/w/${wsInbox}/inbox`);
    await expect(page.getByRole("link", { name: /Jon Park/ })).toContainText("2 unread");
  });

  test("delivery states are truthful: unknown and failed are never shown as sent", async () => {
    const page = owner.page;
    await page.goto(`/w/${wsInbox}/inbox`);
    await page.getByRole("link", { name: /Lena Fischer/ }).click();
    const log = page.getByRole("log", { name: /Messages with Lena Fischer/ });
    await expect(log).toContainText("Sure, what is the new address?");
    await expect(log.getByText("Delivery unknown")).toBeVisible();
    await expect(log.getByText("Sent", { exact: true })).toHaveCount(0);
    await page.goto(`/w/${wsInbox}/inbox`);
    await page.getByRole("link", { name: /Sofia Rossi/ }).click();
    const log2 = page.getByRole("log", { name: /Messages with Sofia Rossi/ });
    await expect(log2.getByText("Not sent")).toBeVisible();
    await expect(log2.getByText("Sent", { exact: true })).toHaveCount(0);
    await axe(page, "inbox-thread@1440");
  });

  test("status and assignment persist; agents can assign only themselves", async () => {
    const page = owner.page;
    await page.goto(`/w/${wsInbox}/inbox`);
    await page.getByRole("link", { name: /Priya Nair/ }).click();
    await expect(page.getByRole("log", { name: /Messages with Priya Nair/ })).toBeVisible();
    await page.getByLabel("Status").last().selectOption("resolved");
    await page.getByLabel("Assignee").last().selectOption({ label: "Agent Two" });
    await expect(page.getByLabel("Status").last()).toHaveValue("resolved");
    await page.reload();
    await expect(page.getByLabel("Status").last()).toHaveValue("resolved");
    await expect(page.getByLabel("Assignee").last().locator("option:checked")).toHaveText("Agent Two");
    // the resolved conversation leaves the default Open list
    await page.goto(`/w/${wsInbox}/inbox`);
    await expect(page.getByRole("link", { name: /Priya Nair/ })).toHaveCount(0);
    // agent: Priya is assigned to this agent; another conversation may be taken only by themselves
    await agent.page.goto(`/w/${wsInbox}/inbox`);
    await agent.page.getByRole("link", { name: /Carlos Mendes/ }).click();
    await expect(agent.page.getByRole("log", { name: /Messages with Carlos Mendes/ })).toBeVisible();
    // an agent can pick only "Unassigned" or themselves: no other member is selectable
    const selectable = await agent.page.getByLabel("Assignee").last().locator("option:not([disabled])").allTextContents();
    expect(selectable.map((t) => t.trim()).sort()).toEqual(["Me", "Unassigned"]);
    await agent.page.getByLabel("Assignee").last().selectOption({ label: "Me" });
    await agent.page.reload();
    await expect(agent.page.getByLabel("Assignee").last().locator("option:checked")).toHaveText("Me");
  });

  test("mobile 375: single pane with back, no overflow, axe", async () => {
    const page = owner.page;
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto(`/w/${wsInbox}/inbox`);
    await expect(page.getByRole("link", { name: /Maria Lopez/ })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await axe(page, "inbox-list@375");
    await page.getByRole("link", { name: /Maria Lopez/ }).click();
    const back = page.getByRole("link", { name: "Back to inbox" });
    await expect(back).toBeVisible();
    const box = (await back.boundingBox())!;
    expect(Math.min(box.width, box.height)).toBeGreaterThanOrEqual(44);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await axe(page, "inbox-thread@375");
    await back.click();
    await expect(page).toHaveURL(new RegExp(`/w/${wsInbox}/inbox$`));
  });

  // ---------- Tenant isolation ----------
  test("another workspace sees none of this data, through the UI or the API", async () => {
    const page = outsider.page;
    await page.setViewportSize({ width: 1440, height: 900 });
    const get = (p: string) => page.request.get(p);
    // the outsider is not a member of wsInbox: every read is a 404 and reveals nothing
    expect((await get(`/v1/workspaces/${wsInbox}/conversations`)).status()).toBe(404);
    // a conversation id from another workspace is not readable through the outsider's own workspace either
    const owned = await (await owner.page.request.get(`/v1/workspaces/${wsInbox}/conversations`)).json();
    const foreignId = owned.items[0].id as string;
    expect((await get(`/v1/workspaces/${wsOutsider}/conversations/${foreignId}`)).status()).toBe(404);
    expect((await get(`/v1/workspaces/${wsOutsider}/conversations/${foreignId}/messages`)).status()).toBe(404);
    expect((await page.request.post(`/v1/workspaces/${wsOutsider}/conversations/${foreignId}/read`, { data: { upToSeq: 99 }, headers: { origin: WEB } })).status()).toBe(404);
    // own inbox is empty; the foreign thread URL shows nothing of it
    await page.goto(`/w/${wsOutsider}/inbox`);
    await expect(page.getByText("Maria Lopez")).toHaveCount(0);
    await page.goto(`/w/${wsInbox}/inbox/${foreignId}`);
    await expect(page.getByText("Hi, is the blue one available in size 38?")).toHaveCount(0);
  });
});
