import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import pg from "pg";
import { sql } from "drizzle-orm";
import { createDb, withWorkspace, type Db } from "../src/index.ts";

const ADMIN = process.env.DATABASE_URL_ADMIN ?? "postgres://postgres:postgres@127.0.0.1:5436/" + (process.env.CRM_DB_NAME ?? "crm") + "";
const APP = process.env.DATABASE_URL_APP ?? "postgres://crm_app:app_dev@127.0.0.1:5436/" + (process.env.CRM_DB_NAME ?? "crm") + "";
const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";

let db: Db;
let admin: pg.Client;

beforeAll(async () => {
  admin = new pg.Client({ connectionString: ADMIN });
  await admin.connect();
  await admin.query(readFileSync(new URL("../sql/001_roles_and_probe.sql", import.meta.url), "utf8"));
  await admin.query("TRUNCATE probe.items");
  await admin.query("INSERT INTO probe.items (workspace_id, body) VALUES ($1,'a-secret'),($2,'b-secret')", [A, B]);
  db = createDb(APP);
});
afterAll(async () => {
  await db.$client.end();
  await admin.end();
});

describe("tenant isolation (RLS)", () => {
  it("workspace A sees only its own rows", async () => {
    const rows = await withWorkspace(db, A, (tx) => tx.execute("SELECT body FROM probe.items"));
    expect(rows.rows.map((r) => r.body)).toEqual(["a-secret"]);
  });
  it("no workspace context fails closed with zero rows", async () => {
    const r = await db.execute("SELECT body FROM probe.items");
    expect(r.rows).toEqual([]);
  });
  it("cannot insert a row for another workspace", async () => {
    await expect(
      withWorkspace(db, A, (tx) => tx.execute(sql`INSERT INTO probe.items (workspace_id, body) VALUES (${B}, 'x')`)),
    ).rejects.toMatchObject({ cause: { message: expect.stringMatching(/row-level security/) } });
  });
  it("cannot update or delete another workspace's rows", async () => {
    const u = await withWorkspace(db, A, (tx) => tx.execute("UPDATE probe.items SET body='hacked' WHERE workspace_id='" + B + "'"));
    const d = await withWorkspace(db, A, (tx) => tx.execute("DELETE FROM probe.items WHERE workspace_id='" + B + "'"));
    expect(u.rowCount).toBe(0);
    expect(d.rowCount).toBe(0);
  });
  it("app role is not superuser, owner or BYPASSRLS, and cannot disable RLS", async () => {
    const r = await db.execute("SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user");
    expect(r.rows[0]).toEqual({ rolsuper: false, rolbypassrls: false });
    await expect(db.execute("ALTER TABLE probe.items DISABLE ROW LEVEL SECURITY")).rejects.toMatchObject({ cause: { message: expect.stringMatching(/must be owner/) } });
  });
  it("workspace context does not leak between transactions on a pooled connection", async () => {
    await withWorkspace(db, A, (tx) => tx.execute("SELECT 1"));
    const r = await db.execute("SELECT current_setting('app.workspace_id', true) AS ws");
    expect(r.rows[0]?.ws ?? "").toBe("");
  });
});
