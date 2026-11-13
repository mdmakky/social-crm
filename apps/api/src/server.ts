import { serve } from "@hono/node-server";
import { z } from "zod";
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
  })
  .parse(process.env);

const origins = [env.WEB_ORIGIN, "crm://"];
const db = createDb(env.DATABASE_URL_APP);
const auth = createAuth(db, { secret: env.BETTER_AUTH_SECRET, baseURL: env.BETTER_AUTH_URL, trustedOrigins: origins });
serve({ fetch: createApp(auth, { allowedOrigins: origins, db }).fetch, port: env.PORT });
console.log(`api listening on :${env.PORT}`);
