import { expect, test, type Page } from "@playwright/test";
import { signUpAndCreate } from "./helpers";
import { axe, seed } from "./channel-helpers";

/**
 * Settings, AI, Setup: the five jobs and the model browser. Uses the MOCK environment (E2E_META_MOCK=1, which also sets OPENROUTER_MOCK=1): a fixed offline model list.
 * This proves our UI, pinning and permissions, not any real AI service (UNVERIFIED). Needs a fresh database, like the other AI specs.
 */
test.describe.configure({ mode: "serial" });

const ORIGIN = `http://localhost:${process.env.E2E_WEB_PORT ?? "3217"}`;
let owner: Page, workspaceId = "";
const SETUP = () => `/w/${workspaceId}/settings/ai/setup`;
const noOverflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
const JOBS = ["Reply suggestions in the inbox", "Agent notes and proposed actions", "Read images customers send", "Read PDFs and documents for Knowledge", "Turn voice messages into text"];
const change = (job: string) => owner.getByRole("button", { name: `Change the model for ${job}` });
const price = (inP: number, outP: number) => ({ inputMicroPer1M: inP, outputMicroPer1M: outP });

test.beforeAll(async ({ browser }) => {
  owner = await (await browser.newContext()).newPage();
  ({ workspaceId } = await signUpAndCreate(owner, "Olive Owner", "Jobs Co"));
  seed(workspaceId);
});

test("not connected: jobs are disabled and the connection is the way in", async () => {
  await owner.setViewportSize({ width: 1440, height: 900 });
  await owner.goto(SETUP());
  const list = owner.getByRole("list", { name: "AI jobs" });
  await expect(list.getByRole("listitem")).toHaveCount(5);
  for (const j of JOBS) await expect(change(j)).toBeDisabled();
  await expect(owner.getByText("Connect a provider first").first()).toBeVisible();
  await expect(owner.getByText(/Start here: choose a provider/)).toBeVisible();
  await expect(owner.getByRole("heading", { name: "What this setup does" })).toBeVisible();
});

test("five jobs, pick a model in the browser, use automatic", async () => {
  // Connect OpenRouter (mock list) with a text-only default and one image-capable model already on.
  const res = await owner.request.put(`/v1/workspaces/${workspaceId}/ai/providers/openrouter`, { headers: { origin: ORIGIN }, data: {
    apiKey: "sk-or-v1-E2E-SECRET-0123456789abcdef", enabled: true, isDefault: true, defaultModel: "mockvendor/beta-mini",
    modelPrices: { "mockvendor/beta-mini": price(100000, 400000) },
  } });
  expect(res.status()).toBe(200);
  await owner.reload();
  const list = owner.getByRole("list", { name: "AI jobs" });
  await expect(list.getByRole("listitem")).toHaveCount(5);
  for (const j of JOBS) await expect(list.getByRole("listitem").filter({ hasText: j })).toBeVisible();
  const reply = list.getByRole("listitem").filter({ hasText: JOBS[0]! });
  await expect(reply).toContainText("Automatic");
  await expect(reply).toContainText("Working");
  await expect(list.getByRole("listitem").filter({ hasText: JOBS[2]! })).toContainText("Needs a model");

  // The vision job: models that cannot read images are hidden by default, shown but disabled when the box is off.
  await change(JOBS[2]!).click();
  const dlg = owner.getByRole("dialog", { name: /Read images customers send/ });
  await expect(dlg.getByRole("button", { name: /Mock Alpha Chat/ })).toBeVisible();
  await expect(dlg.getByRole("button", { name: /Mock Gamma Text/ })).toHaveCount(0);
  await expect(dlg.getByText(/Showing \d+ of \d+, \d+ hidden\./)).toBeVisible();
  await dlg.getByLabel("Hide models that cannot do this job").uncheck();
  await expect(dlg.getByRole("button", { name: /Mock Gamma Text/ })).toBeDisabled();
  await dlg.getByLabel("Hide models that cannot do this job").check();
  // Search and sort.
  await dlg.getByLabel("Search models").fill("zzz-nothing");
  await expect(dlg.getByText("No models match")).toBeVisible();
  await dlg.getByLabel("Search models").fill("alpha");
  await expect(dlg.getByRole("button", { name: /Mock Beta Mini/ })).toHaveCount(0);
  await dlg.getByLabel("Search models").fill("");
  await dlg.getByLabel("Sort models").selectOption("price");
  await expect(dlg.getByText(/Models in use: 1 of 50/)).toBeVisible();
  await axe(owner, "model browser");
  // Pick it: it is turned on for the workspace and pinned to the job.
  await dlg.getByRole("button", { name: /Mock Alpha Chat/ }).click();
  await expect(owner.getByText(`${JOBS[2]!}: model saved`)).toBeVisible();
  await expect(change(JOBS[2]!)).toContainText("mockvendor/alpha-chat");
  await expect(list.getByRole("listitem").filter({ hasText: JOBS[2]! })).toContainText("Working");
  await expect(list.getByRole("listitem").filter({ hasText: JOBS[2]! })).not.toContainText("Automatic");
  await expect(owner.getByLabel("Models in use").getByRole("listitem")).toHaveCount(2);

  // Persisted: a reload still shows the pin, and the API says so.
  await owner.reload();
  await expect(change(JOBS[2]!)).toContainText("mockvendor/alpha-chat");
  const jobs = await (await owner.request.get(`/v1/workspaces/${workspaceId}/ai/jobs`)).json();
  expect(jobs.items.find((j: { job: string }) => j.job === "vision").pinned.model).toBe("mockvendor/alpha-chat");

  // Use automatic clears the pin.
  await owner.getByRole("button", { name: `Use automatic for ${JOBS[2]!}` }).click();
  await expect(owner.getByText(`${JOBS[2]!}: back to automatic`)).toBeVisible();
  await expect(owner.getByRole("button", { name: `Use automatic for ${JOBS[2]!}` })).toHaveCount(0);
});

test("layout holds at 375, 768 and 1440 and passes axe", async () => {
  for (const w of [375, 768, 1440]) {
    await owner.setViewportSize({ width: w, height: 900 });
    await expect(owner.getByRole("heading", { name: "Monthly budget" })).toBeVisible();
    expect(await noOverflow(owner), `no horizontal overflow at ${w}px`).toBe(true);
  }
  await owner.setViewportSize({ width: 375, height: 800 });
  await change(JOBS[0]!).click();
  const dlg = owner.getByRole("dialog", { name: /Reply suggestions in the inbox/ });
  await expect(dlg).toBeVisible();
  expect(await noOverflow(owner), "no overflow with the browser open at 375px").toBe(true);
  await dlg.getByRole("button", { name: "Close" }).click();
  await owner.setViewportSize({ width: 1280, height: 900 });
  await axe(owner, "setup jobs");
});
