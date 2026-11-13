import { describe, expect, it } from "vitest";
import { createMetaGraph, createSecretBox, GraphError } from "../src/index.ts";

const K1 = Buffer.alloc(32, 1).toString("base64");
const K2 = Buffer.alloc(32, 2).toString("base64");

describe("secret box", () => {
  it("round-trips, binds the AAD, detects tampering, rotates keys and rejects bad key sizes", () => {
    const a = createSecretBox({ k1: K1 }, "k1");
    const s = a.seal("page-token", "ws:acct");
    expect(s.ciphertext.length).toBeGreaterThanOrEqual(17);
    expect(s.ciphertext.toString("utf8")).not.toContain("page-token");
    expect(a.open(s, "ws:acct")).toBe("page-token");
    expect(() => a.open(s, "ws:other")).toThrow();
    const t = Buffer.from(s.ciphertext); t[0] = (t[0] ?? 0) ^ 1;
    expect(() => a.open({ ...s, ciphertext: t }, "ws:acct")).toThrow();
    expect(a.seal("x", "a").nonce.equals(a.seal("x", "a").nonce)).toBe(false);
    const rotated = createSecretBox({ k1: K1, k2: K2 }, "k2"); // old rows stay readable after the current key changes
    expect(rotated.open(s, "ws:acct")).toBe("page-token");
    expect(rotated.seal("y", "a").keyId).toBe("k2");
    expect(() => createSecretBox({ k1: Buffer.alloc(16).toString("base64") }, "k1")).toThrow();
    expect(() => createSecretBox({ k1: K1 }, "nope")).toThrow();
  });
});

type Call = { url: URL; init: RequestInit };
const graphWith = (replies: Array<{ status?: number; json: unknown } | "network">) => {
  const calls: Call[] = [];
  const fetchFn = (async (url: URL, init: RequestInit) => {
    calls.push({ url, init });
    const r = replies.shift()!;
    if (r === "network") throw new TypeError("fetch failed: https://x?client_secret=SECRET");
    return new Response(JSON.stringify(r.json), { status: r.status ?? 200 });
  }) as unknown as typeof fetch;
  return { calls, g: createMetaGraph({ appId: "111", appSecret: "SECRET", version: "v25.0", fetch: fetchFn }) };
};

describe("Graph client (injected fetch; NOT Meta)", () => {
  it("exchanges the code and the long-lived token with the documented parameters", async () => {
    const { g, calls } = graphWith([{ json: { access_token: "short", expires_in: 3600 } }, { json: { access_token: "long", expires_in: 5183944 } }]);
    expect(await g.exchangeCode("CODE", "https://app/cb")).toEqual({ accessToken: "short", expiresInSec: 3600 });
    expect(calls[0]!.url.pathname).toBe("/v25.0/oauth/access_token");
    expect(Object.fromEntries(calls[0]!.url.searchParams)).toMatchObject({ client_id: "111", redirect_uri: "https://app/cb", code: "CODE" });
    expect(await g.exchangeLongLived("short")).toEqual({ accessToken: "long", expiresInSec: 5183944 });
    expect(calls[1]!.url.searchParams.get("grant_type")).toBe("fb_exchange_token");
    expect(calls[1]!.url.searchParams.get("fb_exchange_token")).toBe("short");
  });

  it("lists Pages with the token in the Authorization header (never the URL), follows paging, skips malformed rows", async () => {
    const { g, calls } = graphWith([
      { json: { data: [{ id: "1", name: "A", access_token: "ta", tasks: ["MANAGE"], instagram_business_account: { id: "9" } }, { id: "2" }], paging: { cursors: { after: "c1" }, next: "https://next" } } },
      { json: { data: [{ id: "3", name: "C", access_token: "tc" }] } },
    ]);
    const pages = await g.listPages("USERTOKEN");
    expect(pages).toEqual([
      { id: "1", name: "A", accessToken: "ta", tasks: ["MANAGE"], instagramAccountId: "9" },
      { id: "3", name: "C", accessToken: "tc", tasks: [], instagramAccountId: null },
    ]);
    expect(calls[0]!.url.toString()).not.toContain("USERTOKEN");
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe("Bearer USERTOKEN");
    expect(calls[1]!.url.searchParams.get("after")).toBe("c1");
  });

  it("subscribes, unsubscribes and debugs tokens with the documented methods", async () => {
    const { g, calls } = graphWith([{ json: { success: true } }, { json: { success: true } }, { json: { data: { is_valid: true, expires_at: 2_000_000_000, scopes: ["pages_messaging"] } } }, { json: { data: { is_valid: false, error: { code: 190 } } } }]);
    expect(await g.subscribePage("55", "PT", ["messages", "message_echoes"])).toBe(true);
    expect(calls[0]!.init.method).toBe("POST");
    expect(String(calls[0]!.init.body)).toBe("subscribed_fields=messages%2Cmessage_echoes");
    expect(calls[0]!.url.pathname).toBe("/v25.0/55/subscribed_apps");
    expect(await g.unsubscribePage("55", "PT")).toBe(true);
    expect(calls[1]!.init.method).toBe("DELETE");
    expect(await g.debugToken("TT")).toEqual({ isValid: true, expiresAt: new Date(2_000_000_000_000), scopes: ["pages_messaging"], errorCode: null });
    expect(calls[2]!.url.searchParams.get("input_token")).toBe("TT");
    expect((calls[2]!.init.headers as Record<string, string>).authorization).toBe("Bearer 111|SECRET");
    expect(await g.debugToken("TT")).toMatchObject({ isValid: false, errorCode: 190 });
  });

  it("maps errors to kinds and never leaks a token or secret in the error", async () => {
    const cases: [number, number, GraphError["kind"]][] = [[190, 400, "auth"], [4, 400, "throttle"], [17, 400, "throttle"], [10, 403, "permission"], [200, 403, "permission"], [100, 400, "other"]];
    for (const [code, status, kind] of cases) {
      const { g } = graphWith([{ status, json: { error: { code, message: "token EAAB123 invalid" } } }]);
      const e = (await g.listPages("T").catch((x) => x)) as GraphError;
      expect(e).toBeInstanceOf(GraphError);
      expect([e.code, e.kind]).toEqual([code, kind]);
      expect(e.message).not.toContain("EAAB123");
    }
    const { g } = graphWith(["network"]);
    const e = (await g.exchangeCode("c", "r").catch((x) => x)) as GraphError;
    expect(e).toBeInstanceOf(GraphError);
    expect(e.message).not.toContain("SECRET");
    const bad = graphWith([{ json: { token_type: "bearer" } }]);
    await expect(bad.g.exchangeCode("c", "r")).rejects.toBeInstanceOf(GraphError); // 200 without a token
  });
});
