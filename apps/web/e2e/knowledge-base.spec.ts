import { expect, test } from "@playwright/test";
import { addMemberByEmail, api, register, signUpAndCreate } from "./helpers";
import { axe } from "./channel-helpers";

/** AI Studio knowledge base, slice 1. URL ingestion is only exercised with an address that is refused before any connection (no internet). */
test("add text, find it with its source, delete it; viewer is read-only; another workspace sees nothing", async ({ page, browser }) => {
  const { workspaceId } = await signUpAndCreate(page, "Kay Owner", "Knowledge Co");
  const url = `/w/${workspaceId}/settings/ai/knowledge`;
  const dlg = page.getByRole("dialog", { name: "Add a source" });

  await page.goto(url);
  await expect(page.getByRole("heading", { name: "AI and automation", level: 1 })).toBeVisible();
  await expect(page.getByRole("link", { name: "Knowledge", exact: true })).toHaveAttribute("aria-current", "page");
  await expect(page.getByRole("navigation", { name: "Settings sections" }).getByRole("link", { name: "AI and automation" })).toHaveAttribute("aria-current", "page");
  await expect(page.getByText("No knowledge yet")).toBeVisible();
  await expect(page.getByText("Add a source first, then test what can be found.")).toBeVisible();

  // Validation and clear errors inside the dialog.
  await page.getByRole("button", { name: "Add source" }).first().click();
  await dlg.getByRole("button", { name: "Add source" }).click();
  await expect(dlg.getByRole("alert")).toHaveText("Paste some text.");
  await dlg.getByLabel("Source type").selectOption("file");
  await dlg.getByLabel("File").setInputFiles({ name: "scan.docx", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", buffer: Buffer.from("PK") });
  await expect(dlg.getByRole("alert")).toContainText("not supported yet");
  await dlg.getByLabel("Source type").selectOption("url");
  await dlg.getByLabel("Web address").fill("http://127.0.0.1:8080/admin");
  await dlg.getByRole("button", { name: "Fetch and add" }).click();
  await expect(dlg.getByRole("alert")).toContainText("private or internal network");
  await dlg.getByLabel("Web address").fill("https://user:secret@example.com/");
  await dlg.getByRole("button", { name: "Fetch and add" }).click();
  await expect(dlg.getByRole("alert")).toContainText("user name or password");
  await dlg.getByLabel("Source type").selectOption("text");
  await dlg.getByLabel("Title", { exact: true }).fill("Refund policy");
  await dlg.getByLabel("Text").fill("Customers may request refunds within 14 days of purchase. Refunds are paid to the original payment method.");
  await dlg.getByRole("button", { name: "Add source" }).click();
  await expect(dlg).toHaveCount(0);

  // The row shows title, type, status, passages and who added it.
  const row = page.getByRole("row").filter({ hasText: "Refund policy" });
  await expect(row).toContainText("Pasted text");
  await expect(row.getByText("Ready")).toBeVisible();
  await expect(row.getByRole("cell").nth(3)).toHaveText("1");
  await expect(row).toContainText("Kay Owner");

  // Retrieval shows the passage with its source reference.
  const results = page.getByRole("list", { name: "Search results" });
  await page.getByLabel("Question or keywords").fill("refunds");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await expect(results.getByRole("listitem")).toHaveCount(1);
  await expect(results).toContainText("1. Refund policy");
  await expect(results).toContainText("Source: Pasted text");
  await expect(results).toContainText("original payment method");
  await page.getByLabel("Question or keywords").fill("zzzznothing");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await expect(page.getByText("Nothing found")).toBeVisible();

  // Layout at the three breakpoints, and accessibility.
  for (const w of [375, 768, 1440]) {
    await page.setViewportSize({ width: w, height: 900 });
    await expect(row).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), `no horizontal overflow at ${w}px`).toBe(true);
  }
  await page.setViewportSize({ width: 1280, height: 900 });
  await axe(page, "knowledge settings");

  // Viewer: sees the list and can test retrieval, has no controls, and the API refuses writes.
  const vctx = await browser.newContext();
  const vp = await vctx.newPage();
  const vEmail = await register(vp, "Vic Viewer");
  await addMemberByEmail(workspaceId, vEmail, "viewer");
  await vp.goto(url);
  await expect(vp.getByRole("row").filter({ hasText: "Refund policy" })).toBeVisible();
  await expect(vp.getByRole("button", { name: "Add source" })).toHaveCount(0);
  await expect(vp.getByRole("button", { name: /^(Delete|Re-index) / })).toHaveCount(0);
  await vp.getByLabel("Question or keywords").fill("refunds");
  await vp.getByRole("button", { name: "Search", exact: true }).click();
  await expect(vp.getByRole("list", { name: "Search results" })).toContainText("Refund policy");
  const listed = await api(vp).get(`/v1/workspaces/${workspaceId}/knowledge/sources`);
  expect(listed.status()).toBe(200);
  const sourceId = (await listed.json()).items[0].id as string;
  expect((await api(vp).post(`/v1/workspaces/${workspaceId}/knowledge/sources/text`, { title: "x", text: "y" })).status()).toBe(403);
  expect((await vp.request.delete(`/v1/workspaces/${workspaceId}/knowledge/sources/${sourceId}`, { headers: { origin: `http://localhost:${process.env.E2E_WEB_PORT ?? "3217"}` } })).status()).toBe(403);
  await vctx.close();

  // Another workspace never sees it.
  const octx = await browser.newContext();
  const op = await octx.newPage();
  const other = await signUpAndCreate(op, "Olga Other", "Other Co");
  await op.goto(`/w/${other.workspaceId}/settings/ai/knowledge`);
  await expect(op.getByText("No knowledge yet")).toBeVisible();
  await op.getByLabel("Question or keywords").fill("refunds");
  await op.getByRole("button", { name: "Search", exact: true }).click();
  await expect(op.getByText("Nothing found")).toBeVisible();
  expect((await api(op).get(`/v1/workspaces/${workspaceId}/knowledge/sources`)).status()).toBe(404);
  expect((await api(op).get(`/v1/workspaces/${workspaceId}/knowledge/search?q=refunds`)).status()).toBe(404);
  expect((await api(op).get(`/v1/workspaces/${other.workspaceId}/knowledge/sources/${sourceId}`)).status()).toBe(404);
  await octx.close();

  // Delete with confirmation: cancel keeps it, confirm removes it and its passages.
  await page.reload();
  await page.getByRole("button", { name: "Delete Refund policy" }).click();
  const confirm = page.getByRole("dialog", { name: "Delete this source?" });
  await expect(confirm).toContainText("can no longer be searched");
  await confirm.getByRole("button", { name: "Cancel" }).click();
  await expect(row).toBeVisible();
  await page.getByRole("button", { name: "Delete Refund policy" }).click();
  await page.getByRole("dialog", { name: "Delete this source?" }).getByRole("button", { name: "Delete source" }).click();
  await expect(page.getByText("No knowledge yet")).toBeVisible();
  await page.getByLabel("Question or keywords").fill("refunds");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await expect(page.getByText("Nothing found")).toBeVisible();
  const after = await api(page).get(`/v1/workspaces/${workspaceId}/knowledge/search?q=refunds`);
  expect((await after.json()).items).toEqual([]);
});
