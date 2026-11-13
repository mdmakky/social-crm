import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { endpoints } from "@crm/contracts";
import { createApiClient } from "@crm/api-client";
import { MemoryMailer } from "@crm/core";
import { createDb, type Db } from "@crm/db";
import { createAuth } from "../src/auth.ts";
import { createApp } from "../src/app.ts";

const APP_URL = process.env.DATABASE_URL_APP ?? "postgres://crm_app:app_dev@127.0.0.1:5436/" + (process.env.CRM_DB_NAME ?? "crm") + "";
const ADMIN_URL = "postgres://postgres:postgres@127.0.0.1:5436/" + (process.env.CRM_DB_NAME ?? "crm") + "";
const ORIGIN = "http://localhost:3000";
const run = Date.now();

let db: Db;
let admin: pg.Client;
let app: ReturnType<typeof createApp>;
const norm = (p: string) => p.replace(/:[A-Za-z0-9_]+/g, ":p").replace(/\/+$/, "") || "/";

beforeAll(async () => {
  db = createDb(APP_URL);
  admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  app = createApp(createAuth(db, { secret: "test-secret-".padEnd(40, "x"), baseURL: "http://localhost:8787", trustedOrigins: [ORIGIN], mailer: new MemoryMailer() }), { allowedOrigins: [ORIGIN], db });
});
afterAll(async () => {
  await db.$client.end();
  await admin.end();
});

describe("contract drift guard: routes", () => {
  it("every /v1 route has an endpoint definition and every endpoint has a route", () => {
    const served = new Set(app.routes.filter((r) => r.method !== "ALL" && r.path.startsWith("/v1/")).map((r) => `${r.method} ${norm(r.path)}`));
    const declared = new Set(Object.values(endpoints).map((e) => `${e.method} ${norm(e.path)}`));
    expect([...served].filter((x) => !declared.has(x))).toEqual([]);
    expect([...declared].filter((x) => !served.has(x))).toEqual([]);
  });
});

async function signUp(label: string) {
  const email = `${label}-${run}@example.com`;
  const res = await app.request("/api/auth/sign-up/email", {
    method: "POST",
    headers: { "content-type": "application/json", origin: ORIGIN },
    body: JSON.stringify({ email, password: "correct-horse-battery", name: label }),
  });
  return { email, cookie: (res.headers.get("set-cookie") ?? "").split(";")[0]!, token: res.headers.get("set-auth-token") ?? "" };
}
const through = () => ((url: string, req: RequestInit) => app.request(url.replace("http://api.test", ""), req)) as unknown as typeof fetch;

describe("contract drift guard: the typed client against the real server", () => {
  it("runs the whole workspace scenario in cookie mode with every response matching its schema", async () => {
    const owner = await signUp("contract-owner");
    const member = await signUp("contract-member");
    const client = createApiClient({ baseUrl: "http://api.test", auth: { mode: "cookie" }, headers: () => ({ cookie: owner.cookie, origin: ORIGIN }), fetch: through() });

    const me = await client.call(endpoints.me);
    expect(me.ok && me.data.email).toBe(owner.email);

    const created = await client.call(endpoints.createWorkspace, { body: { name: "Contract Co" } });
    if (!created.ok) throw new Error(JSON.stringify(created.error));
    const workspaceId = created.data.id;

    const list = await client.call(endpoints.listWorkspaces);
    expect(list.ok && list.data.map((w) => w.id)).toContain(workspaceId);
    const detail = await client.call(endpoints.getWorkspace, { params: { workspaceId } });
    expect(detail.ok && detail.data.role).toBe("owner");
    expect((await client.call(endpoints.updateWorkspace, { params: { workspaceId }, body: { name: "Contract Co 2" } })).ok).toBe(true);

    const memberId = (await (await app.request("/v1/me", { headers: { cookie: member.cookie } })).json()).id as string;
    await admin.query("INSERT INTO memberships(workspace_id,user_id,role) VALUES ($1,$2,'agent')", [workspaceId, memberId]);

    const members = await client.call(endpoints.listMembers, { params: { workspaceId } });
    expect(members.ok && members.data).toHaveLength(2);
    const changed = await client.call(endpoints.updateMember, { params: { workspaceId, userId: memberId }, body: { role: "viewer" } });
    expect(changed.ok && changed.data.role).toBe("viewer");
    const audit = await client.call(endpoints.auditLog, { params: { workspaceId }, query: { limit: 2 } });
    expect(audit.ok && audit.data.items).toHaveLength(2);
    expect((await client.call(endpoints.removeMember, { params: { workspaceId, userId: memberId } })).ok).toBe(true);

    // server errors arrive as typed errors, not exceptions
    const denied = await client.call(endpoints.updateMember, { params: { workspaceId, userId: me.ok ? me.data.id : "" }, body: { role: "admin" } });
    expect(!denied.ok && denied.error).toMatchObject({ kind: "http", status: 403, code: "last_owner" });
  });

  it("works with bearer authentication and no cookies (the mobile path)", async () => {
    const user = await signUp("contract-mobile");
    expect(user.token.length).toBeGreaterThan(10);
    const client = createApiClient({ baseUrl: "http://api.test", auth: { mode: "bearer", getToken: () => user.token }, fetch: through() });
    const me = await client.call(endpoints.me);
    expect(me.ok && me.data.email).toBe(user.email);
    const created = await client.call(endpoints.createWorkspace, { body: { name: "Mobile Co" } });
    expect(created.ok).toBe(true);
    const anonymous = createApiClient({ baseUrl: "http://api.test", auth: { mode: "bearer", getToken: () => null }, fetch: through() });
    const r = await anonymous.call(endpoints.me);
    expect(!r.ok && r.error.status).toBe(401);
  });
});
