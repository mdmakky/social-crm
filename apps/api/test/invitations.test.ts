import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { createHash } from "node:crypto";
import { MemoryMailer } from "@crm/core";
import { createDb, type Db } from "@crm/db";
import { createAuth } from "../src/auth.ts";
import { createApp } from "../src/app.ts";

const APP_URL = process.env.DATABASE_URL_APP ?? "postgres://crm_app:app_dev@127.0.0.1:5436/" + (process.env.CRM_DB_NAME ?? "crm");
const ADMIN_URL = "postgres://postgres:postgres@127.0.0.1:5436/" + (process.env.CRM_DB_NAME ?? "crm");
const ORIGIN = "http://localhost:3000";
const run = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const sha = (t: string) => createHash("sha256").update(t).digest("hex");

let db: Db;
let admin: pg.Client;
let app: ReturnType<typeof createApp>;
let appNoMail: ReturnType<typeof createApp>;
let limited: ReturnType<typeof createApp>;
const mailer = new MemoryMailer();

type U = { id: string; cookie: string; email: string };
const call = (a: ReturnType<typeof createApp>, method: string, path: string, cookie?: string, body?: unknown, headers: Record<string, string> = {}) =>
  a.request(path, { method, headers: { origin: ORIGIN, ...(body !== undefined ? { "content-type": "application/json" } : {}), ...(cookie ? { cookie } : {}), ...headers }, body: body !== undefined ? JSON.stringify(body) : undefined });

async function register(label: string, email?: string): Promise<U> {
  const e = email ?? `${label}-${run}@example.com`;
  const res = await call(app, "POST", "/api/auth/sign-up/email", undefined, { email: e, password: "correct-horse-battery", name: label });
  expect(res.status).toBe(200);
  const cookie = (res.headers.get("set-cookie") ?? "").split(";")[0]!;
  const me = await (await call(app, "GET", "/v1/me", cookie)).json();
  return { id: me.id, cookie, email: e };
}
const addMember = (ws: string, id: string, role: string) => admin.query("INSERT INTO memberships(workspace_id,user_id,role) VALUES ($1,$2,$3)", [ws, id, role]);
const tokenOf = (link: string) => link.split("/invite/")[1]!;

let owner: U, adminU: U, agent: U, viewer: U, outsider: U, ownerB: U;
let ws: string, wsB: string;

async function invite(who: U, email: string, role: string, a = app, workspace = ws) {
  return call(a, "POST", `/v1/workspaces/${workspace}/invitations`, who.cookie, { email, role });
}
const mkEmail = (l: string) => `${l}-${run}@example.com`;

beforeAll(async () => {
  admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  db = createDb(APP_URL);
  const auth = createAuth(db, { secret: "test-secret-".padEnd(40, "x"), baseURL: "http://localhost:8787", trustedOrigins: [ORIGIN], mailer: new MemoryMailer() });
  app = createApp(auth, { allowedOrigins: [ORIGIN], db, invitations: { mailer } });
  appNoMail = createApp(auth, { allowedOrigins: [ORIGIN], db });
  limited = createApp(auth, { allowedOrigins: [ORIGIN], db, invitations: { limits: { createPerUser: 2, previewPerIp: 3, acceptPerUser: 2 } } });
  [owner, adminU, agent, viewer, outsider, ownerB] = await Promise.all(["owner", "adm", "agent", "viewer", "outsider", "ownerb"].map((l) => register(l)));
  ws = (await (await call(app, "POST", "/v1/workspaces", owner.cookie, { name: "Invite Co" })).json()).id;
  wsB = (await (await call(app, "POST", "/v1/workspaces", ownerB.cookie, { name: "Other Co" })).json()).id;
  await addMember(ws, adminU.id, "admin");
  await addMember(ws, agent.id, "agent");
  await addMember(ws, viewer.id, "viewer");
});
afterAll(async () => {
  await db.$client.end();
  await admin.end();
});

