import { createHmac } from "node:crypto";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { addMemberByEmail, createWorkspace } from "./helpers";
import { axe, person, WEB } from "./channel-helpers";

/**
 * Inbox attachments end to end, MOCK only: mock Meta (webhook with the mock app secret, mock Graph), a mock download network that answers with a 1x1 PNG, a local temp blob directory and the offline mock AI provider.
 * Nothing here proves real Meta, real channel media or real storage behaviour (all UNVERIFIED). Run on a fresh private database with E2E_META_MOCK=1 and STORAGE_DRIVER=local (see docs/project/testing-report.md).
 */
const API = `http://localhost:${process.env.E2E_API_PORT ?? "8791"}`;
const ORIGIN = WEB;
const WA_TOKEN = "mock-system-user-token-" + "0".repeat(24);
const APP_SECRET = "e2e-mock-app-secret-0123456789";
const PHONE_NUMBER_ID = "300000000000001";
const FROM = "15551230001";
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

test.describe.serial("Inbox attachments (mock)", () => {
  let owner: { ctx: BrowserContext; page: Page; email: string };
  let viewer: { ctx: BrowserContext; page: Page; email: string };
  let outsider: { ctx: BrowserContext; page: Page; email: string };
  let ws = "";
  let wsOut = "";
  let conv = "";
  let imageId = "";
  const base = () => `/v1/workspaces/${ws}/conversations/${conv}/attachments`;

  async function webhook(page: Page, message: Record<string, unknown>) {
    const body = { object: "whatsapp_business_account", entry: [{ id: "200000000000001", changes: [{ field: "messages", value: { messaging_product: "whatsapp", metadata: { display_phone_number: "15550100001", phone_number_id: PHONE_NUMBER_ID }, messages: [{ from: FROM, timestamp: String(Math.floor(Date.now() / 1000)), ...message }] } }] }] };
    const raw = Buffer.from(JSON.stringify(body));
    const res = await page.request.post(`${API}/webhooks/meta/whatsapp`, { data: raw, headers: { "content-type": "application/json", "x-hub-signature-256": `sha256=${createHmac("sha256", APP_SECRET).update(raw).digest("hex")}` } });
    expect(res.status()).toBe(200);
  }
  const list = async (page: Page) => (await (await page.request.get(base())).json()) as { items: { id: string; status: string; kind: string; direction: string; errorCode: string | null }[]; storageConfigured: boolean };

  test.beforeAll(async ({ browser }) => {
    owner = await person(browser, "Olga Owner");
    ws = await createWorkspace(owner.page, "Attach Co");
    viewer = await person(browser, "Vera Viewer");
    await addMemberByEmail(ws, viewer.email, "viewer");
    outsider = await person(browser, "Otto Outsider");
    wsOut = await createWorkspace(outsider.page, "Other Co");

    // Mock WhatsApp number, mock AI provider.
    const post = (path: string, data: unknown) => owner.page.request.post(path, { data, headers: { origin: ORIGIN } });
    expect((await post(`/v1/workspaces/${ws}/integrations/whatsapp/connect`, { wabaId: "200000000000001", phoneNumberId: PHONE_NUMBER_ID, accessToken: WA_TOKEN })).status()).toBeLessThan(300);
    expect((await owner.page.request.put(`/v1/workspaces/${ws}/ai/providers/mock`, { data: { isDefault: true }, headers: { origin: ORIGIN } })).status()).toBe(200);

    // Inbound: an image with a caption, and an audio whose download will fail (the mock network answers 404 for ids ending in FAILME).
    await webhook(owner.page, { id: "wamid.att.1", type: "image", image: { id: "IMG1", mime_type: "image/png", caption: "my receipt" } });
    await webhook(owner.page, { id: "wamid.att.2", type: "audio", audio: { id: "VOICEFAILME", mime_type: "audio/ogg" } });
    await expect.poll(async () => (await owner.page.request.get(`/v1/workspaces/${ws}/conversations`)).json().then((j: { items: unknown[] }) => j.items.length), { timeout: 20_000 }).toBe(1);
    conv = ((await (await owner.page.request.get(`/v1/workspaces/${ws}/conversations`)).json()) as { items: { id: string }[] }).items[0]!.id;
    await expect.poll(async () => (await list(owner.page)).items.filter((a) => a.status !== "pending").length, { timeout: 30_000 }).toBe(2);
    const items = (await list(owner.page)).items;
    imageId = items.find((a) => a.kind === "image")!.id;
  });
  test.afterAll(async () => { await Promise.all([owner?.ctx.close(), viewer?.ctx.close(), outsider?.ctx.close()]); });

  test("received image shows a preview, a failed download shows Retry and Delete, storage state is reported", async () => {
    const page = owner.page;
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`/w/${ws}/inbox/${conv}`);
    await expect(page.getByText("my receipt")).toBeVisible();
    const img = page.getByRole("img", { name: "Image" });
    await expect(img).toBeVisible();
    await expect.poll(() => img.evaluate((el: HTMLImageElement) => el.naturalWidth)).toBeGreaterThan(0); // the bytes really came through the API
    const failed = page.getByRole("alert").filter({ hasText: "Couldn't download this audio" });
    await expect(failed).toContainText("no longer has this file");
    await expect(page.getByRole("button", { name: "Retry download" })).toBeVisible();
    expect((await list(page)).storageConfigured).toBe(true);
    await page.getByRole("button", { name: "Retry download" }).click();
    await expect(failed).toBeVisible(); // still failing (the mock answers 404 again): a clear state, no crash
    await axe(page, "inbox-attachments@1440");
    // lightbox opens from the keyboard and closes again
    await page.getByRole("button", { name: "Open image Image" }).focus();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);
  });

  test("describe through the mock AI shows the result with usage and cost; add to knowledge", async () => {
    const page = owner.page;
    await page.goto(`/w/${ws}/inbox/${conv}`);
    await page.getByRole("button", { name: "Describe" }).click();
    const result = page.getByRole("region", { name: "Describe result" });
    await expect(result).toContainText("[MOCK IMAGE DESCRIPTION]");
    await expect(result).toContainText("MOCK");
    await expect(result).toContainText(/\d+ input \+ \d+ output tokens · 0\.00 USD/);
    await page.getByRole("button", { name: "Add to Knowledge" }).first().click();
    await expect(page.getByText("Added to the knowledge base")).toBeVisible();
    const sources = (await (await page.request.get(`/v1/workspaces/${ws}/knowledge/sources`)).json()) as { items: { sourceRef: string }[] };
    expect(sources.items.some((s) => s.sourceRef === `attachment:${imageId}`)).toBe(true);
  });

  test("composer: validation messages, upload status, failed upload with retry and remove, send a file", async () => {
    const page = owner.page;
    await page.goto(`/w/${ws}/inbox/${conv}`);
    const attach = page.getByTestId("attach-input");
    await expect(page.getByRole("button", { name: "Attach file" })).toBeEnabled();
    // wrong type: a message, nothing is uploaded
    await attach.setInputFiles({ name: "virus.exe", mimeType: "application/octet-stream", buffer: Buffer.from([0x4d, 0x5a, 0x90, 0]) });
    await expect(page.getByRole("alert").filter({ hasText: "virus.exe: This file type is not supported" })).toBeVisible();
    // right extension, wrong bytes: accepted by the browser check, refused by the server, with Retry and Remove
    await attach.setInputFiles({ name: "fake.png", mimeType: "image/png", buffer: Buffer.from("this is not an image") });
    const row = page.getByRole("listitem").filter({ hasText: "fake.png" });
    await expect(row.getByRole("alert")).toBeVisible();
    await expect(row.getByRole("button", { name: "Retry" })).toBeVisible();
    await row.getByRole("button", { name: "Remove fake.png" }).click();
    await expect(row).toHaveCount(0);
    // a real image: uploading, ready, then Send
    await attach.setInputFiles({ name: "photo.png", mimeType: "image/png", buffer: PNG });
    const ok = page.getByRole("listitem").filter({ hasText: "photo.png" });
    await expect(ok.getByText("Ready")).toBeVisible();
    await page.getByRole("textbox", { name: "Reply" }).fill("here you go");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await expect(page.getByText("here you go")).toBeVisible();
    await expect(page.getByRole("img", { name: "photo.png" })).toBeVisible();
    const out = (await list(page)).items.filter((a) => a.direction === "outbound");
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ status: "ready", kind: "image" });
  });

  test("delete: the uploader's file goes (row and blob), the knowledge entry made from a deleted file goes too", async () => {
    const page = owner.page;
    await page.goto(`/w/${ws}/inbox/${conv}`);
    page.once("dialog", (d) => void d.accept());
    await page.getByRole("button", { name: "Delete photo.png" }).click();
    await expect(page.getByText("File deleted")).toBeVisible();
    await expect(page.getByRole("img", { name: "photo.png" })).toHaveCount(0);
    expect((await list(page)).items.filter((a) => a.direction === "outbound")).toHaveLength(0);
    // deleting the received image removes the knowledge source that references it
    page.once("dialog", (d) => void d.accept());
    await page.getByRole("button", { name: "Delete Image file" }).click();
    await expect.poll(async () => ((await (await page.request.get(`/v1/workspaces/${ws}/knowledge/sources`)).json()) as { items: { sourceRef: string }[] }).items.filter((s) => s.sourceRef === `attachment:${imageId}`).length).toBe(0);
  });

  test("a viewer sees the file but has no delete, AI, knowledge or attach controls and the API refuses them; another workspace gets 404", async () => {
    // a fresh received image for the viewer to look at
    await webhook(owner.page, { id: "wamid.att.3", type: "image", image: { id: "IMG3", mime_type: "image/png" } });
    await expect.poll(async () => (await list(owner.page)).items.filter((a) => a.kind === "image" && a.status === "ready").length, { timeout: 30_000 }).toBe(1);
    const mine = (await list(owner.page)).items.find((a) => a.kind === "image" && a.status === "ready")!;
    const page = viewer.page;
    await page.setViewportSize({ width: 375, height: 800 });
    await page.goto(`/w/${ws}/inbox/${conv}`);
    await expect(page.getByRole("img", { name: "Image" })).toBeVisible();
    await expect(page.getByRole("button", { name: /^Delete/ })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Describe" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Add to Knowledge" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /Attach file/ })).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    const res = await page.request.delete(`${base()}/${mine.id}`, { headers: { origin: ORIGIN } });
    expect(res.status()).toBe(403);
    expect((await page.request.get(`${base()}/${mine.id}/content`)).status()).toBe(200); // a viewer can read
    // someone from another workspace: not found / forbidden, never the file
    const other = outsider.page;
    for (const path of [`/v1/workspaces/${wsOut}/conversations/${conv}/attachments/${mine.id}/content`, `/v1/workspaces/${ws}/conversations/${conv}/attachments/${mine.id}/content`, `/v1/workspaces/${wsOut}/conversations/${conv}/attachments`]) {
      expect([403, 404]).toContain((await other.request.get(path)).status());
    }
    expect((await other.request.delete(`/v1/workspaces/${wsOut}/conversations/${conv}/attachments/${mine.id}`, { headers: { origin: ORIGIN } })).status()).toBe(404);
    expect((await list(owner.page)).items.some((a) => a.id === mine.id)).toBe(true); // untouched
    // layouts
    for (const [w, h] of [[768, 900], [1440, 900]] as const) {
      await page.setViewportSize({ width: w, height: h });
      await page.reload();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    }
  });
});
