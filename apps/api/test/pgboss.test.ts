import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PgBoss, fromDrizzle } from "pg-boss";
import { sql } from "drizzle-orm";
import { createDb, type Db } from "@crm/db";

const MIGRATOR = "postgres://crm_migrator:migrator_dev@127.0.0.1:5436/" + (process.env.CRM_DB_NAME ?? "crm") + "";
const APP = "postgres://crm_app:app_dev@127.0.0.1:5436/" + (process.env.CRM_DB_NAME ?? "crm") + "";
const Q = "spike-queue";

let boss: PgBoss;
let owner: Db; // role that owns pgboss tables
let app: Db; // request-path role

const count = async () => Number((await owner.execute(sql`SELECT count(*)::int AS n FROM pgboss.job WHERE name = ${Q}`)).rows[0]!.n);

beforeAll(async () => {
  boss = new PgBoss(MIGRATOR);
  boss.on("error", () => {});
  await boss.start();
  await boss.createQueue(Q);
  owner = createDb(MIGRATOR);
  app = createDb(APP);
  await owner.execute(sql`DELETE FROM pgboss.job WHERE name = ${Q}`);
});
afterAll(async () => {
  await boss.stop({ graceful: false });
  await owner.$client.end();
  await app.$client.end();
});

describe("pg-boss enqueue inside an application transaction", () => {
  it("commit leaves exactly one job", async () => {
    const before = await count();
    await owner.transaction(async (tx) => {
      await boss.send(Q, { n: 1 }, { db: fromDrizzle(tx, sql) });
    });
    expect(await count()).toBe(before + 1);
  });
  it("rollback leaves no job", async () => {
    const before = await count();
    await expect(
      owner.transaction(async (tx) => {
        await boss.send(Q, { n: 2 }, { db: fromDrizzle(tx, sql) });
        throw new Error("abort");
      }),
    ).rejects.toThrow("abort");
    expect(await count()).toBe(before);
  });
  it("RECORD: the request-path role crm_app cannot enqueue without explicit grants", async () => {
    let denied = false;
    try {
      await app.transaction(async (tx) => {
        await boss.send(Q, { n: 3 }, { db: fromDrizzle(tx, sql) });
      });
    } catch {
      denied = true;
    }
    expect(denied).toBe(true);
  });
});
