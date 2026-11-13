import { defineConfig } from "drizzle-kit";
export default defineConfig({
  dialect: "postgresql",
  schema: ["./src/auth-schema.ts"],
  out: "./drizzle",
  dbCredentials: { url: process.env.DATABASE_URL_MIGRATOR ?? "postgres://crm_migrator:migrator_dev@127.0.0.1:5436/crm" },
});