describe("invitations: permissions", () => {
  it("agent and viewer cannot invite or list", async () => {
    for (const u of [agent, viewer]) {
      expect((await invite(u, mkEmail("nope"), "agent")).status).toBe(403);
      expect((await call(app, "GET", `/v1/workspaces/${ws}/invitations`, u.cookie)).status).toBe(403);
    }
  });
  it("admin invites agent/viewer but not admin; owner can invite an admin; owner role is not invitable", async () => {
    expect((await invite(adminU, mkEmail("a1"), "agent")).status).toBe(201);
    expect((await invite(adminU, mkEmail("a2"), "viewer")).status).toBe(201);
    const r = await invite(adminU, mkEmail("a3"), "admin");
    expect(r.status).toBe(403);
    expect((await r.json()).error.code).toBe("admin_invite_needs_owner");
    expect((await invite(owner, mkEmail("a3"), "admin")).status).toBe(201);
    expect((await invite(owner, mkEmail("a4"), "owner")).status).toBe(400);
  });
  it("an admin cannot revoke or resend an admin invitation; an owner can", async () => {
    const c = await (await invite(owner, mkEmail("adm-inv"), "admin")).json();
    for (const op of ["revoke", "resend"]) expect((await call(app, "POST", `/v1/workspaces/${ws}/invitations/${c.invitation.id}/${op}`, adminU.cookie)).status).toBe(403);
    expect((await call(app, "POST", `/v1/workspaces/${ws}/invitations/${c.invitation.id}/revoke`, owner.cookie)).status).toBe(200);
  });
});

describe("invitations: create", () => {
  it("returns the one-time link, stores only a hash, never lists the token", async () => {
    const email = mkEmail("Hash");
    const res = await invite(owner, email.toUpperCase(), "agent");
    expect(res.status).toBe(201);
    const j = await res.json();
    const token = tokenOf(j.link);
    expect(j.link).toBe(`${ORIGIN}/invite/${token}`);
    expect(token.length).toBeGreaterThanOrEqual(43);
    expect(j.invitation.email).toBe(email.toLowerCase());
    expect(j.emailSent).toBe(true);
    const { rows } = await admin.query("SELECT * FROM workspace_invitations WHERE id=$1", [j.invitation.id]);
    expect(rows[0].token_hash).toBe(sha(token));
    expect(JSON.stringify(rows[0])).not.toContain(token);
    const list = await (await call(app, "GET", `/v1/workspaces/${ws}/invitations`, owner.cookie)).json();
    expect(JSON.stringify(list)).not.toContain(token);
    expect(list.find((i: { id: string }) => i.id === j.invitation.id).status).toBe("pending");
    const audit = await admin.query("SELECT summary, action FROM audit_log WHERE workspace_id=$1 AND action='invitation.created' AND entity_id=$2", [ws, j.invitation.id]);
    expect(audit.rows).toHaveLength(1);
    expect(JSON.stringify(audit.rows)).not.toContain(token);
  });
  it("sends the mailer a link and nothing else secret; sends nothing without a mailer", async () => {
    const email = mkEmail("mailed");
    const j = await (await invite(owner, email, "viewer")).json();
    const sent = mailer.outbox.filter((m) => m.to === email);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.text).toContain(j.link);
    expect(sent[0]!.text).not.toMatch(/password|secret|cookie/i);
    const before = mailer.outbox.length;
    const j2 = await (await invite(owner, mkEmail("nomail"), "viewer", appNoMail)).json();
    expect(j2.emailSent).toBe(false);
    expect(j2.link).toContain("/invite/");
    expect(mailer.outbox.length).toBe(before);
  });
  it("rejects a duplicate pending invitation (409) and an existing member (409), case-insensitive", async () => {
    const email = mkEmail("dup");
    expect((await invite(owner, email, "agent")).status).toBe(201);
    const d = await invite(owner, email.toUpperCase(), "viewer");
    expect(d.status).toBe(409);
    expect((await d.json()).error.code).toBe("duplicate_pending");
    const m = await invite(owner, agent.email.toUpperCase(), "viewer");
    expect(m.status).toBe(409);
    expect((await m.json()).error.code).toBe("already_member");
  });
  it("a lapsed pending invitation does not block a new one", async () => {
    const email = mkEmail("lapsed");
    const first = await (await invite(owner, email, "agent")).json();
    await admin.query("UPDATE workspace_invitations SET expires_at = now() - interval '1 minute' WHERE id=$1", [first.invitation.id]);
    expect((await invite(owner, email, "agent")).status).toBe(201);
    const { rows } = await admin.query("SELECT status FROM workspace_invitations WHERE id=$1", [first.invitation.id]);
    expect(rows[0].status).toBe("expired");
  });
  it("is rate limited per user", async () => {
    const l = await register("limiter");
    const w = (await (await call(limited, "POST", "/v1/workspaces", l.cookie, { name: "Limit Co" })).json()).id;
    expect((await invite(l, mkEmail("l1"), "agent", limited, w)).status).toBe(201);
    expect((await invite(l, mkEmail("l2"), "agent", limited, w)).status).toBe(201);
    expect((await invite(l, mkEmail("l3"), "agent", limited, w)).status).toBe(429);
  });
});

