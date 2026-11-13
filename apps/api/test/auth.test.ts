import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { createDb, type Db } from "@crm/db";
import { createAuth } from "../src/auth.ts";
import { createApp } from "../src/app.ts";

const APP_URL = process.env.DATABASE_URL_APP ?? "postgres://crm_app:app_dev@127.0.0.1:5436/crm";
const ADMIN_URL = "postgres://postgres:postgres@127.0.0.1:5436/crm";
const ORIGIN = "http://localhost:3000";
const email = `spike-${Date.now()}@example.com`;
const password = "correct-horse-battery";

let db: Db;
let app: ReturnType<typeof createApp>;
let cookie = "";
let bearer = "";

const json = (body: unknown) => ({ method: "POST", headers: { "content-type": "application/json", origin: ORIGIN }, body: JSON.stringify(body) });

beforeAll(() => {
  db = createDb(APP_URL);
  const auth = createAuth(db, { secret: "test-secret-".padEnd(40, "x"), baseURL: "http://localhost:8787", trustedOrigins: [ORIGIN, "crm://"] });
  app = createApp(auth, { allowedOrigins: [ORIGIN], db });
});
afterAll(async () => { await db.$client.end(); });

describe("auth against real Postgres", () => {
  it("registers a user", async () => {
    const res = await app.request("/api/auth/sign-up/email", json({ email, password, name: "Spike" }));
    expect(res.status).toBe(200);
  });
  it("rejects a weak password", async () => {
    const res = await app.request("/api/auth/sign-up/email", json({ email: "w@example.com", password: "short", name: "W" }));
    expect(res.status).toBe(400);
  });
  it("signs in and returns a cookie and a bearer token header", async () => {
    const res = await app.request("/api/auth/sign-in/email", json({ email, password }));
    expect(res.status).toBe(200);
    cookie = (res.headers.get("set-cookie") ?? "").split(";")[0]!;
    bearer = res.headers.get("set-auth-token") ?? "";
    expect(cookie).toContain("=");
    expect(bearer.length).toBeGreaterThan(10);
  });
  it("GET /v1/me works with the cookie", async () => {
    const res = await app.request("/v1/me", { headers: { cookie } });
    expect(res.status).toBe(200);
    expect((await res.json()).email).toBe(email);
  });
  it("GET /v1/me works with the bearer token (mobile path)", async () => {
    const res = await app.request("/v1/me", { headers: { authorization: `Bearer ${bearer}` } });
    expect(res.status).toBe(200);
    expect((await res.json()).email).toBe(email);
  });
  it("GET /v1/me is 401 without credentials or with a bad token", async () => {
    expect((await app.request("/v1/me")).status).toBe(401);
    expect((await app.request("/v1/me", { headers: { authorization: "Bearer nope" } })).status).toBe(401);
  });
  it("rejects a sign-in from an untrusted origin", async () => {
    const res = await app.request("/api/auth/sign-in/email", { ...json({ email, password }), headers: { "content-type": "application/json", origin: "http://evil.example" } });
    expect(res.status).toBe(403);
  });
  it("records the session expiry (sliding 30 days) and no refresh token column", async () => {
    const admin = new pg.Client({ connectionString: ADMIN_URL });
    await admin.connect();
    const r = await admin.query("SELECT extract(epoch FROM (expires_at - created_at))/86400 AS days FROM session ORDER BY created_at DESC LIMIT 1");
    const cols = await admin.query("SELECT column_name FROM information_schema.columns WHERE table_name='session'");
    await admin.end();
    expect(Math.round(Number(r.rows[0].days))).toBe(30);
    expect(cols.rows.map((c) => c.column_name)).not.toContain("refresh_token");
  });
});
