import { expect, type Page } from "@playwright/test";
import pg from "pg";

export const run = Date.now().toString(36);
export const PASSWORD = "correct-horse-battery";
let n = 0;
export const uniqueEmail = (label: string) => `${label}-${run}-${n++}@example.com`;

export async function register(page: Page, name: string, email = uniqueEmail(name.toLowerCase().replace(/\W+/g, ""))) {
  await page.goto("/register");
  await page.getByLabel("Full name").fill(name);
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Create account" }).click();
  await page.waitForURL("**/onboarding");
  return email;
}

export async function createWorkspace(page: Page, name: string) {
  await page.getByLabel("Workspace name").fill(name);
  await page.getByRole("button", { name: "Create workspace" }).click();
  await page.waitForURL(/\/w\/[0-9a-f-]{36}$/);
  await expect(page.getByRole("heading", { name, level: 1 })).toBeVisible();
  return page.url().split("/w/")[1]!;
}

export async function signUpAndCreate(page: Page, person: string, workspace: string) {
  const email = await register(page, person);
  const workspaceId = await createWorkspace(page, workspace);
  return { email, workspaceId };
}

/** Test-only: adds an existing user to a workspace directly, since invitations are not built yet. */
export async function addMemberByEmail(workspaceId: string, email: string, role: string) {
  const c = new pg.Client({ connectionString: "postgres://postgres:postgres@127.0.0.1:5436/crm" });
  await c.connect();
  await c.query('INSERT INTO memberships(workspace_id,user_id,role) SELECT $1, id, $3::workspace_role FROM "user" WHERE email = $2', [workspaceId, email, role]);
  await c.end();
}

export async function signOut(page: Page) {
  await page.getByRole("button", { name: "Account menu" }).click();
  await page.getByRole("menuitem", { name: "Sign out" }).click();
  await page.waitForURL("**/login");
}

export async function signIn(page: Page, email: string) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL(/\/w\//);
}

const ORIGIN = "http://localhost:3217";
export const api = (page: Page) => ({
  post: async (path: string, data: unknown) => page.request.post(path, { data, headers: { origin: ORIGIN } }),
  patch: async (path: string, data: unknown) => page.request.patch(path, { data, headers: { origin: ORIGIN } }),
  get: async (path: string) => page.request.get(path),
});

/** Creates contacts through the API so list tests do not depend on typing into forms. */
export async function seedContacts(page: Page, workspaceId: string, people: { name: string; email?: string; phone?: string; company?: string }[]) {
  const a = api(page);
  const ids: string[] = [];
  for (const p of people) {
    const res = await a.post(`/v1/workspaces/${workspaceId}/contacts`, p);
    if (res.status() !== 201) throw new Error(`seed failed: ${res.status()} ${await res.text()}`);
    ids.push((await res.json()).id);
  }
  return ids;
}

export const CONTACT_NAMES = ["Ana Costa", "Ben Okafor", "Chloe Park", "Dev Patel", "Eli Moreau", "Fatima Noor", "Gus Hall", "Hana Sato", "Ivan Petrov", "Jia Li"];
