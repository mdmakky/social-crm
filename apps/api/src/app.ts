import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { capiRoutes } from "./capi/routes.ts"; // track:capi
import { aiRoutes } from "./ai/routes.ts"; // track:ai
import { agentRoutes } from "./ai/agents.ts"; // track:ai
import { createMediaService } from "./ai/media.ts"; // track:ai
import type { AiDeps } from "./ai/run.ts"; // track:ai
import type { ModelBrowser } from "./ai/openrouter-browser.ts"; // track:ai
import type { KnowledgeDeps } from "./knowledge/routes.ts"; // track:knowledge
import { whatsappConnect, type WhatsAppLimits } from "./inbox/whatsapp-connect.ts";
import { attachmentRoutes, type AttachmentRouteDeps } from "./attachments/routes.ts"; // track:inbox
import { instagramUnified } from "./inbox/instagram-unified.ts";
import { metaConnect, type MetaConnectDeps } from "./inbox/meta-connect.ts";
import { emailConnect, type EmailDeps } from "./inbox/email-connect.ts";
import { HTTPException } from "hono/http-exception";
import type { Db } from "@crm/db";
import type { Auth } from "./auth.ts";
import type { ScopedEnv } from "./routes/scope.ts";
import { workspaceRoutes, type Vars } from "./routes/workspaces.ts";
import { isAllowedRedirect } from "./redirects.ts";
import type { ImportHooks } from "./routes/imports.ts";
import type { SearchProvider } from "./search/types.ts"; // track:search
import { WindowCounter } from "./throttle.ts";
import type { Mailer } from "@crm/core";
import { invitationRoutes, type InvitationDeps } from "./invitations.ts"; // track:invitations

/** Same body Better Auth returns for any address, so throttled and unknown requests are indistinguishable from real ones. */
const GENERIC_RESET_RESPONSE = { status: true, message: "If this email exists in our system, check your email for the reset link" };
const sha = async (s: string) => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s.trim().toLowerCase()))), (b) => b.toString(16).padStart(2, "0")).join("");