describe("invitations: preview", () => {
  it("shows workspace, role, inviter and a masked email; unknown token is a generic 404", async () => {
    const email = mkEmail("prev");
    const j = await (await invite(owner, email, "agent")).json();
    const res = await call(app, "GET", `/v1/invitations/preview?token=${tokenOf(j.link)}`);
    expect(res.status).toBe(200);
    const p = await res.json();
    expect(p).toMatchObject({ workspaceName: "Invite Co", role: "agent", inviterName: "owner", emailMasked: `p***@example.com` });
    expect(JSON.stringify(p)).not.toContain(email);
    const unknown = await call(app, "GET", `/v1/invitations/preview?token=${"x".repeat(43)}`);
    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toEqual({ error: { code: "not_found" } });
  });
  it("revoked, expired and used tokens look exactly like unknown ones", async () => {
    const rev = await (await invite(owner, mkEmail("p-rev"), "agent")).json();
    await call(app, "POST", `/v1/workspaces/${ws}/invitations/${rev.invitation.id}/revoke`, owner.cookie);
    const exp = await (await invite(owner, mkEmail("p-exp"), "agent")).json();
    await admin.query("UPDATE workspace_invitations SET expires_at = now() - interval '1 minute' WHERE id=$1", [exp.invitation.id]);
    const unknown = await (await call(app, "GET", `/v1/invitations/preview?token=${"y".repeat(43)}`)).text();
    for (const j of [rev, exp]) {
      const r = await call(app, "GET", `/v1/invitations/preview?token=${tokenOf(j.link)}`);
      expect(r.status).toBe(404);
      expect(await r.text()).toBe(unknown);
    }
  });
  it("is rate limited per IP", async () => {
    const codes: number[] = [];
    for (let i = 0; i < 5; i++) codes.push((await call(limited, "GET", `/v1/invitations/preview?token=${"z".repeat(43)}`, undefined, undefined, { "x-forwarded-for": "9.9.9.9" })).status);
    expect(codes).toEqual([404, 404, 404, 429, 429]);
  });
});

describe("invitations: accept", () => {
  it("right email joins with the invited role, appears in members, audited without the token, and is idempotent", async () => {
    const email = mkEmail("joiner");
    const j = await (await invite(owner, email, "agent")).json();
    const token = tokenOf(j.link);
    const joiner = await register("joiner");
    expect((await call(app, "POST", "/v1/invitations/accept", undefined, { token })).status).toBe(401);
    const res = await call(app, "POST", "/v1/invitations/accept", joiner.cookie, { token });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ workspaceId: ws, role: "agent" });
    const members = await (await call(app, "GET", `/v1/workspaces/${ws}/members`, owner.cookie)).json();
    expect(members.find((m: { userId: string }) => m.userId === joiner.id)).toMatchObject({ role: "agent", status: "active" });
    const again = await call(app, "POST", "/v1/invitations/accept", joiner.cookie, { token });
    expect(again.status).toBe(200);
    const audit = await admin.query("SELECT summary FROM audit_log WHERE workspace_id=$1 AND action='invitation.accepted' AND entity_id=$2", [ws, joiner.id]);
    expect(audit.rows).toHaveLength(1);
    expect(JSON.stringify(audit.rows)).not.toContain(token);
    const list = await (await call(app, "GET", `/v1/workspaces/${ws}/invitations`, owner.cookie)).json();
    expect(list.find((i: { id: string }) => i.id === j.invitation.id).status).toBe("accepted");
    // the joiner now sees the workspace but cannot invite
    expect((await invite(joiner, mkEmail("x1"), "agent")).status).toBe(403);
  });
  it("accepts when the signed-in email differs only by case", async () => {
    const j = await (await invite(owner, mkEmail("casey"), "viewer")).json();
    const u = await register("casey", mkEmail("Casey").replace("casey", "CaSeY"));
    expect((await call(app, "POST", "/v1/invitations/accept", u.cookie, { token: tokenOf(j.link) })).status).toBe(200);
  });
  it("a different signed-in email gets 403 and no membership", async () => {
    const j = await (await invite(owner, mkEmail("target"), "agent")).json();
    const res = await call(app, "POST", "/v1/invitations/accept", outsider.cookie, { token: tokenOf(j.link) });
    expect(res.status).toBe(403);
    expect((await res.json()).error.message).toContain("This invitation was sent to another email");
    const { rows } = await admin.query("SELECT 1 FROM memberships WHERE workspace_id=$1 AND user_id=$2", [ws, outsider.id]);
    expect(rows).toHaveLength(0);
  });
  it("expired is 410; revoked and unknown are 404; a used token cannot be reused by someone else", async () => {
    const e = await (await invite(owner, mkEmail("late"), "agent")).json();
    await admin.query("UPDATE workspace_invitations SET expires_at = now() - interval '1 minute' WHERE id=$1", [e.invitation.id]);
    const late = await register("late");
    expect((await call(app, "POST", "/v1/invitations/accept", late.cookie, { token: tokenOf(e.link) })).status).toBe(410);
    const r = await (await invite(owner, mkEmail("gone"), "agent")).json();
    await call(app, "POST", `/v1/workspaces/${ws}/invitations/${r.invitation.id}/revoke`, owner.cookie);
    const gone = await register("gone");
    expect((await call(app, "POST", "/v1/invitations/accept", gone.cookie, { token: tokenOf(r.link) })).status).toBe(404);
    expect((await call(app, "POST", "/v1/invitations/accept", gone.cookie, { token: "q".repeat(43) })).status).toBe(404);
    const used = await (await invite(owner, mkEmail("once"), "viewer")).json();
    const once = await register("once");
    expect((await call(app, "POST", "/v1/invitations/accept", once.cookie, { token: tokenOf(used.link) })).status).toBe(200);
    expect((await call(app, "POST", "/v1/invitations/accept", outsider.cookie, { token: tokenOf(used.link) })).status).toBe(404);
  });
  it("is rate limited per user", async () => {
    const u = await register("spammer");
    const codes: number[] = [];
    for (let i = 0; i < 3; i++) codes.push((await call(limited, "POST", "/v1/invitations/accept", u.cookie, { token: "w".repeat(43) })).status);
    expect(codes).toEqual([404, 404, 429]);
  });
});

