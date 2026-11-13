import { migrate } from "drizzle-orm/node-postgres/migrator";
import { fileURLToPath } from "node:url";
import { createDb } from "./index.ts";

const url = process.env.DATABASE_URL_MIGRATOR ?? "postgres://crm_migrator:migrator_dev@127.0.0.1:5436/crm";
const db = createDb(url);
await migrate(db, { migrationsFolder: fileURLToPath(new URL("../drizzle", import.meta.url)) });
await db.$client.end();
console.log("migrations applied");
