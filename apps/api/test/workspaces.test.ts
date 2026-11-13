import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { MemoryMailer } from "@crm/core";
import { createDb, type Db } from "@crm/db";
import { createAuth } from "../src/auth.ts";
import { createApp } from "../src/app.ts";

const APP_URL = process.env.DATABASE_URL_APP ?? "postgres://crm_app:app_dev@127.0.0.1:5436/crm";
const ADMIN_URL = "postgres://postgres:postgres@127.0.0.1:5436/crm";
const ORIGIN = "http://localhost:3000";
const run = Date.now();

let db: Db;
let admin: pg.Client;
let app: ReturnType<typeof createApp>;

type U = { id: string; cookie: string; email: string };
const post = (path: string, body: unknown, cookie?: string, method = "POST") =>
  app.request(path, { method, headers: { "content-type": "application/json", origin: ORIGIN, ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body) });
const get = (path: string, cookie?: string) => app.request(path, { headers: cookie ? { cookie } : {} });

async function register(label: string): Promise<U> {
  const email = `${label}-${run}@example.com`;
  const res = await post("/api/auth/sign-up/email", { email, password: "correct-horse-battery", name: label });
  expect(res.status).toBe(200);
  const cookie = (res.headers.get("set-cookie") ?? "").split(";")[0]!;
  const me = await (await get("/v1/me", cookie)).json();
  return { id: me.id, cookie, email };
}
async function addMember(workspaceId: string, userId: string, role: string) {
  await admin.query("INSERT INTO memberships(workspace_id,user_id,role) VALUES ($1,$2,$3)", [workspaceId, userId, role]);
}

let owner: U, outsider: U, agent: U, adminUser: U;
let wsId: string;

beforeAll(async () => {
  admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  db = createDb(APP_URL);
  const auth = createAuth(db, { secret: "test-secret-".padEnd(40, "x"), baseURL: "http://localhost:8787", trustedOrigins: [ORIGIN], mailer: new MemoryMailer() });
  app = createApp(auth, { allowedOrigins: [ORIGIN], db });
  [owner, outsider, agent, adminUser] = await Promise.all([register("owner"), register("outsider"), register("agent"), register("adminuser")]);
  const res = await post("/v1/workspaces", { name: "Northwind Studio" }, owner.cookie);
  expect(res.status).toBe(201);
  wsId = (await res.json()).id;
  await addMember(wsId, agent.id, "agent");
  await addMember(wsId, adminUser.id, "admin");
});
afterAll(async () => {
  await db.$client.end();
  await admin.end();
});

describe("workspaces", () => {
  it("requires authentication", async () => {
    expect((await get("/v1/workspaces")).status).toBe(401);
    expect((await post("/v1/workspaces", { name: "X Co" })).status).toBe(401);
  });
  it("creates a workspace with the creator as owner and lists it", async () => {
    const list = await (await get("/v1/workspaces", owner.cookie)).json();
    expect(list).toEqual([expect.objectContaining({ id: wsId, name: "Northwind Studio", role: "owner" })]);
    expect(list[0].slug).toMatch(/^northwind-studio-[a-z0-9]{4,}$/);
  });
  it("validates the name", async () => {
    expect((await post("/v1/workspaces", { name: "" }, owner.cookie)).status).toBe(400);
    expect((await post("/v1/workspaces", { name: "x".repeat(61) }, owner.cookie)).status).toBe(400);
    expect((await post("/v1/workspaces", {}, owner.cookie)).status).toBe(400);
  });
  it("gives two workspaces with the same name different slugs", async () => {
    const a = await (await post("/v1/workspaces", { name: "Same Name" }, outsider.cookie)).json();
    const b = await (await post("/v1/workspaces", { name: "Same Name" }, outsider.cookie)).json();
    expect(a.slug).not.toBe(b.slug);
  });
  it("shows workspace detail with role and member count to members", async () => {
    const d = await (await get(`/v1/workspaces/${wsId}`, agent.cookie)).json();
    expect(d).toMatchObject({ id: wsId, role: "agent", memberCount: 3 });
  });
  it("hides a workspace from non-members (404, no existence leak)", async () => {
    for (const path of [`/v1/workspaces/${wsId}`, `/v1/workspaces/${wsId}/members`, `/v1/workspaces/${wsId}/audit-log`]) {
      expect((await get(path, outsider.cookie)).status).toBe(404);
    }
    expect((await get("/v1/workspaces/not-a-uuid", owner.cookie)).status).toBe(404);
  });
  it("lets owners and admins rename; refuses agents", async () => {
    expect((await post(`/v1/workspaces/${wsId}`, { name: "Northwind Studios" }, adminUser.cookie, "PATCH")).status).toBe(200);
    expect((await post(`/v1/workspaces/${wsId}`, { name: "Hacked" }, agent.cookie, "PATCH")).status).toBe(403);
    expect((await post(`/v1/workspaces/${wsId}`, {}, owner.cookie, "PATCH")).status).toBe(400);
  });
});

