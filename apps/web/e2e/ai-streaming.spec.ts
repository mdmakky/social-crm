import { execFileSync } from "node:child_process";
import { expect, test, type Page } from "@playwright/test";
import { addMemberByEmail, api, register, seedContacts, signUpAndCreate } from "./helpers";
import { axe, DB } from "./channel-helpers";

/**
 * OpenRouter slice B, MOCK provider only (no network): streamed reply suggestion, Stop, error states, native tool calls for agents, and the web proxy not buffering the stream.
 * The mock reads markers from the customer message: [[MOCK_SLOW]] pauses between chunks, [[MOCK_ERROR:blocked|payment_required]] fails, [[MOCK_TOOL:name:{json}]] calls a tool.
 * Needs the mock Meta environment (E2E_META_MOCK=1: worker role and secret key) and a fresh database.
 */
test.describe.configure({ mode: "serial" });

const ORIGIN = `http://localhost:${process.env.E2E_WEB_PORT ?? "3217"}`;
let owner: Page, workspaceId = "";
const W = () => `/v1/workspaces/${workspaceId}`;
const noOverflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
let n = 0;

/** One messenger conversation with one inbound message, inserted straight into the e2e database (the inbox ingest path is not what is under test). */
function conversation(name: string, body: string): string {
  const sql = `
    WITH a AS (INSERT INTO integration_accounts (workspace_id, platform, external_account_id, status, display_name) VALUES (:'ws','messenger', :'ext','connected','Page') RETURNING id),
    st AS (SELECT id FROM lifecycle_stages WHERE workspace_id = :'ws' ORDER BY position LIMIT 1),
    ct AS (INSERT INTO contacts (workspace_id, name, lifecycle_stage_id, source) SELECT :'ws', :'name', st.id, 'messenger' FROM st RETURNING id),
    idn AS (INSERT INTO platform_identities (workspace_id, integration_account_id, external_user_id, contact_id) SELECT :'ws', a.id, :'ext', ct.id FROM a, ct RETURNING id),
    cv AS (INSERT INTO conversations (workspace_id, integration_account_id, identity_id, contact_id, last_message_at, last_inbound_at) SELECT :'ws', a.id, idn.id, ct.id, now(), now() FROM a, idn, ct RETURNING id),
    m AS (INSERT INTO messages (workspace_id, conversation_id, integration_account_id, direction, external_id, sender_kind, body, delivery_state) SELECT :'ws', cv.id, a.id, 'in', :'ext', 'contact', :'body', 'received' FROM cv, a RETURNING 1)
    SELECT id FROM cv;`;
  return execFileSync("psql", ["-tA", "-q", "-h", "127.0.0.1", "-p", "5436", "-U", "postgres", "-d", DB, "-v", `ws=${workspaceId}`, "-v", `name=${name}`, "-v", `ext=${Date.now()}${n++}`, "-v", `body=${body}`, "-f", "-"], { input: sql, env: { ...process.env, PGPASSWORD: "postgres" } }).toString().trim().split("\n")[0]!;
}
const runs = (where: string) => Number(execFileSync("psql", ["-tA", "-q", "-h", "127.0.0.1", "-p", "5436", "-U", "postgres", "-d", DB, "-c", `SELECT count(*) FROM ai_runs WHERE workspace_id='${workspaceId}' AND ${where}`], { env: { ...process.env, PGPASSWORD: "postgres" } }).toString().trim());
const open = async (id: string) => { await owner.goto(`/w/${workspaceId}/inbox/${id}`); await expect(owner.getByLabel("Reply", { exact: true })).toBeVisible(); };
const reply = () => owner.getByLabel("Reply", { exact: true });
const suggestBtn = () => owner.getByRole("button", { name: "Suggest reply with AI" });

let normal = "", slow = "", blocked = "", broke = "";

test.beforeAll(async ({ browser }) => {
  owner = await (await browser.newContext()).newPage();
  ({ workspaceId } = await signUpAndCreate(owner, "Olive Owner", "Stream Co"));
  expect((await owner.request.put(`${W()}/ai/providers/mock`, { data: { isDefault: true }, headers: { origin: ORIGIN } })).status()).toBe(200);
  normal = conversation("Nora Normal", "Do you deliver on Fridays?");
  slow = conversation("Sam Slow", "Do you deliver on Fridays? [[MOCK_SLOW]]");
  blocked = conversation("Bea Blocked", "Please help [[MOCK_ERROR:blocked]]");
  broke = conversation("Pia Pay", "Please help [[MOCK_ERROR:payment_required]]");
});

