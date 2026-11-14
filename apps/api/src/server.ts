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
import { recoverStuckSends } from "./inbox/send.ts";
import { createShutdown } from "./shutdown.ts";
import { runTokenChecks, type MetaConnectDeps } from "./inbox/meta-connect.ts";
import { createProfileEnricher } from "./inbox/profile.ts";
import { metaUserCallbackRoutes } from "./inbox/meta-callbacks.ts";
import { createMetaGraph, createMockGraph, createSecretBox } from "@crm/integrations";
import { createHmac } from "node:crypto";

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
    EVENT_DISPATCH_IDLE_INTERVAL_MS: z.coerce.number().default(600_000), // poll this slowly when nobody has used the API for ACTIVE_WINDOW_MS
    EVENT_RETENTION_DAYS: z.coerce.number().default(30),
    // Meta Inbox. The webhook is mounted only when all three are set; the worker only when DATABASE_URL_WORKER is set.
    DATABASE_URL_INGEST: z.string().url().optional(),
    DATABASE_URL_WORKER: z.string().url().optional(),
    META_APP_SECRET: z.string().min(8).optional(),
    META_APP_SECRET_PREVIOUS: z.string().min(8).optional(),
    META_VERIFY_TOKEN: z.string().min(8).optional(),
    INBOX_WORKER_INTERVAL_MS: z.coerce.number().default(900_000), // slow safety net: the worker is event driven (ingress signals it), so an idle database can sleep
    // Meta OAuth (Slice 3). Connect endpoints are live only when all of these are set (or META_MOCK=1 with the key and worker URL).
    META_APP_ID: z.string().regex(/^[0-9]{5,30}$/).optional(),
    META_FLFB_CONFIG_ID: z.string().regex(/^[0-9]{5,30}$/).optional(),
    META_GRAPH_VERSION: z.string().regex(/^v[0-9]{2}\.0$/).default("v25.0"),
    META_OAUTH_REDIRECT_URI: z.string().url().optional(),
    META_MOCK: z.enum(["0", "1"]).default("0"),
    // Direct Instagram connection (Unified Login, no Facebook Page): the id of a Facebook Login for Business configuration marked "Instagram Login Compatible" (App Dashboard > Facebook Login for Business > Configurations), and its redirect URL.
    META_IG_CONFIG_ID: z.string().regex(/^[0-9]{5,30}$/).optional(),
    META_IG_OAUTH_REDIRECT_URI: z.string().url().optional(),
    SECRETS_ENCRYPTION_KEY: z.string().optional(),
    SECRETS_KEY_ID: z.string().min(1).max(64).default("dev1"),
    META_PUBLIC_BASE_URL: z.string().url().optional(), // public https base of this API, used in the data-deletion status link
  })
  .parse(process.env);

// Only the local development mail adapter exists; the production provider is chosen with hosting (decision D22).
// Fail closed rather than silently dropping password-reset emails in production.
if (env.NODE_ENV === "production") throw new Error("No production mail provider is configured yet (decision D22). Password reset would not work.");
const mailer = new FileMailer(env.MAIL_DIR);