export function createApp(auth: Auth, opts: { allowedOrigins: string[]; db: Db; resetThrottle?: { perEmail: number; perIp: number; windowMs: number; tokenAttemptsPerIp?: number }; testHooks?: { waLimits?: Partial<WhatsAppLimits>; capiCreatesPerUser?: number; import?: ImportHooks; extraSearchProviders?: SearchProvider[]; aiConfigsPerUser?: number; aiSuggestionsPerUser?: number; aiAgentRunsPerUser?: number; openrouterBrowser?: ModelBrowser; openrouterBrowsesPerUser?: number; mediaLimits?: { perWorkspace?: number; windowMs?: number }; knowledge?: KnowledgeDeps }; invitations?: Pick<InvitationDeps, "limits"> & { mailer?: Mailer }; meta?: MetaConnectDeps; email?: EmailDeps; ai?: AiDeps; attachments?: AttachmentRouteDeps; openrouterBrowser?: ModelBrowser; openrouterBrowsesPerUser?: number }) {
  const app = new Hono<{ Variables: Vars }>();
  // Mutating requests that carry an Origin header must come from an allowed origin (native apps send none).
  app.use("*", async (c, next) => {
    const origin = c.req.header("origin");
    if (!["GET", "HEAD", "OPTIONS"].includes(c.req.method) && origin && !opts.allowedOrigins.includes(origin)) {
      return c.json({ error: { code: "origin_not_allowed" } }, 403);
    }
    // A client-supplied id is only kept when it looks like an id: it is echoed back and stored in the audit log.
    const supplied = c.req.header("x-request-id");
    const requestId = supplied && /^[\w-]{8,64}$/.test(supplied) ? supplied : crypto.randomUUID();
    c.set("requestId", requestId);
    await next();
    c.res.headers.set("x-request-id", requestId);
  });
  // Body size caps are enforced on the stream before anything is buffered. The CSV upload route sets its own larger cap.
  const tooLarge = (c: { json: (b: unknown, s: 413) => Response }) => c.json({ error: { code: "too_large", message: "The request is too large." } }, 413);
  app.use("/api/auth/*", bodyLimit({ maxSize: 64 * 1024, onError: (c) => tooLarge(c) }));
  const jsonLimit = bodyLimit({ maxSize: 1024 * 1024, onError: (c) => tooLarge(c) });
  // Routes that carry a file set their own cap: CSV import, knowledge file upload and the AI media routes (base64 PDF, image, audio).
  const ownCap = /^\/v1\/workspaces\/[^/]+\/(imports|knowledge\/sources\/file|conversations\/[^/]+\/attachments|ai\/media\/(describe|ask|extract|transcribe))$/;
  app.use("/v1/*", async (c, next) => (c.req.method === "POST" && ownCap.test(c.req.path) ? next() : jsonLimit(c, next)));

  /** Never returns or logs the error message: drizzle messages carry the SQL and every bound parameter (contact data, tokens). */
  app.onError((err, c) => {
    if (err instanceof HTTPException) return err.getResponse();
    const requestId = (c.get("requestId") as string | undefined) ?? "unknown";
    const cause = (err as { cause?: { code?: string; constraint?: string } }).cause ?? (err as { code?: string; constraint?: string });
    console.error(JSON.stringify({ msg: "unhandled error", requestId, method: c.req.method, path: c.req.routePath, error: err.name, code: cause?.code, constraint: cause?.constraint }));
    if (cause?.code === "55P03") return c.json({ error: { code: "busy", message: "The server is busy with another change. Try again in a moment.", requestId } }, 409);
    return c.json({ error: { code: "internal_error", message: "Something went wrong. Try again.", requestId } }, 500);
  });
  app.notFound((c) => c.json({ error: { code: "not_found" } }, 404));

  const t = opts.resetThrottle ?? { perEmail: 3, perIp: 10, windowMs: 3_600_000 };
  const byEmail = new WindowCounter(t.perEmail, t.windowMs);
  const byIp = new WindowCounter(t.perIp, t.windowMs);
  const tokenAttempts = new WindowCounter(t.tokenAttemptsPerIp ?? 20, 10 * 60_000);
  const clientIp = (c: { req: { header: (n: string) => string | undefined } }) => c.req.header("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";

  // Password reset protection. Throttled requests get the normal success body so the limit leaks nothing.
  app.post("/api/auth/request-password-reset", async (c, next) => {
    const body = (await c.req.raw.clone().json().catch(() => null)) as { email?: unknown; redirectTo?: unknown } | null;
    // The reset token is appended to this URL, so it must be one of ours. Depends only on the input, never on the account.
    if (!isAllowedRedirect(body?.redirectTo, opts.allowedOrigins)) return c.json({ error: { code: "invalid_redirect" } }, 400);
    const email = typeof body?.email === "string" ? body.email : "";
    const okIp = byIp.allow(`ip:${clientIp(c)}`);
    const okEmail = email ? byEmail.allow(`email:${await sha(email)}`) : true;
    if (!okIp || !okEmail) return c.json(GENERIC_RESET_RESPONSE);
    await next();
  });
  // Opening the emailed link redirects to callbackURL (with the token, or with an error for a bad token).
  app.get("/api/auth/reset-password/:token", async (c, next) => {
    if (!isAllowedRedirect(c.req.query("callbackURL"), opts.allowedOrigins)) return c.json({ error: { code: "invalid_redirect" } }, 400);
    await next();
  });
  app.post("/api/auth/reset-password", async (c, next) => {
    if (!tokenAttempts.allow(`ip:${clientIp(c)}`)) return c.json({ error: { code: "rate_limited", message: "Too many attempts. Try again later." } }, 429);
    await next();
  });

  app.get("/health", (c) => c.json({ ok: true }));
  app.on(["GET", "POST"], "/api/auth/*", (c) => auth.handler(c.req.raw));

  const inv = invitationRoutes(opts.db, { webOrigin: opts.allowedOrigins[0] ?? "", ...opts.invitations }); // track:invitations
  app.route("/v1", inv.preview); // public by token, registered before the session guard below
  const v1 = new Hono<{ Variables: Vars }>();
  v1.use("*", async (c, next) => {
    const session = await auth.api.getSession({ headers: c.req.raw.headers });
    if (!session) return c.json({ error: { code: "unauthenticated" } }, 401);
    c.set("userId", session.user.id);
    c.set("me" as never, session.user as never);
    await next();
  });
  v1.route("/", inv.accept);
  v1.get("/me", (c) => {
    const u = c.get("me" as never) as { id: string; email: string; name: string };
    return c.json({ id: u.id, email: u.email, name: u.name });
  });
  const media = opts.ai ? createMediaService(opts.ai, opts.testHooks?.mediaLimits) : undefined; // one instance: the knowledge upload and the media routes share its rate limit
  const meta = metaConnect(opts.db, opts.meta); // track:inbox
  const igUnified = instagramUnified(opts.db, opts.meta); // track:inbox
  v1.route("/", meta.callback);
  v1.route("/", igUnified.callback);
  v1.route("/workspaces", workspaceRoutes(opts.db, { ...opts.testHooks, invitations: inv.scoped, knowledge: { ...opts.testHooks?.knowledge, media, blobs: opts.attachments?.store }, blobs: opts.attachments?.store, metaScoped: new Hono<ScopedEnv>().route("/", meta.scoped).route("/", igUnified.scoped).route("/", whatsappConnect(opts.db, opts.meta, opts.testHooks?.waLimits)).route("/", emailConnect(opts.db, opts.email)).route("/", attachmentRoutes(opts.db, { ...opts.attachments, media })).route("/", capiRoutes(opts.db, { box: opts.meta?.box, createsPerUser: opts.testHooks?.capiCreatesPerUser })).route("/", aiRoutes(opts.db, { ai: opts.ai, media, browser: opts.openrouterBrowser ?? opts.testHooks?.openrouterBrowser, browsesPerUser: opts.openrouterBrowsesPerUser ?? opts.testHooks?.openrouterBrowsesPerUser, configsPerUser: opts.testHooks?.aiConfigsPerUser, suggestionsPerUser: opts.testHooks?.aiSuggestionsPerUser })).route("/", agentRoutes(opts.db, { ai: opts.ai, runsPerUser: opts.testHooks?.aiAgentRunsPerUser, attach: { store: opts.attachments?.store, media } })), sendDeps: opts.meta, sendEmail: opts.email, sendBlobs: opts.attachments?.store }));
  app.route("/v1", v1);
  return app;
}
