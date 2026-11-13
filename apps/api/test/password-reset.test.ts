import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileMailer } from "@crm/core";
import { createDb, type Db } from "@crm/db";
import { createAuth } from "../src/auth.ts";
import { createApp } from "../src/app.ts";

const APP_URL = process.env.DATABASE_URL_APP ?? "postgres://crm_app:app_dev@127.0.0.1:5436/" + (process.env.CRM_DB_NAME ?? "crm") + "";
const ADMIN_URL = "postgres://postgres:postgres@127.0.0.1:5436/" + (process.env.CRM_DB_NAME ?? "crm") + "";
const ORIGIN = "http://localhost:3000";
const OLD = "correct-horse-battery";
const NEW = "a-brand-new-passphrase";
const run = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
let n = 0;

let db: Db;
let admin: pg.Client;
let app: ReturnType<typeof createApp>;
let mailer: FileMailer;
let dir: string;

const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  app.request(path, { method: "POST", headers: { "content-type": "application/json", origin: ORIGIN, ...headers }, body: JSON.stringify(body) });
const email = (l: string) => `${l}-${run}-${n++}@example.com`;
const requestReset = (to: string, ip = "10.0.0.1") => post("/api/auth/request-password-reset", { email: to, redirectTo: `${ORIGIN}/reset-password` }, { "x-forwarded-for": ip });

async function signUp(to: string) {
  const res = await post("/api/auth/sign-up/email", { email: to, password: OLD, name: "Reset Tester" });
  expect(res.status).toBe(200);
  return (res.headers.get("set-cookie") ?? "").split(";")[0]!;
}
/** Mail is sent in the background (so response time reveals nothing); wait for it like a user would. */
async function waitForMails(to: string, count: number) {
  for (let i = 0; i < 40; i++) {
    const m = await mailer.messagesFor(to);
    if (m.length >= count) return m;
    await new Promise((r) => setTimeout(r, 50));
  }
  return mailer.messagesFor(to);
}
/** The token the user would get by opening the emailed link. */
async function tokenFromMail(to: string, index = -1) {
  const mails = await waitForMails(to, index >= 0 ? index + 1 : 1);
  const mail = mails.at(index);
  if (!mail) throw new Error(`no mail for ${to}`);
  const m = mail.text.match(/reset-password\/([A-Za-z0-9_-]+)/);
  if (!m) throw new Error(`no token in mail: ${mail.text}`);
  return m[1]!;
}
const reset = (token: string, newPassword: string) => post("/api/auth/reset-password", { token, newPassword });
const signIn = (to: string, password: string) => post("/api/auth/sign-in/email", { email: to, password });

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "reset-mail-"));
  mailer = new FileMailer(dir);
  db = createDb(APP_URL);
  admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  const auth = createAuth(db, { secret: "test-secret-".padEnd(40, "x"), baseURL: ORIGIN, trustedOrigins: [ORIGIN], mailer });
  app = createApp(auth, { allowedOrigins: [ORIGIN], db, resetThrottle: { perEmail: 3, perIp: 6, windowMs: 3_600_000 } });
});
afterAll(async () => {
  await db.$client.end();
  await admin.end();
  rmSync(dir, { recursive: true, force: true });
});

describe("requesting a reset", () => {
  it("sends one email with a link to an existing account", async () => {
    const to = email("exists");
    await signUp(to);
    const res = await requestReset(to);
    expect(res.status).toBe(200);
    const mails = await waitForMails(to, 1);
    expect(mails).toHaveLength(1);
    expect(mails[0]!.subject).toMatch(/reset your/i);
    expect(mails[0]!.text).toContain("30 minutes");
    expect(mails[0]!.text).toMatch(/reset-password\/[A-Za-z0-9_-]+/);
  });

  it("does not reveal whether an account exists: identical status and body, and no mail for unknown addresses", async () => {
    const known = email("known");
    const unknown = email("unknown");
    await signUp(known);
    const a = await requestReset(known, "10.0.0.2");
    const b = await requestReset(unknown, "10.0.0.3");
    expect(b.status).toBe(a.status);
    expect(await b.json()).toEqual(await a.json());
    await waitForMails(known, 1);
    await new Promise((r) => setTimeout(r, 200));
    expect(await mailer.messagesFor(unknown)).toHaveLength(0);
  });

  it("is throttled per email without changing the response, so throttling reveals nothing either", async () => {
    const to = email("throttle");
    await signUp(to);
    const bodies: unknown[] = [];
    for (let i = 0; i < 6; i++) {
      const r = await requestReset(to, `10.1.0.${i}`); // different IPs: only the per-email limit applies
      expect(r.status).toBe(200);
      bodies.push(await r.json());
    }
    expect(new Set(bodies.map((b) => JSON.stringify(b))).size).toBe(1);
    await waitForMails(to, 3);
    await new Promise((r) => setTimeout(r, 200));
    expect(await mailer.messagesFor(to)).toHaveLength(3);
  });

  it("is throttled per IP across different emails", async () => {
    const ip = "10.2.0.9";
    const addrs = Array.from({ length: 9 }, () => email("ipthrottle"));
    for (const a of addrs) {
      await signUp(a);
      await requestReset(a, ip);
    }
    await new Promise((r) => setTimeout(r, 400));
    const sent = (await Promise.all(addrs.map((a) => mailer.messagesFor(a)))).flat().length;
    expect(sent).toBe(6);
  });

  it("refuses a redirectTo outside our own origins, so a reset token can never be sent to another site", async () => {
    const to = email("redirect");
    await signUp(to);
    for (const bad of ["https://evil.example/steal", "//evil.example", "/\\evil.example", "javascript:alert(1)", "", undefined]) {
      const res = await post("/api/auth/request-password-reset", { email: to, redirectTo: bad }, { "x-forwarded-for": "10.3.0.1" });
      expect(res.status, String(bad)).toBe(400);
    }
    await new Promise((r) => setTimeout(r, 200));
    expect(await mailer.messagesFor(to)).toHaveLength(0);
    const ok = await post("/api/auth/request-password-reset", { email: to, redirectTo: "/reset-password" }, { "x-forwarded-for": "10.3.0.1" });
    expect(ok.status).toBe(200);
  });

  it("the emailed link cannot be turned into an open redirect, even with a bad token", async () => {
    for (const cb of ["https://evil.example", "//evil.example", "/\\evil.example"]) {
      const res = await app.request(`/api/auth/reset-password/not-a-token?callbackURL=${encodeURIComponent(cb)}`);
      expect(res.status, cb).toBe(400);
      expect(res.headers.get("location")).toBeNull();
    }
    const fine = await app.request(`/api/auth/reset-password/not-a-token?callbackURL=${encodeURIComponent(`${ORIGIN}/reset-password`)}`);
    expect(fine.headers.get("location") ?? "").toContain(`${ORIGIN}/reset-password`);
    expect(fine.headers.get("location") ?? "").toContain("error=");
  });

  it("keeps the Origin check for browsers", async () => {
    const res = await post("/api/auth/request-password-reset", { email: "x@example.com" }, { origin: "http://evil.example" });
    expect(res.status).toBe(403);
  });
});