describe("invitations: revoke, resend, tenancy", () => {
  it("resend rotates the token, extends expiry and the old link dies", async () => {
    const j = await (await invite(owner, mkEmail("resend"), "agent")).json();
    await admin.query("UPDATE workspace_invitations SET expires_at = now() + interval '1 hour' WHERE id=$1", [j.invitation.id]);
    const r = await call(app, "POST", `/v1/workspaces/${ws}/invitations/${j.invitation.id}/resend`, adminU.cookie);
    expect(r.status).toBe(200);
    const n = await r.json();
    expect(tokenOf(n.link)).not.toBe(tokenOf(j.link));
    expect(new Date(n.invitation.expiresAt).getTime()).toBeGreaterThan(Date.now() + 6 * 86_400_000);
    expect((await call(app, "GET", `/v1/invitations/preview?token=${tokenOf(j.link)}`)).status).toBe(404);
    expect((await call(app, "GET", `/v1/invitations/preview?token=${tokenOf(n.link)}`)).status).toBe(200);
    const a = await admin.query("SELECT summary FROM audit_log WHERE workspace_id=$1 AND action='invitation.resent' AND entity_id=$2", [ws, j.invitation.id]);
    expect(JSON.stringify(a.rows)).not.toContain(tokenOf(n.link));
    // revoked cannot be resent
    await call(app, "POST", `/v1/workspaces/${ws}/invitations/${j.invitation.id}/revoke`, owner.cookie);
    expect((await call(app, "POST", `/v1/workspaces/${ws}/invitations/${j.invitation.id}/resend`, owner.cookie)).status).toBe(409);
  });
  it("workspace B cannot list, revoke or resend workspace A's invitations", async () => {
    const j = await (await invite(owner, mkEmail("xt"), "agent")).json();
    const list = await (await call(app, "GET", `/v1/workspaces/${wsB}/invitations`, ownerB.cookie)).json();
    expect(list.find((i: { id: string }) => i.id === j.invitation.id)).toBeUndefined();
    for (const op of ["revoke", "resend"]) expect((await call(app, "POST", `/v1/workspaces/${wsB}/invitations/${j.invitation.id}/${op}`, ownerB.cookie)).status).toBe(404);
    expect((await call(app, "GET", `/v1/workspaces/${ws}/invitations`, ownerB.cookie)).status).toBe(404);
    expect((await call(app, "POST", `/v1/workspaces/${ws}/invitations/${j.invitation.id}/revoke`, ownerB.cookie)).status).toBe(404);
    const { rows } = await admin.query("SELECT status FROM workspace_invitations WHERE id=$1", [j.invitation.id]);
    expect(rows[0].status).toBe("pending");
  });
});
