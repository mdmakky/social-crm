import type { NextRequest } from "next/server";

const API_URL = process.env.API_URL ?? "http://localhost:8787";

/**
 * Public proxy for the website chat widget: /public/widget/* on the web origin goes to the API's /public/widget/*, and nothing else does.
 * Unlike the rewrite used for /v1, this is a route handler so it can choose what crosses: only the headers below are forwarded (never cookies, so a signed-in agent's session cookie never reaches
 * the public API), and only the content type of the answer comes back (never Set-Cookie). The path is limited to the visitor routes.
 */
const FORWARD = ["content-type", "authorization", "origin", "x-widget-host", "x-widget-preview", "user-agent"];
const PATH = /^[A-Za-z0-9_-]{22,64}\/(config|sessions|messages|contact)$/;

async function handle(req: NextRequest, ctx: { params: Promise<{ path: string[] }> }) {
  const path = (await ctx.params).path.join("/");
  if (!PATH.test(path)) return Response.json({ error: { code: "not_found" } }, { status: 404 });
  if (Number(req.headers.get("content-length") ?? 0) > 8192) return Response.json({ error: { code: "too_large", message: "That message is too large." } }, { status: 413 });
  const headers = new Headers();
  for (const h of FORWARD) {
    const v = req.headers.get(h);
    if (v) headers.set(h, v);
  }
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  if (ip) headers.set("x-forwarded-for", ip);
  try {
    const res = await fetch(`${API_URL}/public/widget/${path}${req.nextUrl.search}`, {
      method: req.method, headers, body: req.method === "POST" ? await req.text() : undefined, cache: "no-store", signal: AbortSignal.timeout(15_000), redirect: "manual",
    });
    // The API sets Access-Control-Allow-Origin only for an allowed site; the loader on that site reads /config cross-origin to decide whether to show the launcher, so it must reach the browser.
    const out: Record<string, string> = { "content-type": res.headers.get("content-type") ?? "application/json", "cache-control": "no-store" };
    const acao = res.headers.get("access-control-allow-origin");
    if (acao) { out["access-control-allow-origin"] = acao; out.vary = "Origin"; }
    return new Response(await res.text(), { status: res.status, headers: out });
  } catch {
    return Response.json({ error: { code: "unavailable", message: "Chat is not reachable right now." } }, { status: 502 });
  }
}

export { handle as GET, handle as POST };