describe("using a reset link", () => {
  it("sets the new password; the old one stops working; all sessions are revoked", async () => {
    const to = email("flow");
    const oldCookie = await signUp(to);
    expect((await app.request("/v1/me", { headers: { cookie: oldCookie } })).status).toBe(200);
    await requestReset(to, "10.4.0.1");
    const token = await tokenFromMail(to);
    const res = await reset(token, NEW);
    expect(res.status).toBe(200);
    expect((await signIn(to, OLD)).status).not.toBe(200);
    expect((await signIn(to, NEW)).status).toBe(200);
    expect((await app.request("/v1/me", { headers: { cookie: oldCookie } })).status).toBe(401);
  });

  it("tokens are single use", async () => {
    const to = email("single");
    await signUp(to);
    await requestReset(to, "10.4.0.2");
    const token = await tokenFromMail(to);
    expect((await reset(token, NEW)).status).toBe(200);
    expect((await reset(token, "yet-another-passphrase")).status).toBeGreaterThanOrEqual(400);
    expect((await signIn(to, NEW)).status).toBe(200);
  });

  it("expired tokens are refused", async () => {
    const to = email("expired");
    await signUp(to);
    await requestReset(to, "10.4.0.3");
    const token = await tokenFromMail(to);
    await admin.query("UPDATE verification SET expires_at = now() - interval '1 minute' WHERE identifier = $1", [`reset-password:${token}`]);
    expect((await reset(token, NEW)).status).toBeGreaterThanOrEqual(400);
    expect((await signIn(to, OLD)).status).toBe(200);
  });

  it("the token lifetime is 30 minutes", async () => {
    const to = email("ttl");
    await signUp(to);
    await requestReset(to, "10.4.0.4");
    const token = await tokenFromMail(to);
    const r = await admin.query("SELECT extract(epoch FROM (expires_at - now())) AS secs FROM verification WHERE identifier = $1", [`reset-password:${token}`]);
    expect(Number(r.rows[0].secs)).toBeGreaterThan(29 * 60);
    expect(Number(r.rows[0].secs)).toBeLessThanOrEqual(30 * 60);
  });

  it("a newer request invalidates older links", async () => {
    const to = email("newer");
    await signUp(to);
    await requestReset(to, "10.4.0.5");
    await requestReset(to, "10.4.0.6");
    const [first, second] = [await tokenFromMail(to, 0), await tokenFromMail(to, 1)];
    expect(first).not.toBe(second);
    expect((await reset(first, NEW)).status).toBeGreaterThanOrEqual(400);
    expect((await reset(second, NEW)).status).toBe(200);
  });

  it("enforces the password policy and keeps the token usable after a rejected attempt", async () => {
    const to = email("policy");
    await signUp(to);
    await requestReset(to, "10.4.0.7");
    const token = await tokenFromMail(to);
    expect((await reset(token, "short")).status).toBe(400);
    expect((await reset(token, NEW)).status).toBe(200);
  });

  it("rejects garbage tokens", async () => {
    expect((await reset("not-a-real-token", NEW)).status).toBeGreaterThanOrEqual(400);
    expect((await reset("", NEW)).status).toBeGreaterThanOrEqual(400);
  });

  it("records the reset in the audit log of each workspace the user belongs to", async () => {
    const to = email("audit");
    const cookie = await signUp(to);
    const created = await (await app.request("/v1/workspaces", { method: "POST", headers: { "content-type": "application/json", origin: ORIGIN, cookie }, body: JSON.stringify({ name: "Audit Reset Co" }) })).json();
    await requestReset(to, "10.4.0.8");
    await reset(await tokenFromMail(to), NEW);
    const rows = await admin.query("SELECT action, actor_user_id FROM audit_log WHERE workspace_id = $1 AND action = 'auth.password_reset'", [created.id]);
    expect(rows.rowCount).toBe(1);
  });

  it("is throttled by IP so tokens cannot be guessed quickly", async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 25; i++) statuses.push((await post("/api/auth/reset-password", { token: `guess-${i}`, newPassword: NEW }, { "x-forwarded-for": "10.9.9.9" })).status);
    expect(statuses.filter((s) => s === 429).length).toBeGreaterThan(0);
  });
});
