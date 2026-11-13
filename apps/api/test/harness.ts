import pg from "pg";
import { expect } from "vitest";
import { createApiClient, type ApiClient, type ApiResult } from "@crm/api-client";
import { MemoryMailer } from "@crm/core";
import { createDb, type Db } from "@crm/db";
import { endpoints, type ContactDetail, type CreateContactBody } from "@crm/contracts";
import { createAuth } from "../src/auth.ts";
import { createApp } from "../src/app.ts";

export const ORIGIN = "http://localhost:3000";
const APP_URL = process.env.DATABASE_URL_APP ?? "postgres://crm_app:app_dev@127.0.0.1:5436/" + (process.env.CRM_DB_NAME ?? "crm") + "";
const ADMIN_URL = "postgres://postgres:postgres@127.0.0.1:5436/" + (process.env.CRM_DB_NAME ?? "crm") + "";
// Date.now() alone collided when two vitest workers loaded this module in the same millisecond (duplicate user_email_unique in beforeAll).
const run = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
let n = 0;

export type TestUser = { id: string; email: string; name: string; cookie: string; token: string };
export type Harness = Awaited<ReturnType<typeof bootstrap>>;

export async function bootstrap(hooks?: Parameters<typeof createApp>[1]["testHooks"]) {
  const db: Db = createDb(APP_URL);
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  const auth = createAuth(db, { secret: "test-secret-".padEnd(40, "x"), baseURL: ORIGIN, trustedOrigins: [ORIGIN], mailer: new MemoryMailer() });
  const app = createApp(auth, { allowedOrigins: [ORIGIN], db, testHooks: hooks });

  const post = (path: string, data: unknown) => app.request(path, { method: "POST", headers: { "content-type": "application/json", origin: ORIGIN }, body: JSON.stringify(data) });

  async function newUser(label: string): Promise<TestUser> {
    const email = `${label}-${run}-${n++}@example.com`;
    const name = label.replace(/\d+$/, "");
    const res = await post("/api/auth/sign-up/email", { email, password: "correct-horse-battery", name });
    expect(res.status).toBe(200);
    const cookie = (res.headers.get("set-cookie") ?? "").split(";")[0]!;
    const token = res.headers.get("set-auth-token") ?? "";
    const me = await (await app.request("/v1/me", { headers: { cookie } })).json();
    return { id: me.id, email, name, cookie, token };
  }

  const fetchThrough = ((url: string, init: RequestInit) => app.request(url.replace("http://api.test", ""), init)) as unknown as typeof fetch;
  const clientFor = (u: TestUser, mode: "cookie" | "bearer" = "cookie"): ApiClient =>
    mode === "cookie"
      ? createApiClient({ baseUrl: "http://api.test", auth: { mode: "cookie" }, headers: () => ({ cookie: u.cookie, origin: ORIGIN }), fetch: fetchThrough })
      : createApiClient({ baseUrl: "http://api.test", auth: { mode: "bearer", getToken: () => u.token }, fetch: fetchThrough });

  async function workspace(owner: TestUser, name: string, members: Partial<Record<"admin" | "agent" | "viewer" | "agent2", TestUser>> = {}) {
    const res = await clientFor(owner).call(endpoints.createWorkspace, { body: { name } });
    if (!res.ok) throw new Error(JSON.stringify(res.error));
    const workspaceId = res.data.id;
    for (const [role, u] of Object.entries(members)) if (u) await admin.query("INSERT INTO memberships(workspace_id,user_id,role) VALUES ($1,$2,$3::workspace_role)", [workspaceId, u.id, role === "agent2" ? "agent" : role]);
    return workspaceId;
  }

  async function contact(c: ApiClient, workspaceId: string, body: CreateContactBody): Promise<ContactDetail> {
    const r = await c.call(endpoints.createContact, { params: { workspaceId }, body });
    if (!r.ok) throw new Error(`createContact failed: ${JSON.stringify(r.error)}`);
    return r.data;
  }

  return { app, db, admin, newUser, clientFor, workspace, contact, close: async () => { await db.$client.end(); await admin.end(); } };
}

export function ok<T>(r: ApiResult<T>): T {
  if (!r.ok) throw new Error(`expected success, got ${JSON.stringify(r.error)}`);
  return r.data;
}
export function failure<T>(r: ApiResult<T>) {
  if (r.ok) throw new Error("expected failure, got success");
  return r.error;
}
