import AxeBuilder from "@axe-core/playwright";
import { devices, expect, test, type Browser, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";
import { addMemberByEmail, register, seedContacts, signUpAndCreate } from "./helpers";

const SHOTS = (process.env.UPDATE_SCREENSHOTS ? join(__dirname, "../../../docs/design/screenshots/notifications") : join(__dirname, "../test-results/shots-notifications")) + "/";
mkdirSync(SHOTS, { recursive: true });
const DB = "postgres://postgres:postgres@127.0.0.1:5436/" + (process.env.CRM_DB_NAME ?? "crm");

/** Test-only: appends a domain event the way emitEvent does (counter bump + insert, one transaction). The API's own dispatcher turns it into notifications. */
async function emit(workspaceId: string, type: string, entityType: string, entityId: string, actorEmail: string | null, payload: Record<string, unknown>) {
  const c = new pg.Client({ connectionString: DB });
  await c.connect();
  try {
    const actor = actorEmail ? (await c.query('SELECT id FROM "user" WHERE email = $1', [actorEmail])).rows[0].id : null;
    await c.query("BEGIN");
    await c.query("INSERT INTO workspace_event_counters(workspace_id,last_seq) VALUES ($1,0) ON CONFLICT DO NOTHING", [workspaceId]);
    const seq = (await c.query("UPDATE workspace_event_counters SET last_seq = last_seq + 1 WHERE workspace_id = $1 RETURNING last_seq", [workspaceId])).rows[0].last_seq;
    await c.query("INSERT INTO domain_events(workspace_id,seq,type,entity_type,entity_id,actor_user_id,payload) VALUES ($1,$2,$3,$4,$5,$6,$7)", [workspaceId, seq, type, entityType, entityId, actor, JSON.stringify(payload)]);
    await c.query("COMMIT");
  } finally {
    await c.end();
  }
}
const userId = async (email: string) => {
  const c = new pg.Client({ connectionString: DB });
  await c.connect();
  const id = (await c.query('SELECT id FROM "user" WHERE email = $1', [email])).rows[0].id as string;
  await c.end();
  return id;
};
const countRows = async (workspaceId: string, uid: string) => {
  const c = new pg.Client({ connectionString: DB });
  await c.connect();
  const n = Number((await c.query("SELECT count(*) FROM notifications WHERE workspace_id = $1 AND user_id = $2", [workspaceId, uid])).rows[0].count);
  await c.end();
  return n;
};
const bulkNotifications = async (workspaceId: string, uid: string, n: number) => {
  const c = new pg.Client({ connectionString: DB });
  await c.connect();
  await c.query("INSERT INTO notifications(workspace_id,user_id,kind,title,dedupe_key) SELECT $1,$2,'task.assigned','Bulk ' || g, 'bulk-' || g FROM generate_series(1,$3) g", [workspaceId, uid, n]);
  await c.end();
};

/** Maya owns the workspace; Sam is an agent in it, signed in in a second browser context. */
async function twoUsers(browser: Browser, label: string) {
  const mayaCtx = await browser.newContext();
  const maya = await mayaCtx.newPage();
  const { email: mayaEmail, workspaceId } = await signUpAndCreate(maya, "Maya Okafor", `${label} Studio`);
  const samCtx = await browser.newContext();
  const sam = await samCtx.newPage();
  const samEmail = await register(sam, "Sam Rivera");
  await addMemberByEmail(workspaceId, samEmail, "agent");
  return { maya, sam, mayaEmail, samEmail, workspaceId, samId: await userId(samEmail), close: async () => { await mayaCtx.close(); await samCtx.close(); } };
}
const badge = (p: Page) => p.getByTestId("unread-badge");

test("bell badge updates through polling in a second browser context, and the count is announced politely", async ({ browser }) => {
  test.setTimeout(120_000);
  const t = await twoUsers(browser, "Poll");
  await t.sam.clock.install(); // lets the test jump past the 30 s poll interval
  await t.sam.goto(`/w/${t.workspaceId}`);
  await expect(t.sam.getByRole("link", { name: "Notifications", exact: true })).toBeVisible();
  await expect(badge(t.sam)).toHaveCount(0);

  await emit(t.workspaceId, "task.assigned", "task", "t-1", t.mayaEmail, { assigneeUserId: t.samId, title: "Call Ana back" });
  await emit(t.workspaceId, "task.assigned", "task", "t-2", t.mayaEmail, { assigneeUserId: t.samId, title: "Send quote" });
  await expect.poll(() => countRows(t.workspaceId, t.samId), { timeout: 15_000 }).toBe(2); // the API's dispatcher did its job
  await t.sam.clock.fastForward(31_000);
  await expect(badge(t.sam)).toHaveText("2");
  await expect(t.sam.getByRole("link", { name: "Notifications, 2 unread" })).toBeVisible();
  await expect(t.sam.getByRole("status").filter({ hasText: "2 unread notifications" })).toHaveCount(1);
  expect(await t.sam.getByRole("status").filter({ hasText: "unread" }).getAttribute("aria-live")).toBe("polite");

  // regaining focus refreshes immediately as well
  await emit(t.workspaceId, "task.assigned", "task", "t-3", t.mayaEmail, { assigneeUserId: t.samId, title: "Prepare contract" });
  await expect.poll(() => countRows(t.workspaceId, t.samId), { timeout: 15_000 }).toBe(3);
  await t.sam.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(badge(t.sam)).toHaveText("3");
  await t.close();
});

test("inbox: unread styling, mark read on click with navigation, mark unread, mark all read, filter, load more", async ({ browser }) => {
  test.setTimeout(120_000);
  const t = await twoUsers(browser, "Inbox");
  const [contactId] = await seedContacts(t.maya, t.workspaceId, [{ name: "Ana Costa", email: "ana@x.example" }]);
  await emit(t.workspaceId, "contact.owner_assigned", "contact", contactId!, t.mayaEmail, { ownerUserId: t.samId, contactName: "Ana Costa" });
  await emit(t.workspaceId, "task.assigned", "task", "t-9", t.mayaEmail, { assigneeUserId: t.samId, title: "Draft proposal" });
  await emit(t.workspaceId, "import.completed", "import", "i-1", null, { importedByUserId: t.samId, created: 4, updated: 1, skipped: 2 });
  await expect.poll(() => countRows(t.workspaceId, t.samId), { timeout: 15_000 }).toBe(3);
  const mayaCount = await countRows(t.workspaceId, await userId(t.mayaEmail));
  expect(mayaCount).toBe(0); // the actor and other members get nothing

  await t.sam.goto(`/w/${t.workspaceId}/notifications`);
  await expect(t.sam.getByRole("heading", { level: 1, name: "Notifications" })).toBeVisible();
  const items = t.sam.locator("li[data-unread]");
  await expect(items).toHaveCount(3);
  await expect(t.sam.locator('li[data-unread="true"]')).toHaveCount(3);
  await expect(items.first()).toContainText("Unread:"); // unread is stated in text, not colour alone
  await expect(items.first()).toContainText("New");
  await expect(t.sam.getByText("4 created, 1 updated, 2 skipped")).toBeVisible();
  await expect(badge(t.sam)).toHaveText("3");
  await t.sam.screenshot({ path: `${SHOTS}inbox-1440.png` });

  // click navigates to the contact and marks it read
  await t.sam.getByRole("link", { name: /Ana Costa was assigned to you/ }).click();
  await t.sam.waitForURL(`**/contacts/${contactId}`);
  await expect(badge(t.sam)).toHaveText("2");
  await t.sam.goBack();
  await expect(t.sam.locator('li[data-unread="true"]')).toHaveCount(2);

  // mark unread again, then mark all read
  await t.sam.getByRole("button", { name: /Mark as unread: Ana Costa was assigned to you/ }).click();
  await expect(t.sam.locator('li[data-unread="true"]')).toHaveCount(3);
  await expect(badge(t.sam)).toHaveText("3");
  await t.sam.getByRole("button", { name: "Mark all as read" }).click();
  await expect(t.sam.locator('li[data-unread="true"]')).toHaveCount(0);
  await expect(badge(t.sam)).toHaveCount(0);
  await expect(t.sam.getByRole("button", { name: "Mark all as read" })).toBeDisabled();

  // unread filter shows the caught-up empty state
  await t.sam.getByRole("button", { name: "Unread", exact: true }).click();
  await expect(t.sam.getByText("You're all caught up")).toBeVisible();
  await t.sam.screenshot({ path: `${SHOTS}empty-unread-1440.png` });
  await t.sam.getByRole("button", { name: "All", exact: true }).click();
  await expect(items).toHaveCount(3);

  // infinite list: "Load more" appends the next page
  await bulkNotifications(t.workspaceId, t.samId, 30);
  await t.sam.reload();
  await expect(items).toHaveCount(20);
  await t.sam.getByRole("button", { name: "Load more" }).click();
  await expect(items).toHaveCount(33);
  await expect(t.sam.getByRole("button", { name: "Load more" })).toHaveCount(0);

  // Maya sees none of Sam's notifications
  await t.maya.goto(`/w/${t.workspaceId}/notifications`);
  await expect(t.maya.getByText("No notifications yet")).toBeVisible();
  await t.maya.screenshot({ path: `${SHOTS}empty-1440.png` });
  await t.close();
});

test("preferences: a muted kind creates no notification, toggles persist and are keyboard operable", async ({ browser }) => {
  test.setTimeout(120_000);
  const t = await twoUsers(browser, "Prefs");
  await t.sam.goto(`/w/${t.workspaceId}/settings/notifications`);
  await expect(t.sam.getByRole("heading", { level: 1, name: "Notification preferences" })).toBeVisible();
  const taskToggle = t.sam.getByRole("checkbox", { name: "Task assigned to you" });
  await expect(taskToggle).toBeChecked();
  await taskToggle.focus();
  await t.sam.keyboard.press("Space");
  await expect(taskToggle).not.toBeChecked();
  await expect(t.sam.getByText("Task assigned to you: off. Saved.")).toBeVisible();
  await t.sam.screenshot({ path: `${SHOTS}preferences-1440.png` });
  await t.sam.reload();
  await expect(t.sam.getByRole("checkbox", { name: "Task assigned to you" })).not.toBeChecked(); // persisted
  await expect(t.sam.getByRole("checkbox", { name: "Import finished" })).toBeChecked();

  await emit(t.workspaceId, "task.assigned", "task", "t-muted", t.mayaEmail, { assigneeUserId: t.samId, title: "Muted task" });
  await emit(t.workspaceId, "import.completed", "import", "i-2", null, { importedByUserId: t.samId, created: 1, updated: 0, skipped: 0 }); // sentinel processed after the muted event
  await expect.poll(() => countRows(t.workspaceId, t.samId), { timeout: 15_000 }).toBe(1);
  await t.sam.goto(`/w/${t.workspaceId}/notifications`);
  await expect(t.sam.getByText("Your contact import finished")).toBeVisible();
  await expect(t.sam.getByText("Muted task")).toHaveCount(0);
  await t.close();
});

const SIZES = [{ name: "375", width: 375, height: 812 }, { name: "768", width: 768, height: 1024 }, { name: "1440", width: 1440, height: 900 }] as const;
const axe = async (page: Page, label: string) => {
  const r = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
  expect(r.violations.map((v) => `${label}: ${v.id} ${JSON.stringify(v.nodes[0]?.target)} ${v.nodes[0]?.html.slice(0, 100)}`)).toEqual([]);
};

test("notification screens hold at 375, 768 and 1440: no overflow, axe clean", async ({ browser }) => {
  test.setTimeout(180_000);
  const t = await twoUsers(browser, "Resp");
  const [contactId] = await seedContacts(t.maya, t.workspaceId, [{ name: "Ana Costa-Montgomery Fitzgerald", email: "ana@x.example" }]);
  await emit(t.workspaceId, "contact.owner_assigned", "contact", contactId!, t.mayaEmail, { ownerUserId: t.samId, contactName: "Ana Costa-Montgomery Fitzgerald" });
  await emit(t.workspaceId, "task.assigned", "task", "t-1", t.mayaEmail, { assigneeUserId: t.samId, title: "Send the revised quote and onboarding schedule to the whole team" });
  await emit(t.workspaceId, "import.completed", "import", "i-1", null, { importedByUserId: t.samId, created: 4, updated: 1, skipped: 2 });
  await expect.poll(() => countRows(t.workspaceId, t.samId), { timeout: 15_000 }).toBe(3);
  await t.sam.goto(`/w/${t.workspaceId}/notifications`);
  await t.sam.locator("li[data-unread]").first().waitFor();
  await t.sam.getByRole("button", { name: /Mark as read: Your contact import finished/ }).click(); // a mix of read and unread
  for (const s of SIZES) {
    await t.sam.setViewportSize({ width: s.width, height: s.height });
    for (const [key, path, heading] of [["inbox", `/w/${t.workspaceId}/notifications`, "Notifications"], ["preferences", `/w/${t.workspaceId}/settings/notifications`, "Notification preferences"]] as const) {
      await t.sam.goto(path);
      await expect(t.sam.getByRole("heading", { level: 1, name: heading })).toBeVisible();
      const w = await t.sam.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }));
      expect(w.scroll, `${key}@${s.name} page scrolls sideways`).toBeLessThanOrEqual(w.client);
      await axe(t.sam, `${key}@${s.name}`);
      await t.sam.screenshot({ path: `${SHOTS}${key}-${s.name}.png` });
    }
  }
  await t.close();
});

const { defaultBrowserType: _browser, ...pixel7 } = devices["Pixel 7"];
test.describe("touch", () => {
  test.use(pixel7);
  test("bell and notification actions are at least 44px", async ({ page }) => {
    const { workspaceId } = await signUpAndCreate(page, "Touch Notif", "Touch Notif Co");
    const email = (await page.evaluate(() => fetch("/v1/me").then((r) => r.json()))).email as string;
    const uid = await userId(email);
    await bulkNotifications(workspaceId, uid, 2);
    await page.goto(`/w/${workspaceId}/notifications`);
    const bell = await page.getByRole("link", { name: /^Notifications/ }).boundingBox();
    expect(bell!.height).toBeGreaterThanOrEqual(44);
    expect(bell!.width).toBeGreaterThanOrEqual(44);
    for (const name of ["Mark all as read", "All", "Unread", /Mark as read: Bulk/]) {
      const b = await page.getByRole("button", { name, exact: typeof name === "string" }).first().boundingBox();
      expect(b!.height, String(name)).toBeGreaterThanOrEqual(44);
    }
    const row = await page.locator("li[data-unread] a, li[data-unread] > button").first().boundingBox();
    expect(row!.height).toBeGreaterThanOrEqual(44);
  });
});
