import { NextResponse, type NextRequest } from "next/server";

const API_URL = process.env.API_URL ?? "http://localhost:8787";
const ORIGIN = /^https?:\/\/[a-z0-9.-]+(:[0-9]{1,5})?$/;

/**
 * The widget page is the only page of this app that may be framed, and only by the sites the widget's owner listed. The browser enforces it (frame-ancestors), so a site that is not on the list
 * shows an empty frame. If the list cannot be read, or is empty, the answer is 'none': failing closed, never "any site".
 */
export async function proxy(request: NextRequest) {
  const key = request.nextUrl.pathname.split("/")[2] ?? "";
  let origins: string[] = [];
  if (/^[A-Za-z0-9_-]{22,64}$/.test(key)) {
    try {
      const r = await fetch(`${API_URL}/public/widget/_frame/${key}`, { cache: "no-store", signal: AbortSignal.timeout(5000) });
      if (r.ok) origins = ((await r.json()) as { origins?: string[] }).origins?.filter((o) => ORIGIN.test(o)) ?? [];
    } catch {
      origins = [];
    }
  }
  const res = NextResponse.next();
  // Owner preview (D270): the sample page on our own origin may frame the widget. Anyone can add ?preview=, but 'self' is only our own pages, and the API still demands a valid grant for every call.
  if (request.nextUrl.searchParams.has("preview")) origins = [...origins, "'self'"];
  res.headers.set("Content-Security-Policy", `frame-ancestors ${origins.length ? origins.join(" ") : "'none'"}; base-uri 'self'; form-action 'self'; object-src 'none'`);
  return res;
}

export const config = { matcher: "/widget/:key" };
