import { Hono } from "hono";
import type { Db } from "@crm/db";
import type { Auth } from "./auth.ts";
import { workspaceRoutes, type Vars } from "./routes/workspaces.ts";

export function createApp(auth: Auth, opts: { allowedOrigins: string[]; db: Db }) {
  const app = new Hono<{ Variables: Vars }>();
  // Mutating requests that carry an Origin header must come from an allowed origin (native apps send none).
  app.use("*", async (c, next) => {
    const origin = c.req.header("origin");
    if (!["GET", "HEAD", "OPTIONS"].includes(c.req.method) && origin && !opts.allowedOrigins.includes(origin)) {
      return c.json({ error: { code: "origin_not_allowed" } }, 403);
    }
    const requestId = c.req.header("x-request-id") ?? crypto.randomUUID();
    c.set("requestId", requestId);
    await next();
    c.res.headers.set("x-request-id", requestId);
  });
  app.get("/health", (c) => c.json({ ok: true }));
  app.on(["GET", "POST"], "/api/auth/*", (c) => auth.handler(c.req.raw));

  const v1 = new Hono<{ Variables: Vars }>();
  v1.use("*", async (c, next) => {
    const session = await auth.api.getSession({ headers: c.req.raw.headers });
    if (!session) return c.json({ error: { code: "unauthenticated" } }, 401);
    c.set("userId", session.user.id);
    c.set("me" as never, session.user as never);
    await next();
  });
  v1.get("/me", (c) => {
    const u = c.get("me" as never) as { id: string; email: string; name: string };
    return c.json({ id: u.id, email: u.email, name: u.name });
  });
  v1.route("/workspaces", workspaceRoutes(opts.db));
  app.route("/v1", v1);
  return app;
}
