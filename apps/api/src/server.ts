import { serve } from "@hono/node-server";
import { z } from "zod";
import { FileMailer } from "@crm/core";
import { createDb } from "@crm/db";
import { createAuth } from "./auth.ts";
import { createApp } from "./app.ts";
import { startDispatcher } from "./events.ts";
import { notificationsConsumer } from "./notifications/index.ts";
import { metaWebhookRoutes } from "./inbox/webhook.ts";
import { startInboxWorker } from "./inbox/process.ts";

const env = z
  .object({
    DATABASE_URL_APP: z.string().url(),
    BETTER_AUTH_SECRET: z.string().min(32),
    BETTER_AUTH_URL: z.string().url(),
    WEB_ORIGIN: z.string().url().default("http://localhost:3000"),
    PORT: z.coerce.number().default(8787),
    NODE_ENV: z.string().default("development"),
    MAIL_DIR: z.string().default(".dev-mail"),
    EVENT_DISPATCH_INTERVAL_MS: z.coerce.number().default(1000),
    EVENT_RETENTION_DAYS: z.coerce.number().default(30),
    // Meta Inbox. The webhook is mounted only when all three are set; the worker only when DATABASE_URL_WORKER is set.
    DATABASE_URL_INGEST: z.string().url().optional(),
    DATABASE_URL_WORKER: z.string().url().optional(),
    META_APP_SECRET: z.string().min(8).optional(),
    META_APP_SECRET_PREVIOUS: z.string().min(8).optional(),
    META_VERIFY_TOKEN: z.string().min(8).optional(),
    INBOX_WORKER_INTERVAL_MS: z.coerce.number().default(1000),
  })
  .parse(process.env);

// Only the local development mail adapter exists; the production provider is chosen with hosting (decision D22).
// Fail closed rather than silently dropping password-reset emails in production.
if (env.NODE_ENV === "production") throw new Error("No production mail provider is configured yet (decision D22). Password reset would not work.");
const mailer = new FileMailer(env.MAIL_DIR);

const origins = [env.WEB_ORIGIN, "crm://"];
const db = createDb(env.DATABASE_URL_APP);
const auth = createAuth(db, { secret: env.BETTER_AUTH_SECRET, baseURL: env.BETTER_AUTH_URL, trustedOrigins: origins, mailer });
const app = createApp(auth, { allowedOrigins: origins, db });
if (env.DATABASE_URL_INGEST && env.META_APP_SECRET && env.META_VERIFY_TOKEN) {
  app.route("/webhooks/meta", metaWebhookRoutes({ appSecrets: [env.META_APP_SECRET, ...(env.META_APP_SECRET_PREVIOUS ? [env.META_APP_SECRET_PREVIOUS] : [])], verifyToken: env.META_VERIFY_TOKEN, ingestDb: createDb(env.DATABASE_URL_INGEST) }));
  console.log("meta webhook ingress mounted at /webhooks/meta/{messenger,instagram}");
}
const inboxWorker = env.DATABASE_URL_WORKER ? startInboxWorker(createDb(env.DATABASE_URL_WORKER), { intervalMs: env.INBOX_WORKER_INTERVAL_MS, onError: (e) => console.error(JSON.stringify({ msg: "inbox worker error", error: (e as Error).name })) }) : null;
const server = serve({ fetch: app.fetch, port: env.PORT });
// In-process event relay (decision D7: moves to a pg-boss worker app later; dispatchPending is the unit of work).
const dispatcher = startDispatcher(db, { consumers: [notificationsConsumer], intervalMs: env.EVENT_DISPATCH_INTERVAL_MS, retentionDays: env.EVENT_RETENTION_DAYS });
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.once(sig, () => void Promise.all([dispatcher.stop(), inboxWorker?.stop()]).then(() => server.close(() => process.exit(0))));
}
console.log(`api listening on :${env.PORT}`);