test("the draft streams into the composer progressively, then is editable and never sent", async () => {
  await open(slow);
  const lengths: number[] = [];
  await suggestBtn().click();
  await expect(owner.getByRole("button", { name: "Stop AI suggestion" })).toBeVisible();
  await expect(owner.getByTestId("ai-draft-status")).toContainText(/Connecting|Writing a draft/);
  await expect(reply()).toHaveAttribute("readonly", ""); // the text is written by the stream until it ends
  const t0 = Date.now();
  while (Date.now() - t0 < 20_000) {
    const v = await reply().inputValue();
    if (v.length && lengths.at(-1) !== v.length) lengths.push(v.length);
    if (await suggestBtn().isVisible()) break;
    await owner.waitForTimeout(80);
  }
  expect(lengths.length).toBeGreaterThanOrEqual(3); // several intermediate states, not one jump
  expect([...lengths].sort((a, b) => a - b)).toEqual(lengths); // only ever grows
  const finalText = await reply().inputValue();
  expect(finalText).toMatch(/^\[MOCK DRAFT\]/);
  expect(lengths[0]!).toBeLessThan(finalText.length);
  await expect(owner.getByText("AI draft (mock)")).toBeVisible();
  await expect(owner.getByText(/Nothing is sent automatically/)).toBeVisible();
  await expect(reply()).not.toHaveAttribute("readonly", "");
  await expect(owner.getByRole("button", { name: "Stop AI suggestion" })).toHaveCount(0);
  // The polite live region announces completion once, not every chunk.
  await expect(owner.locator('p[role="status"][aria-live="polite"]')).toContainText("AI draft added to the reply box");
  // Draft only: editable, and no message exists until Send.
  await reply().fill(finalText + " (edited)");
  await expect(reply()).toHaveValue(/\(edited\)$/);
  await owner.reload();
  await expect(owner.getByLabel("Reply", { exact: true })).toHaveValue("");
  await expect(owner.getByText(finalText.slice(0, 30))).toHaveCount(0);
});

test("a fast stream on a normal conversation completes and the run is logged without text", async () => {
  await open(normal);
  const before = runs("capability='reply_suggestion' AND status='ok'");
  await suggestBtn().click();
  await expect(reply()).toHaveValue(/\[MOCK DRAFT\].*meantime\.$/);
  await expect(owner.getByText("AI draft (mock)")).toBeVisible();
  await expect.poll(() => runs("capability='reply_suggestion' AND status='ok'")).toBeGreaterThan(before);
});

test("Stop aborts the request, keeps the part that arrived, and the run is logged as client_aborted", async () => {
  await open(slow);
  const before = runs("error_code='client_aborted'");
  await suggestBtn().click();
  await expect.poll(async () => (await reply().inputValue()).length).toBeGreaterThan(0);
  await owner.getByRole("button", { name: "Stop AI suggestion" }).click();
  await expect(suggestBtn()).toBeVisible();
  const kept = await reply().inputValue();
  expect(kept.length).toBeGreaterThan(0);
  expect(kept.length).toBeLessThan(60); // far from the full ~150 characters
  await owner.waitForTimeout(1200); // an aborted stream does not keep writing
  expect(await reply().inputValue()).toBe(kept);
  await expect(owner.locator('p[role="status"][aria-live="polite"]')).toContainText("Stopped");
  await expect(reply()).not.toHaveAttribute("readonly", "");
  await expect.poll(() => runs("error_code='client_aborted'")).toBeGreaterThan(before);
});

test("blocked and out-of-credits answers show clear messages and leave the composer alone", async () => {
  await open(blocked);
  await reply().fill("my own text");
  owner.once("dialog", (d) => void d.accept());
  await suggestBtn().click();
  await expect(owner.getByText(/AI provider blocked this request/)).toBeVisible();
  await expect(reply()).toHaveValue("my own text"); // restored, nothing half written
  await expect(owner.getByTestId("ai-draft-status")).toHaveCount(0);
  await open(broke);
  await suggestBtn().click();
  await expect(owner.getByText(/out of credits/)).toBeVisible();
  await expect(reply()).toHaveValue("");
});

test("the web proxy streams without buffering: the first event arrives long before the last", async () => {
  await owner.goto(`/w/${workspaceId}/inbox/${slow}`);
  const r = await owner.evaluate(async ({ url }) => {
    const t0 = performance.now();
    const res = await fetch(url, { method: "POST", credentials: "include" });
    const reader = res.body!.getReader();
    const times: number[] = [];
    for (;;) { const { done } = await reader.read(); if (done) break; times.push(performance.now() - t0); }
    return { status: res.status, type: res.headers.get("content-type"), enc: res.headers.get("content-encoding"), cache: res.headers.get("cache-control"), times };
  }, { url: `${W()}/conversations/${slow}/ai/suggest-reply/stream` });
  expect(r.status).toBe(200);
  expect(r.type).toContain("text/event-stream");
  expect(r.cache).toBe("no-cache, no-transform");
  expect(r.enc).toBeNull(); // not compressed (compression would buffer)
  expect(r.times.length).toBeGreaterThanOrEqual(5);
  expect(r.times[0]!).toBeLessThan(2000);
  expect(r.times.at(-1)! - r.times[0]!).toBeGreaterThan(2500); // the stream really spread over time
});

