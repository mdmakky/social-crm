import { Hono } from "hono";
import type { Auth } from "./auth.ts";

export function createApp(auth: Auth, opts: { allowedOrigins: string[] }) {
  const app = new Hono();
  // Mutating requests that carry an Origin header must come from an allowed origin (native apps send none).
  app.use("*", async (c, next) => {
    const origin = c.req.header("origin");
    if (!["GET", "HEAD", "OPTIONS"].includes(c.req.method) && origin && !opts.allowedOrigins.includes(origin)) {
      return c.json({ error: { code: "origin_not_allowed" } }, 403);
    }
    await next();
  });
  app.get("/health", (c) => c.json({ ok: true }));
  app.on(["GET", "POST"], "/api/auth/*", (c) => auth.handler(c.req.raw));
  app.get("/v1/me", async (c) => {
    const session = await auth.api.getSession({ headers: c.req.raw.headers });
    if (!session) return c.json({ error: { code: "unauthenticated" } }, 401);
    return c.json({ id: session.user.id, email: session.user.email, name: session.user.name });
  });
  return app;
}
