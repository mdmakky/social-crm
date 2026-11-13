import { describe, expect, expectTypeOf, it } from "vitest";
import { endpoints } from "@crm/contracts";
import { createApiClient, type ApiResult } from "../src/index.ts";

const WS = "11111111-1111-4111-8111-111111111111";
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
type Call = { url: string; init: RequestInit };

function setup(respond: (c: Call) => Response | Promise<Response>, opts: Partial<Parameters<typeof createApiClient>[0]> = {}) {
  const calls: Call[] = [];
  const fetchFn = (async (url: string, init: RequestInit) => {
    const c = { url, init };
    calls.push(c);
    return respond(c);
  }) as unknown as typeof fetch;
  return { calls, client: createApiClient({ baseUrl: "https://api.test", auth: { mode: "cookie" }, fetch: fetchFn, ...opts }) };
}
const err = <T>(r: ApiResult<T>) => (r.ok ? (() => { throw new Error("expected failure"); })() : r.error);

describe("typed calls", () => {
  it("substitutes and encodes path params, and validates the response", async () => {
    const { client, calls } = setup(() => json({ id: WS, name: "Acme", slug: "acme-x", role: "owner", timezone: "UTC", memberCount: 1, createdAt: "2026-11-13T00:00:00Z" }));
    const r = await client.call(endpoints.getWorkspace, { params: { workspaceId: WS } });
    expect(r.ok && r.data.memberCount).toBe(1);
    expect(calls[0]!.url).toBe(`https://api.test/v1/workspaces/${WS}`);
    const e = setup(() => json({ error: { code: "not_found" } }, 404));
    await e.client.call(endpoints.getWorkspace, { params: { workspaceId: "a/b?c" } });
    expect(e.calls[0]!.url).toBe("https://api.test/v1/workspaces/a%2Fb%3Fc");
  });
  it("serialises query parameters and omits undefined ones", async () => {
    const { client, calls } = setup(() => json({ items: [], nextCursor: null }));
    await client.call(endpoints.auditLog, { params: { workspaceId: WS }, query: { limit: 5 } });
    expect(calls[0]!.url).toBe(`https://api.test/v1/workspaces/${WS}/audit-log?limit=5`);
  });
  it("sends validated JSON bodies and rejects invalid ones before any network call", async () => {
    const { client, calls } = setup(() => json({ id: WS, name: "Acme", slug: "acme", role: "owner" }, 201));
    expect((await client.call(endpoints.createWorkspace, { body: { name: "Acme" } })).ok).toBe(true);
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ name: "Acme" });
    const bad = await client.call(endpoints.createWorkspace, { body: { name: "x" } });
    expect(err(bad).kind).toBe("invalid_request");
    expect(calls).toHaveLength(1);
  });
  it("treats 204 as success with no data", async () => {
    const { client } = setup(() => new Response(null, { status: 204 }));
    const r = await client.call(endpoints.removeMember, { params: { workspaceId: WS, userId: "u1" } });
    expect(r).toEqual({ ok: true, data: undefined });
  });
  it("infers input and output types from the endpoint", async () => {
    const { client } = setup(() => json({ id: "u", email: "a@b.co", name: "A" }));
    const r = await client.call(endpoints.me);
    if (r.ok) expectTypeOf(r.data.email).toEqualTypeOf<string>();
    expect(r.ok).toBe(true);
  });
});