const origins = [env.WEB_ORIGIN, "crm://"];
const db = createDb(env.DATABASE_URL_APP);
const auth = createAuth(db, { secret: env.BETTER_AUTH_SECRET, baseURL: env.BETTER_AUTH_URL, trustedOrigins: origins, mailer });
const workerDb = env.DATABASE_URL_WORKER ? createDb(env.DATABASE_URL_WORKER) : null;
let meta: MetaConnectDeps | undefined;
if (workerDb && env.SECRETS_ENCRYPTION_KEY && env.META_APP_SECRET && ((env.META_APP_ID && env.META_FLFB_CONFIG_ID) || env.META_MOCK === "1")) {
  if (env.NODE_ENV === "production" && env.META_MOCK === "1") throw new Error("META_MOCK is not allowed in production");
  meta = {
    graph: env.META_MOCK === "1"
      ? createMockGraph({ pages: [{ id: "100000000000001", name: "Mock Page", accessToken: "mock-page-token", tasks: ["MANAGE", "MESSAGING"], instagramAccountId: "170000000000001" }] })
      : createMetaGraph({ appId: env.META_APP_ID!, appSecret: env.META_APP_SECRET, version: env.META_GRAPH_VERSION }),
    box: createSecretBox({ [env.SECRETS_KEY_ID]: env.SECRETS_ENCRYPTION_KEY }, env.SECRETS_KEY_ID),
    workerDb, appId: env.META_APP_ID ?? "0", configId: env.META_FLFB_CONFIG_ID ?? "0", graphVersion: env.META_GRAPH_VERSION,
    redirectUri: env.META_OAUTH_REDIRECT_URI ?? `${env.WEB_ORIGIN}/v1/integrations/meta/callback`, webOrigin: env.WEB_ORIGIN,
    stateKey: createHmac("sha256", env.META_APP_SECRET).update("crm-oauth-state-v1").digest(),
    userHashKey: createHmac("sha256", Buffer.from(env.SECRETS_ENCRYPTION_KEY, "base64")).update("crm-meta-user-v1").digest(), mock: env.META_MOCK === "1", secureCookies: env.WEB_ORIGIN.startsWith("https://"),
  };
  if (env.META_IG_CONFIG_ID || env.META_MOCK === "1") meta.igUnified = { configId: env.META_IG_CONFIG_ID ?? "0", redirectUri: env.META_IG_OAUTH_REDIRECT_URI ?? `${env.WEB_ORIGIN}/v1/integrations/instagram/callback` };
  console.log(`meta connect enabled (${meta.mock ? "MOCK graph" : "real graph " + env.META_GRAPH_VERSION})`);
}
let ingestDb: ReturnType<typeof createDb> | null = null;
let inboxWorker: ReturnType<typeof startInboxWorker> | null = null; // assigned below; ingress signals it after it stores an event
const app = createApp(auth, { allowedOrigins: origins, db, meta });
if (meta && workerDb && env.META_APP_SECRET) {
  app.route("/meta/callbacks", metaUserCallbackRoutes({ appSecrets: [env.META_APP_SECRET, ...(env.META_APP_SECRET_PREVIOUS ? [env.META_APP_SECRET_PREVIOUS] : [])], workerDb, userHashKey: meta.userHashKey, statusKey: createHmac("sha256", env.META_APP_SECRET).update("crm-deletion-status-v1").digest(), publicBaseUrl: env.META_PUBLIC_BASE_URL }));
}
if (env.DATABASE_URL_INGEST && env.META_APP_SECRET && env.META_VERIFY_TOKEN) {
  app.route("/webhooks/meta", metaWebhookRoutes({ appSecrets: [env.META_APP_SECRET, ...(env.META_APP_SECRET_PREVIOUS ? [env.META_APP_SECRET_PREVIOUS] : [])], verifyToken: env.META_VERIFY_TOKEN, ingestDb: (ingestDb = createDb(env.DATABASE_URL_INGEST)), onStored: () => void inboxWorker?.tick() }));
  console.log("meta webhook ingress mounted at /webhooks/meta/{messenger,instagram}");
}
inboxWorker = workerDb ? startInboxWorker(workerDb, { intervalMs: env.INBOX_WORKER_INTERVAL_MS, recover: () => recoverStuckSends(workerDb), enrich: meta ? createProfileEnricher({ workerDb, graph: meta.graph, box: meta.box }) : undefined, periodic: meta ? { everyMs: 6 * 3_600_000, run: () => runTokenChecks(meta!) } : undefined, onError: (e) => console.error(JSON.stringify({ msg: "inbox worker error", error: (e as Error).name })) }) : null;
// Activity tracking: any request except the health ping marks the system active. While idle the event dispatcher polls slowly (an idle free database can sleep) and wakes when a request arrives.
const ACTIVE_WINDOW_MS = 120_000;
let lastActivity = Date.now();
let dispatcherRef: ReturnType<typeof startDispatcher> | null = null;
const isActive = () => Date.now() - lastActivity < ACTIVE_WINDOW_MS;
const server = serve({
  fetch: (req, ...rest) => {
    if (new URL(req.url).pathname !== "/health") {
      const wasIdle = !isActive();
      lastActivity = Date.now();
      if (wasIdle) dispatcherRef?.wake();
    }
    return app.fetch(req, ...rest);
  },
  port: env.PORT,
});
// In-process event relay (decision D7: moves to a pg-boss worker app later; dispatchPending is the unit of work).
const dispatcher = startDispatcher(db, { consumers: [notificationsConsumer], intervalMs: env.EVENT_DISPATCH_INTERVAL_MS, idleIntervalMs: env.EVENT_DISPATCH_IDLE_INTERVAL_MS, isActive, retentionDays: env.EVENT_RETENTION_DAYS });
dispatcherRef = dispatcher;
const shutdown = createShutdown({
  server,
  stoppers: [() => dispatcher.stop(), () => inboxWorker?.stop() ?? Promise.resolve()],
  pools: [db, workerDb, ingestDb].flatMap((d) => (d ? [() => d.$client.end()] : [])),
  exit: (code) => process.exit(code),
  timeoutMs: 10_000,
});
for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => void shutdown());
console.log(`api listening on :${env.PORT}`);
