import { expect, test, type Page } from "@playwright/test";
import { addMemberByEmail, api, register, signUpAndCreate, openFold } from "./helpers";
import { axe } from "./channel-helpers";

/**
 * AI multimodal slice 1, MOCK provider only: capability badges, media playground, knowledge upload of PDF and audio, viewer blocked.
 * The mock derives its output from the file size and hash; nothing here proves a real AI service. Needs the mock Meta environment (worker role and secret key) and a fresh database.
 */
const ORIGIN = `http://localhost:${process.env.E2E_WEB_PORT ?? "3217"}`;
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 1, 2, 3]);
const PDF = Buffer.from("%PDF-1.4\n1 0 obj\n<<>>\nendobj\n");
const MP3 = Buffer.concat([Buffer.from("ID3\x03\0\0\0\0\0\0"), Buffer.alloc(300, 1)]);
const noOverflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);

test("capabilities, media playground, knowledge upload and a blocked viewer", async ({ page, browser }) => {
  const { workspaceId } = await signUpAndCreate(page, "Mia Multimodal", "Media Co");
  const AI = `/w/${workspaceId}/settings/ai/setup`;

  // Before any provider: the capability section explains what to do, and the playground answers with a clear error.
  await page.goto(AI);
  await openFold(page, "Capabilities");
  await openFold(page, "Media playground");
  await expect(page.getByRole("heading", { name: "Capabilities", level: 2 })).toBeVisible();
  await expect(page.getByText("No provider connected")).toBeVisible();
  await page.getByLabel("File").setInputFiles({ name: "a.png", mimeType: "image/png", buffer: PNG });
  await page.getByRole("button", { name: "Run" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "No provider with this capability" })).toContainText("Settings, AI");

  // Connect the offline mock provider through the API (the provider form is covered by ai-settings.spec).
  expect((await page.request.put(`/v1/workspaces/${workspaceId}/ai/providers/mock`, { data: { isDefault: true }, headers: { origin: ORIGIN } })).status()).toBe(200);
  await page.reload();
  await openFold(page, "Capabilities");
  await openFold(page, "Media playground");

  // Capability badges: per model, labelled MOCK, every capability on.
  const caps = page.getByRole("region", { name: "Mock (offline) capabilities" });
  await expect(caps).toBeVisible();
  await expect(caps.getByText("MOCK", { exact: true }).first()).toBeVisible();
  const model = caps.getByRole("listitem", { name: "Mock model (no cost) capabilities" });
  for (const label of ["Text", "Vision", "OCR and PDF", "Transcription"]) await expect(model.getByText(label, { exact: true })).toBeVisible();
  await expect(page.getByText("Available now:")).toContainText("audio transcription");

  // Playground: validation first, then describe, then transcribe, then a spoofed file is refused.
  const run = page.getByRole("button", { name: "Run" });
  await run.click();
  await expect(page.getByText("Choose a file first.")).toBeVisible();
  await expect(page.getByText("The result appears here with its token usage and cost.")).toBeVisible();
  await page.getByLabel("File").setInputFiles({ name: "photo.png", mimeType: "image/png", buffer: PNG });
  await run.click();
  const result = page.getByTestId("media-result");
  await expect(result).toContainText("[MOCK IMAGE DESCRIPTION]");
  const resultPanel = page.getByRole("region", { name: "Result" });
  await expect(resultPanel).toContainText("MOCK");
  await expect(resultPanel).toContainText("Cost: 0.00 USD");
  await expect(resultPanel).toContainText(/Tokens: \d+ in, \d+ out/);

  await page.getByLabel("Action", { exact: true }).selectOption("transcribe");
  await expect(page.getByTestId("media-result")).toHaveCount(0); // switching clears the old result
  await page.getByLabel("File").setInputFiles({ name: "voice.mp3", mimeType: "audio/mpeg", buffer: MP3 });
  await run.click();
  await expect(page.getByTestId("media-result")).toContainText("[MOCK TRANSCRIPT]");

  await page.getByLabel("Action", { exact: true }).selectOption("describe");
  await page.getByLabel("File").setInputFiles({ name: "fake.png", mimeType: "image/png", buffer: Buffer.from("this is not an image at all") });
  await run.click();
  await expect(page.getByRole("alert").filter({ hasText: "Could not process the file" })).toContainText("not supported");
  await page.getByLabel("Action", { exact: true }).selectOption("ask");
  await page.getByLabel("File").setInputFiles({ name: "photo.png", mimeType: "image/png", buffer: PNG });
  await run.click();
  await expect(page.getByText("Type a question about the image.")).toBeVisible();
  await page.getByLabel("Question").fill("What is in the picture?");
  await run.click();
  await expect(page.getByTestId("media-result")).toContainText("[MOCK ANSWER]");

  for (const w of [375, 768, 1440]) {
    await page.setViewportSize({ width: w, height: 900 });
    await expect(page.getByRole("heading", { name: "Media playground" })).toBeVisible();
    expect(await noOverflow(page), `no horizontal overflow at ${w}px`).toBe(true);
  }
  await page.setViewportSize({ width: 1280, height: 900 });
  await axe(page, "ai settings with capabilities and playground");

  // Knowledge: a PDF and an audio file become ready sources.
  await page.goto(`/w/${workspaceId}/settings/knowledge`);
  const dlg = page.getByRole("dialog", { name: /^(Add knowledge|Adding…|Needs attention|Done)$/ });
  const sources = page.getByRole("list", { name: "Knowledge sources" });
  for (const [name, mimeType, buffer] of [["manual.pdf", "application/pdf", PDF], ["voicemail.mp3", "audio/mpeg", MP3]] as const) {
    await page.getByRole("button", { name: "Add knowledge" }).first().click();
    await dlg.getByRole("button", { name: /Upload files/ }).click();
    await expect(dlg).toContainText("per audio file");
    await dlg.getByTestId("kb-file").setInputFiles({ name, mimeType, buffer });
    await dlg.getByRole("button", { name: /^Add 1 file$/ }).click();
    await expect(dlg.getByRole("heading", { name: "Added. Your agents can use it now" })).toBeVisible();
    await dlg.getByRole("button", { name: "Done" }).click();
    await expect(dlg).toHaveCount(0);
    const row = sources.getByRole("listitem").filter({ hasText: name });
    await expect(row.getByText(/passages?$/)).toBeVisible();
    await expect(row).toContainText(name.endsWith(".pdf") ? "PDF" : "Voice or audio");
  }
  await page.getByLabel("Question or keywords").fill("transcript");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await expect(page.getByRole("list", { name: "Search results" })).toContainText("voicemail.mp3");
  // A file that is not what it claims fails with a clear message and leaves a failed source with Retry.
  await page.getByRole("button", { name: "Add knowledge" }).first().click();
  await dlg.getByRole("button", { name: /Upload files/ }).click();
  await dlg.getByTestId("kb-file").setInputFiles({ name: "spoof.pdf", mimeType: "application/pdf", buffer: Buffer.from("just some text, not a pdf") });
  await dlg.getByRole("button", { name: /^Add 1 file$/ }).click();
  await expect(dlg.getByRole("alert")).toContainText("not supported");
  await dlg.getByRole("button", { name: "Done" }).click();
  await expect(sources.getByRole("listitem").filter({ hasText: "spoof.pdf" }).getByText("Needs attention")).toBeVisible();
  await expect(sources.getByRole("listitem").filter({ hasText: "spoof.pdf" }).getByRole("button", { name: "Retry spoof.pdf" })).toBeVisible();

  // Viewer: the API refuses media and capabilities, and the AI settings page is owner and admin only.
  const vctx = await browser.newContext();
  const vp = await vctx.newPage();
  const vEmail = await register(vp, "Vic Viewer");
  await addMemberByEmail(workspaceId, vEmail, "viewer");
  const body = { mime: "image/png", contentBase64: PNG.toString("base64") };
  expect((await vp.request.post(`/v1/workspaces/${workspaceId}/ai/media/describe`, { data: body, headers: { origin: ORIGIN } })).status()).toBe(403);
  expect((await api(vp).get(`/v1/workspaces/${workspaceId}/ai/capabilities`)).status()).toBe(403);
  await vp.goto(AI);
  await expect(vp.getByText("Only owners and admins can manage AI")).toBeVisible();
  await expect(vp.getByRole("button", { name: "Run" })).toHaveCount(0);
  await vctx.close();
});