test("an agent on a tool-capable model shows native tool calls and a pending action", async () => {
  const contactId = (await seedContacts(owner, workspaceId, [{ name: "Pat Pending" }]))[0]!;
  const created = await api(owner).post(`${W()}/ai/agents`, { name: "Native helper", instructions: "Help the customer briefly.", toolGrants: [{ tool: "crm.add_note", mode: "approval" }] });
  expect(created.ok()).toBe(true);
  const agent = (await created.json()) as { id: string };
  expect((await api(owner).post(`${W()}/ai/agents/${agent.id}/activate`, {})).ok()).toBe(true);
  await owner.goto(`/w/${workspaceId}/settings/ai-agents`);
  await owner.getByRole("button", { name: "Edit Native helper" }).click();
  const caps = owner.getByTestId("model-caps");
  await expect(caps).toContainText("Native tool calls");
  await expect(caps).toContainText("This model will use");
  await owner.getByLabel("Customer message").fill('Please note it [[MOCK_TOOL:crm__add_note:{"body":"native e2e note"}]]');
  await owner.getByLabel(/^Lead \(needed/).selectOption({ label: "Pat Pending" });
  await owner.getByLabel("Dry run (change nothing)").uncheck();
  await owner.getByRole("button", { name: "Run test" }).click();
  await expect(owner.getByText("Pending approval", { exact: true }).first()).toBeVisible();
  await expect(owner.getByText(/Version 1 · mock-1 · native tool calls/)).toBeVisible();
  await owner.getByRole("link", { name: /^Overview/ }).click(); // approvals live in one queue on the hub Overview
  await expect(owner.getByRole("button", { name: "Approve crm.add_note" })).toBeVisible();
  const notes = (await (await api(owner).get(`${W()}/contacts/${contactId}/notes`)).json()) as { body: string }[];
  expect(notes).toHaveLength(0); // proposed, not done
  await owner.getByRole("link", { name: /^Agents/ }).click();
  await owner.getByRole("button", { name: "Edit Native helper" }).click();
  await expect(caps).toBeVisible();
  // Turning the tool off changes how the model is asked: no tools granted means the reply is requested as structured JSON (mock supports it).
  await owner.getByLabel("Mode for crm.add_note").selectOption("off");
  await expect(caps).toContainText("Structured output");
  for (const w of [375, 768, 1440]) {
    await owner.setViewportSize({ width: w, height: 900 });
    await expect(caps).toBeVisible();
    expect(await noOverflow(owner)).toBe(true);
  }
  await axe(owner, "settings-ai-agents-caps");
  await owner.setViewportSize({ width: 1440, height: 900 });
});

test("layout and accessibility of the streaming composer at 375, 768 and 1440", async () => {
  await open(slow);
  await suggestBtn().click();
  await expect(owner.getByRole("button", { name: "Stop AI suggestion" })).toBeVisible();
  for (const w of [375, 768, 1440]) {
    await owner.setViewportSize({ width: w, height: 900 });
    await expect(owner.getByRole("button", { name: "Stop AI suggestion" })).toBeVisible();
    expect(await noOverflow(owner)).toBe(true);
  }
  await axe(owner, "inbox-thread-ai-streaming");
  await owner.getByRole("button", { name: "Stop AI suggestion" }).click();
  await owner.setViewportSize({ width: 1440, height: 900 });
});

test("a viewer cannot stream a suggestion (API)", async ({ browser }) => {
  const vp = await (await browser.newContext()).newPage();
  const email = await register(vp, "Vic Viewer");
  await addMemberByEmail(workspaceId, email, "viewer");
  await vp.goto(`/w/${workspaceId}/inbox`);
  expect((await vp.request.post(`${W()}/conversations/${normal}/ai/suggest-reply/stream`, { headers: { origin: ORIGIN } })).status()).toBe(403);
  await vp.context().close();
});

test("a spent budget arrives as a clear error event, before any text", async () => {
  expect((await owner.request.put(`${W()}/ai/budget`, { data: { monthlyCapMicro: 0, hardStop: true }, headers: { origin: ORIGIN } })).status()).toBe(200);
  await open(normal);
  await suggestBtn().click();
  await expect(owner.getByText(/monthly AI budget is used up/)).toBeVisible();
  await expect(reply()).toHaveValue("");
  expect((await owner.request.put(`${W()}/ai/budget`, { data: { monthlyCapMicro: null, hardStop: true }, headers: { origin: ORIGIN } })).status()).toBe(200);
});
