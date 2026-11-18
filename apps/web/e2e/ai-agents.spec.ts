import { expect, test, type Page } from "@playwright/test";
import { addMemberByEmail, api, register, seedContacts, signUpAndCreate } from "./helpers";
import { axe } from "./channel-helpers";

/**
 * AI agent builder slice 2, MOCK provider only. The mock returns exactly the JSON placed after [[MOCK_REPLY: in the message, so the tool-call flow is deterministic.
 * This proves our UI, permissions and approval flow, not any real AI service. Needs the mock Meta environment (worker role and secret key) and a fresh database.
 */
test.describe.configure({ mode: "serial" });

let owner: Page, workspaceId = "", contactId = "";
const PAGE = () => `/w/${workspaceId}/settings/ai-agents`;
const W = () => `/v1/workspaces/${workspaceId}`;
const noOverflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
const MARKER = `hello there [[MOCK_REPLY:${JSON.stringify({ reply: "Happy to help with that.", actions: [{ tool: "crm.add_note", args: { body: "e2e agent note" } }] })}]]`;

test.beforeAll(async ({ browser }) => {
  owner = await (await browser.newContext()).newPage();
  ({ workspaceId } = await signUpAndCreate(owner, "Olive Owner", "Agents Co"));
  expect((await owner.request.put(`${W()}/ai/providers/mock`, { data: { isDefault: true }, headers: { origin: `http://localhost:${process.env.E2E_WEB_PORT ?? "3217"}` } })).status()).toBe(200);
  contactId = (await seedContacts(owner, workspaceId, [{ name: "Pat Pending" }]))[0]!;
});

test("create an agent with instructions and tool grants", async () => {
  await owner.goto(PAGE());
  await expect(owner.getByText("No agents yet")).toBeVisible();
  await expect(owner.getByText("Nothing waiting")).toBeVisible();
  await owner.getByRole("button", { name: "Create an agent" }).click();
  await owner.getByLabel("Name", { exact: true }).fill("Support helper");
  await owner.getByLabel("Role").fill("Answers first-line questions");
  await owner.getByLabel("Instructions").fill("Answer politely and briefly. Add an internal note when something needs follow up.");
  await expect(owner.getByText(/^\d+ \/ 6000 characters$/)).toBeVisible();
  await expect(owner.getByText("sensitive: needs approval")).toBeVisible();
  await expect(owner.getByLabel("Mode for crm.assign_owner").locator("option", { hasText: "Runs automatically" })).toHaveCount(0);
  await owner.getByLabel("Mode for crm.add_note").selectOption("approval");
  await owner.getByLabel("Mode for crm.find_contact").selectOption("auto");
  await owner.getByRole("button", { name: "Create agent" }).click();
  await expect(owner.getByText("Agent created as a draft")).toBeVisible();
  await expect(owner.getByRole("button", { name: "Edit Support helper" })).toBeVisible();
  await expect(owner.getByText("Versions are never edited")).toBeVisible();
  await owner.getByRole("button", { name: "Activate version 1" }).click();
  await expect(owner.getByText("Version 1 is live")).toBeVisible();
  await expect(owner.getByRole("cell", { name: "v1 live (latest v1)" })).toBeVisible();
});

test("test playground: dry run changes nothing, live run queues the action, approve executes it", async () => {
  await owner.goto(PAGE());
  await owner.getByRole("button", { name: "Edit Support helper" }).click();
  await owner.getByLabel("Customer message").fill(MARKER);
  await owner.getByLabel(/^Lead \(needed/).selectOption({ label: "Pat Pending" });
  await expect(owner.getByLabel("Dry run (change nothing)")).toBeChecked();
  await owner.getByRole("button", { name: "Run test" }).click();
  await expect(owner.getByText("Happy to help with that.")).toBeVisible();
  await expect(owner.getByText("Reply draft (never sent)")).toBeVisible();
  await expect(owner.getByText("Would wait for approval")).toBeVisible();
  await expect(owner.getByText("MOCK", { exact: true }).first()).toBeVisible();
  await expect(owner.getByText(/tokens · cost/)).toBeVisible();
  await expect(owner.getByText("Nothing waiting")).toBeVisible(); // a dry run queues nothing
  const notes = async () => (await (await api(owner).get(`${W()}/contacts/${contactId}/notes`)).json()) as { body: string }[];
  expect(await notes()).toHaveLength(0);

  await owner.getByLabel("Dry run (change nothing)").uncheck();
  await expect(owner.getByText(/Live test: write tools will really run/)).toBeVisible();
  await owner.getByRole("button", { name: "Run test" }).click();
  await expect(owner.getByText("Pending approval", { exact: true }).first()).toBeVisible();
  const approve = owner.getByRole("button", { name: "Approve crm.add_note" });
  await expect(approve).toBeVisible();
  expect(await notes()).toHaveLength(0); // proposed, not done
  await approve.click();
  await expect(owner.getByText("Action approved and done")).toBeVisible();
  await expect(owner.getByText("Nothing waiting")).toBeVisible();
  expect((await notes()).map((n) => n.body)).toEqual(["e2e agent note"]);
  await expect(owner.getByRole("cell", { name: "ok", exact: true }).first()).toBeVisible(); // runs table
});

test("a malformed or ungranted model answer is shown as rejected, never executed", async () => {
  await owner.goto(PAGE());
  await owner.getByRole("button", { name: "Edit Support helper" }).click();
  await owner.getByLabel("Customer message").fill(`x [[MOCK_REPLY:${JSON.stringify({ reply: "Sure", actions: [{ tool: "crm.add_tag", args: { tagName: "x" } }] })}]]`);
  await owner.getByRole("button", { name: "Run test" }).click();
  await expect(owner.getByText("Rejected", { exact: true })).toBeVisible();
  await expect(owner.getByText("not_granted")).toBeVisible();
});

test("layout at 375, 768 and 1440 and accessibility", async () => {
  await owner.goto(PAGE());
  await owner.getByRole("button", { name: "Edit Support helper" }).click();
  for (const w of [375, 768, 1440]) {
    await owner.setViewportSize({ width: w, height: 900 });
    await expect(owner.getByRole("button", { name: "Run test" })).toBeVisible();
    expect(await noOverflow(owner)).toBe(true);
  }
  await axe(owner, "settings-ai-agents");
});

test("a viewer cannot manage or run agents (UI and API)", async ({ browser }) => {
  const vp = await (await browser.newContext()).newPage();
  const email = await register(vp, "Vic Viewer");
  await addMemberByEmail(workspaceId, email, "viewer");
  await vp.goto(PAGE());
  await expect(vp.getByText("Only owners and admins can manage AI agents")).toBeVisible();
  await expect(vp.getByRole("button", { name: "New agent" })).toHaveCount(0);
  expect((await api(vp).get(`${W()}/ai/agents`)).status()).toBe(403);
  expect((await api(vp).get(`${W()}/ai/agent-actions`)).status()).toBe(403);
  expect((await api(vp).post(`${W()}/ai/agents`, { name: "x", instructions: "y" })).status()).toBe(403);
  expect((await api(vp).post(`${W()}/ai/agents/019a0000-0000-7000-8000-000000000000/test`, { input: "hi" })).status()).toBe(403);
});
