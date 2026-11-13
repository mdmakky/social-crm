import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { sql } from "drizzle-orm";
import pg from "pg";

export type Db = NodePgDatabase & { $client: pg.Pool };
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

export function createDb(url: string): Db {
  return drizzle(new pg.Pool({ connectionString: url, max: 10 })) as Db;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type RequestContext = { userId?: string; workspaceId?: string };

/**
 * Runs fn in a transaction with app.user_id / app.workspace_id set. Settings are transaction-local,
 * so they cannot leak across pooled connections.
 */
export async function withContext<T>(db: Db, ctx: RequestContext, fn: (tx: Tx) => Promise<T>): Promise<T> {
  if (ctx.workspaceId !== undefined && !UUID.test(ctx.workspaceId)) throw new Error("invalid workspace id");
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT set_config('app.workspace_id', ${ctx.workspaceId ?? ""}, true), set_config('app.user_id', ${ctx.userId ?? ""}, true)`);
    return fn(tx);
  });
}

export function withWorkspace<T>(db: Db, workspaceId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return withContext(db, { workspaceId }, fn);
}

export * as schema from "./schema/index.ts";
export { user } from "./auth-schema.ts";
