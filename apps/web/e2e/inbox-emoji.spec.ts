import { createHmac } from "node:crypto";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import pg from "pg";
import { createWorkspace } from "./helpers";
import { DB, person } from "./channel-helpers";

/**
 * Emoji in conversation bubbles, list rows and avatars, through the real ingress on MOCK Meta (signed Messenger webhooks, real worker, real UI).
 * The bubble is platform-independent (it never branches on platform); the Instagram and WhatsApp parsers are covered in packages/integrations/test/emoji-parse.test.ts.
 * Run with E2E_META_MOCK=1 on a fresh database (docs/project/testing-report.md).
 */
const API = `http://localhost:${process.env.E2E_API_PORT ?? "8791"}`;
const APP_SECRET = "e2e-mock-app-secret-0123456789";
const digits = () => `8${Math.floor(Math.random() * 1e12).toString().padStart(12, "0")}`;
test.skip(process.env.E2E_META_MOCK !== "1", "needs the mock Meta API (E2E_META_MOCK=1)");

/** Every message is sent exactly as written; the UI must show exactly these strings. */
export const CASES: Record<string, string> = {
  standard: "Hello 😀 world 🎉 great 👍",
  skinTone: "Thanks 👍🏽 and 🙏🏿 and 👋🏻 and 🤙🏼",
  zwjFamily: "Family 👨‍👩‍👧‍👦 and 👩🏽‍💻 and 🏳️‍🌈 and 🧑‍🤝‍🧑",
  flags: "Flags 🇧🇩 🇺🇸 🇬🇧 🏴󠁧󠁢󠁥󠁮󠁧󠁿 done",
  variation: "Hearts ❤️ ☀️ ✌️ ✔️ ©️ and keycaps #️⃣ 1️⃣ 9️⃣",
  banglaMixed: "ধন্যবাদ 🙏 আপনাকে! Order #4821 কনফার্ম ✅ thanks 😊 আবার আসবেন",
  start: "😀 at the start",
  middle: "in the 😀 middle",
  end: "at the end 😀",
  onlyEmoji: "😍",
  many: "😀😃😄😁😆😅🤣😂🙂🙃😉😊😇🥰😍🤩😘😗😚😙",
  multiline: "line one 😀\nলাইন দুই 🙏\n\n🇧🇩 line four\n👨‍👩‍👧‍👦",
  longRun: "👨‍👩‍👧‍👦".repeat(24),
};
const CONTACT = "🌸 Sara Ahmed";

test.describe.serial("emoji rendering in the Inbox (mock Meta)", () => {
  let owner: { ctx: BrowserContext; page: Page; email: string };
  let db: pg.Client;
  let ws = "";
  let convUrl = "";
  const q = async (text: string, params: unknown[] = []) => (await db.query(text, params)).rows;

  test.beforeAll(async ({ browser }) => {
    db = new pg.Client({ connectionString: `postgres://postgres:postgres@127.0.0.1:5436/${DB}` });
    await db.connect();
    owner = await person(browser, "Owner One");
    ws = await createWorkspace(owner.page, "Emoji Co");
    const pageId = digits();
    const user = digits();
    await q("INSERT INTO integration_accounts (workspace_id, platform, external_account_id, status, display_name) VALUES ($1,'messenger',$2,'connected','Emoji page')", [ws, pageId]);
    for (const text of Object.values(CASES)) {
      const body = JSON.stringify({ object: "page", entry: [{ id: pageId, time: Date.now(), messaging: [{ sender: { id: user }, recipient: { id: pageId }, timestamp: Date.now(), message: { mid: `m_${digits()}`, text } }] }] });
      const sig = "sha256=" + createHmac("sha256", APP_SECRET).update(body).digest("hex");
      const res = await fetch(`${API}/webhooks/meta/messenger`, { method: "POST", headers: { "content-type": "application/json", "x-hub-signature-256": sig }, body });
      expect(res.status).toBe(200);
    }
    await expect.poll(async () => Number((await q("SELECT count(*) FROM messages m JOIN conversations c ON c.id = m.conversation_id WHERE c.workspace_id = $1", [ws]))[0].count), { timeout: 30_000 }).toBe(Object.keys(CASES).length);
    await q("UPDATE contacts SET name = $2 WHERE workspace_id = $1", [ws, CONTACT]);
    const conv = (await q("SELECT id FROM conversations WHERE workspace_id = $1", [ws]))[0].id as string;
    convUrl = `/w/${ws}/inbox/${conv}`;
  });
  test.afterAll(async () => { await owner?.ctx.close(); await db?.end(); });

  /** Text exactly as the database holds it must come back from the browser untouched. */
  test("the stored text is byte-identical to what was sent (no normalising, no replacement characters)", async () => {
    const rows = await q("SELECT body FROM messages m JOIN conversations c ON c.id = m.conversation_id WHERE c.workspace_id = $1", [ws]);
    expect(rows.map((r) => r.body as string).sort()).toEqual(Object.values(CASES).slice().sort());
  });

  for (const [label, vp] of [["1440", { width: 1440, height: 900 }], ["390 phone", { width: 390, height: 844 }]] as const) {
    test(`bubbles show every message exactly, wrapped inside the bubble, at ${label}`, async () => {
      const page = owner.page;
      await page.setViewportSize(vp);
      await page.goto(convUrl);
      const log = page.getByRole("log");
      await expect(log).toBeVisible();
      for (const [name, text] of Object.entries(CASES)) {

        const hit = await log.locator("p.whitespace-pre-wrap").evaluateAll((els, want) => els.map((e) => e.textContent).filter((t) => t === want).length, text);
        expect(hit, `${name}: bubble text differs from what was sent`).toBe(1);

      }
      // nothing escapes its bubble or the page
      const overflow = await log.locator("p.whitespace-pre-wrap").evaluateAll((els) => els.filter((e) => e.scrollWidth > e.clientWidth + 1).map((e) => (e.textContent ?? "").slice(0, 20)));
      expect(overflow, "a bubble is wider than its box").toEqual([]);
      expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
      const bad = await page.evaluate(() => /�|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(document.body.innerText));
      expect(bad, "page text has a replacement character or a lone surrogate").toBe(false);
      await page.screenshot({ path: `test-results/emoji-thread-${label.split(" ")[0]}.png` });
    });
  }

  test("the list row and the avatar handle an emoji at the start of a name and in the preview", async () => {
    const page = owner.page;
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`/w/${ws}/inbox`);
    const row = page.getByRole("link", { name: new RegExp(CONTACT) });
    await expect(row).toBeVisible();
    const initialsAttr = await row.locator("[data-initials]").first().getAttribute("data-initials");
    expect(initialsAttr, "avatar initials").not.toMatch(/�|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
    expect(initialsAttr).toBe("🌸A");
    await page.screenshot({ path: "test-results/emoji-list-1440.png" });
  });
});
