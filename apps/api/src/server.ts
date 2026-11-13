import { serve } from "@hono/node-server";
import { z } from "zod";
import { FileMailer } from "@crm/core";
import { createDb } from "@crm/db";
import { createAuth } from "./auth.ts";
import { createApp } from "./app.ts";

const env = z
  .object({
    DATABASE_URL_APP: z.string().url(),
    BETTER_AUTH_SECRET: z.string().min(32),
    BETTER_AUTH_URL: z.string().url(),
    WEB_ORIGIN: z.string().url().default("http://localhost:3000"),
    PORT: z.coerce.number().default(8787),
    NODE_ENV: z.string().default("development"),
    MAIL_DIR: z.string().default(".dev-mail"),
  })
  .parse(process.env);

// Only the local development mail adapter exists; the production provider is chosen with hosting (decision D22).
// Fail closed rather than silently dropping password-reset emails in production.
if (env.NODE_ENV === "production") throw new Error("No production mail provider is configured yet (decision D22). Password reset would not work.");
const mailer = new FileMailer(env.MAIL_DIR);

const origins = [env.WEB_ORIGIN, "crm://"];
const db = createDb(env.DATABASE_URL_APP);
const auth = createAuth(db, { secret: env.BETTER_AUTH_SECRET, baseURL: env.BETTER_AUTH_URL, trustedOrigins: origins, mailer });
serve({ fetch: createApp(auth, { allowedOrigins: origins, db }).fetch, port: env.PORT });
console.log(`api listening on :${env.PORT}`);