describe("authentication modes", () => {
  it("cookie mode sends same-origin credentials and no Authorization header", async () => {
    const { client, calls } = setup(() => json({ id: "u", email: "a@b.co", name: "A" }));
    await client.call(endpoints.me);
    expect(calls[0]!.init.credentials).toBe("include");
    expect(new Headers(calls[0]!.init.headers).get("authorization")).toBeNull();
  });
  it("credentials can be overridden for native clients that send a manual Cookie header", async () => {
    const { client, calls } = setup(() => json({ id: "u", email: "a@b.co", name: "A" }), { credentials: "omit", headers: () => ({ cookie: "better-auth.session_token=x" }) });
    await client.call(endpoints.me);
    expect(calls[0]!.init.credentials).toBe("omit");
    expect(new Headers(calls[0]!.init.headers).get("cookie")).toBe("better-auth.session_token=x");
  });
  it("bearer mode sends the token and omits cookies", async () => {
    const { client, calls } = setup(() => json({ id: "u", email: "a@b.co", name: "A" }), { auth: { mode: "bearer", getToken: async () => "tok123" } });
    await client.call(endpoints.me);
    expect(new Headers(calls[0]!.init.headers).get("authorization")).toBe("Bearer tok123");
    expect(calls[0]!.init.credentials).toBe("omit");
  });
  it("bearer mode without a token still sends the request (the server answers 401)", async () => {
    const { client, calls } = setup(() => json({ error: { code: "unauthenticated" } }, 401), { auth: { mode: "bearer", getToken: async () => null } });
    const r = await client.call(endpoints.me);
    expect(new Headers(calls[0]!.init.headers).get("authorization")).toBeNull();
    expect(err(r)).toMatchObject({ kind: "http", status: 401, code: "unauthenticated" });
  });
  it("extra headers (server-side cookie forwarding) are merged", async () => {
    const { client, calls } = setup(() => json({ id: "u", email: "a@b.co", name: "A" }), { headers: async () => ({ cookie: "s=1" }) });
    await client.call(endpoints.me);
    expect(new Headers(calls[0]!.init.headers).get("cookie")).toBe("s=1");
  });
  it("calls onUnauthorized once per 401 so apps can sign the user out", async () => {
    let n = 0;
    const { client } = setup(() => json({ error: { code: "unauthenticated" } }, 401), { onUnauthorized: () => void n++ });
    await client.call(endpoints.me);
    expect(n).toBe(1);
  });
});

// Mock-based tests of the wiring apps/mobile/App.tsx uses (manual Cookie header read per request, 401 handling).
// NOT runtime verification: no emulator, SecureStore or real API is involved. See docs/project/android-verification.md.
describe("mobile session wiring (mock only)", () => {
  const me = { id: "u", email: "a@b.co", name: "A" };
  it("reads the stored cookie on every call: login, restore after restart and logout are all picked up", async () => {
    let stored: string | null = null; // stands in for authClient.getCookie() backed by SecureStore
    const { client, calls } = setup(() => json(me), { credentials: "omit", headers: async () => ({ cookie: stored ?? "" }) });
    stored = "better-auth.session_token=abc";
    await client.call(endpoints.me);
    stored = null;
    await client.call(endpoints.me);
    expect(new Headers(calls[0]!.init.headers).get("cookie")).toBe("better-auth.session_token=abc");
    expect(new Headers(calls[1]!.init.headers).get("cookie")).toBeFalsy();
  });
  it("an expired session yields a typed 401 error (no throw) and notifies onUnauthorized each time", async () => {
    let n = 0;
    const { client } = setup(() => json({ error: { code: "unauthenticated", message: "Session expired" } }, 401), { credentials: "omit", headers: () => ({ cookie: "better-auth.session_token=stale" }), onUnauthorized: () => void n++ });
    const r = [await client.call(endpoints.me), await client.call(endpoints.me)];
    expect(r.map((x) => err(x))).toEqual([expect.objectContaining({ kind: "http", status: 401, code: "unauthenticated" }), expect.objectContaining({ status: 401 })]);
    expect(n).toBe(2);
  });
});

describe("errors", () => {
  it("maps API error bodies to typed errors", async () => {
    const { client } = setup(() => json({ error: { code: "last_owner", message: "nope" } }, 403));
    const r = await client.call(endpoints.updateMember, { params: { workspaceId: WS, userId: "u" }, body: { role: "admin" } });
    expect(err(r)).toMatchObject({ kind: "http", status: 403, code: "last_owner", message: "nope" });
  });
  it("reports a network failure without throwing", async () => {
    const { client } = setup(() => { throw new TypeError("fetch failed"); });
    expect(err(await client.call(endpoints.me))).toMatchObject({ kind: "network", code: "network" });
  });
  it("times out slow requests", async () => {
    const { client } = setup((c) => new Promise((_, reject) => (c.init.signal as AbortSignal).addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")))), { timeoutMs: 20 });
    expect(err(await client.call(endpoints.me))).toMatchObject({ kind: "timeout", code: "timeout" });
  });
  it("detects contract drift: a 2xx body that does not match the schema", async () => {
    const { client } = setup(() => json({ id: 5, email: "not-an-email" }));
    const e = err(await client.call(endpoints.me));
    expect(e.kind).toBe("contract");
    expect(e.message).toMatch(/does not match/);
  });
  it("handles non-JSON error bodies", async () => {
    const { client } = setup(() => new Response("<html>bad gateway</html>", { status: 502, headers: { "content-type": "text/html" } }));
    expect(err(await client.call(endpoints.me))).toMatchObject({ kind: "http", status: 502, code: "http_502" });
  });
});