describe("members", () => {
  it("lists members with name, email and role", async () => {
    const m = await (await get(`/v1/workspaces/${wsId}/members`, agent.cookie)).json();
    expect(m.map((x: { role: string }) => x.role).sort()).toEqual(["admin", "agent", "owner"]);
    expect(m.find((x: { role: string }) => x.role === "owner").email).toBe(owner.email);
  });
  it("agents cannot change roles", async () => {
    expect((await post(`/v1/workspaces/${wsId}/members/${adminUser.id}`, { role: "viewer" }, agent.cookie, "PATCH")).status).toBe(403);
  });
  it("admins cannot demote the owner or grant owner", async () => {
    const r1 = await post(`/v1/workspaces/${wsId}/members/${owner.id}`, { role: "agent" }, adminUser.cookie, "PATCH");
    expect(r1.status).toBe(403);
    expect((await r1.json()).error.code).toBe("admin_cannot_change_owner");
    const r2 = await post(`/v1/workspaces/${wsId}/members/${agent.id}`, { role: "owner" }, adminUser.cookie, "PATCH");
    expect((await r2.json()).error.code).toBe("admin_cannot_grant_owner");
  });
  it("the last owner cannot be demoted or removed", async () => {
    const r1 = await post(`/v1/workspaces/${wsId}/members/${owner.id}`, { role: "admin" }, owner.cookie, "PATCH");
    expect((await r1.json()).error.code).toBe("last_owner");
    const r2 = await app.request(`/v1/workspaces/${wsId}/members/${owner.id}`, { method: "DELETE", headers: { cookie: owner.cookie, origin: ORIGIN } });
    expect((await r2.json()).error.code).toBe("last_owner");
  });
  it("an admin can change an agent's role and the change is audited", async () => {
    const ok = await post(`/v1/workspaces/${wsId}/members/${agent.id}`, { role: "viewer" }, adminUser.cookie, "PATCH");
    expect(ok.status).toBe(200);
    const audit = await (await get(`/v1/workspaces/${wsId}/audit-log`, owner.cookie)).json();
    expect(audit.items.map((i: { action: string }) => i.action)).toContain("member.role_changed");
  });
  it("an admin can remove a member", async () => {
    const res = await app.request(`/v1/workspaces/${wsId}/members/${agent.id}`, { method: "DELETE", headers: { cookie: adminUser.cookie, origin: ORIGIN } });
    expect(res.status).toBe(204);
    expect((await get(`/v1/workspaces/${wsId}`, agent.cookie)).status).toBe(404);
  });
});

describe("audit log", () => {
  it("records workspace creation and updates with the actor", async () => {
    const audit = await (await get(`/v1/workspaces/${wsId}/audit-log`, owner.cookie)).json();
    const actions = audit.items.map((i: { action: string }) => i.action);
    expect(actions).toEqual(expect.arrayContaining(["workspace.created", "workspace.updated", "member.removed"]));
    expect(audit.items.find((i: { action: string }) => i.action === "workspace.created").actorName).toBe("owner");
  });
  it("is visible to admins and owners only", async () => {
    expect((await get(`/v1/workspaces/${wsId}/audit-log`, adminUser.cookie)).status).toBe(200);
    await addMember(wsId, outsider.id, "agent");
    expect((await get(`/v1/workspaces/${wsId}/audit-log`, outsider.cookie)).status).toBe(403);
  });
  it("paginates newest first with a cursor", async () => {
    const p1 = await (await get(`/v1/workspaces/${wsId}/audit-log?limit=2`, owner.cookie)).json();
    expect(p1.items).toHaveLength(2);
    expect(p1.nextCursor).toBeTruthy();
    const p2 = await (await get(`/v1/workspaces/${wsId}/audit-log?limit=2&cursor=${p1.nextCursor}`, owner.cookie)).json();
    expect(p2.items[0].id).not.toBe(p1.items[0].id);
    expect(p2.items[0].createdAt <= p1.items[1].createdAt).toBe(true);
  });
});
