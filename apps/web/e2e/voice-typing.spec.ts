import { expect, test, type Page } from "@playwright/test";
import { api, seedContacts, signUpAndCreate } from "./helpers";

/** A stand-in for the browser's speech recognition: it "hears" a fixed phrase in the language it was asked for. */
const fakeSpeech = () => {
  class Rec {
    lang = ""; continuous = false; interimResults = false;
    onresult: ((e: unknown) => void) | null = null; onerror: ((e: unknown) => void) | null = null; onend: (() => void) | null = null;
    start() { setTimeout(() => this.onresult?.({ resultIndex: 0, results: [Object.assign([{ transcript: this.lang === "bn-BD" ? "ক্লায়েন্ট কাল ফোন করবে" : "client will call tomorrow" }], { isFinal: true })] }), 30); }
    stop() { this.onend?.(); }
  }
  Object.assign(window, { SpeechRecognition: Rec, webkitSpeechRecognition: Rec });
};
const BN = "ক্লায়েন্ট কাল ফোন করবে";

async function dictate(page: Page, scope: ReturnType<Page["locator"]>, field: ReturnType<Page["locator"]>) {
  const start = scope.getByRole("button", { name: "Start voice typing" });
  await start.click();
  await expect(field).toHaveValue(/client will call tomorrow/);
  await scope.getByRole("button", { name: "Stop voice typing" }).click();
  await scope.getByRole("button", { name: "বাংলা Bangla" }).click();
  await expect(scope.getByRole("button", { name: "বাংলা Bangla" })).toHaveAttribute("aria-pressed", "true");
  await start.click();
  await expect(field).toHaveValue(new RegExp(BN));
  await scope.getByRole("button", { name: "Stop voice typing" }).click();
  await scope.getByRole("button", { name: "EN English" }).click(); // leave it as we found it
  void page;
}

test("voice typing writes English and Bangla into the note fields", async ({ page }) => {
  test.setTimeout(90_000);
  await page.addInitScript(fakeSpeech);
  const { workspaceId } = await signUpAndCreate(page, "Vera Voice", "Voice Co");
  const [contactId] = await seedContacts(page, workspaceId, [{ name: "Ana Costa" }]);

  // contact note
  await page.goto(`/w/${workspaceId}/contacts/${contactId}`);
  const note = page.getByLabel("Add a note");
  await dictate(page, page.locator("body"), note);
  await page.getByRole("button", { name: "Add note" }).click();
  await expect(page.getByText(/client will call tomorrow/).first()).toBeVisible();

  // task notes (saved when you leave the field)
  const created = await api(page).post(`/v1/workspaces/${workspaceId}/tasks`, { title: "Call Ana back", contactId });
  const task = (await created.json()) as { id: string };
  await page.goto(`/w/${workspaceId}/tasks`);
  await page.getByRole("button", { name: /Call Ana back/ }).click();
  const panel = page.getByRole("region", { name: "Task detail" });
  const notes = panel.getByLabel("Notes");
  await panel.getByRole("button", { name: "Start voice typing" }).click();
  await expect(notes).toHaveValue(/client will call tomorrow/);
  await panel.getByRole("button", { name: "Stop voice typing" }).click();
  await panel.getByRole("button", { name: "বাংলা Bangla" }).click();
  await panel.getByRole("button", { name: "Start voice typing" }).click();
  await expect(notes).toHaveValue(new RegExp(BN));
  await panel.getByRole("button", { name: "Stop voice typing" }).click();
  await panel.getByRole("heading", { name: "Call Ana back" }).click(); // blur saves
  await expect.poll(async () => ((await (await api(page).get(`/v1/workspaces/${workspaceId}/tasks/${task.id}`)).json()) as { description: string | null }).description ?? "").toContain(BN);
});

test("no voice button where the browser has no speech recognition", async ({ page }) => {
  const { workspaceId } = await signUpAndCreate(page, "Nick Nospeech", "Quiet Co");
  const [contactId] = await seedContacts(page, workspaceId, [{ name: "Ben Okafor" }]);
  await page.addInitScript(() => { Object.assign(window, { SpeechRecognition: undefined, webkitSpeechRecognition: undefined }); });
  await page.goto(`/w/${workspaceId}/contacts/${contactId}`);
  await expect(page.getByLabel("Add a note")).toBeVisible();
  await expect(page.getByRole("button", { name: /voice typing/i })).toHaveCount(0);
});
