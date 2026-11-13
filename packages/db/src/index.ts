import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { sql } from "drizzle-orm";
import pg from "pg";

export type Db = NodePgDatabase & { $client: pg.Pool };
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

export function createDb(url: string): Db {
  return drizzle(new pg.Pool({ connectionString: url, max: 10 })) as Db;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Runs fn in a transaction with app.workspace_id set (transaction-local, so it cannot leak across pooled connections). */
export async function withWorkspace<T>(db: Db, workspaceId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  if (!UUID.test(workspaceId)) throw new Error("invalid workspace id");
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT set_config('app.workspace_id', ${workspaceId}, true)`);
    return fn(tx);
  });
}
