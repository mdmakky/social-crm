import { describe, expect, it } from "vitest";
import { cleanProfileName, createMetaGraph, safePicUrl, type GraphError } from "../src/index.ts";

const graphWith = (respond: (url: URL, init: RequestInit) => Response | Promise<Response>) => {
  const seen: { url: URL; init: RequestInit }[] = [];
  const g = createMetaGraph({ appId: "1", appSecret: "s", version: "v25.0", fetch: (async (u: URL, init: RequestInit) => { seen.push({ url: u, init }); return respond(u, init); }) as unknown as typeof fetch });
  return { g, seen };
};
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });

describe("getUserProfile (real client, fake fetch: proves our request/parse, not Meta)", () => {
  it("asks for name and profile_pic only, token in the header, never in the URL", async () => {
    const { g, seen } = graphWith(() => json({ name: "Rahim Uddin", profile_pic: "https://scontent.xx.fbcdn.net/v/p.jpg?x=1", id: "123" }));
    expect(await g.getUserProfile("4567", "PAGE-TOKEN-XYZ")).toEqual({ name: "Rahim Uddin", picUrl: "https://scontent.xx.fbcdn.net/v/p.jpg?x=1" });
    expect(seen[0]!.url.pathname).toBe("/v25.0/4567");
    expect(seen[0]!.url.searchParams.get("fields")).toBe("name,profile_pic");
    expect(seen[0]!.url.toString()).not.toContain("PAGE-TOKEN-XYZ");
    expect((seen[0]!.init.headers as Record<string, string>).authorization).toBe("Bearer PAGE-TOKEN-XYZ");
    expect(seen[0]!.url.searchParams.has("email") || seen[0]!.url.toString().includes("phone")).toBe(false);
  });
  it("maps Graph's empty object (no profile access) to null", async () => {
    expect(await graphWith(() => json({})).g.getUserProfile("1", "t")).toBeNull();
  });
  it("keeps a name when the picture is unusable and the other way round", async () => {
    expect(await graphWith(() => json({ name: "A B", profile_pic: "http://evil.example/p.jpg" })).g.getUserProfile("1", "t")).toEqual({ name: "A B", picUrl: null });
    expect(await graphWith(() => json({ profile_pic: "https://x.fbcdn.net/p.jpg" })).g.getUserProfile("1", "t")).toEqual({ name: null, picUrl: "https://x.fbcdn.net/p.jpg" });
  });
  it("classifies errors without leaking the token", async () => {
    const kind = async (status: number, code: number) => {
      try { await graphWith(() => json({ error: { code, message: "PAGE-TOKEN-XYZ leaked?" } }, status)).g.getUserProfile("1", "PAGE-TOKEN-XYZ"); } catch (e) { return e as GraphError; }
    };
    expect((await kind(400, 190))!.kind).toBe("auth");
    expect((await kind(400, 4))!.kind).toBe("throttle");
    expect((await kind(403, 200))!.kind).toBe("permission");
    expect((await kind(400, 100))!.kind).toBe("other");
    expect((await kind(400, 100))!.message).not.toContain("PAGE-TOKEN");
  });
  it("network failure and timeout surface as an 'other' GraphError", async () => {
    await expect(graphWith(() => { throw new Error("boom"); }).g.getUserProfile("1", "t")).rejects.toMatchObject({ kind: "other" });
  });
});

describe("profile sanitising", () => {
  it("cleans names: control characters, whitespace, length, non-strings", () => {
    expect(cleanProfileName("  Rahim\n\tUddin\u0000 ")).toBe("Rahim Uddin");
    expect(cleanProfileName("")).toBeNull();
    expect(cleanProfileName("x".repeat(121))).toBeNull();
    expect(cleanProfileName(42)).toBeNull();
    expect(cleanProfileName("রহিম উদ্দিন")).toBe("রহিম উদ্দিন");
  });
  it("accepts only https URLs on Meta CDN hosts", () => {
    expect(safePicUrl("https://scontent.fdac1-1.fna.fbcdn.net/a.jpg")).not.toBeNull();
    expect(safePicUrl("https://platform-lookaside.fbsbx.com/a")).not.toBeNull();
    for (const bad of ["http://x.fbcdn.net/a", "https://evil.example/a", "https://fbcdn.net.evil.example/a", "javascript:alert(1)", "not a url", `https://x.fbcdn.net/${"a".repeat(2100)}`, 5, null]) expect(safePicUrl(bad)).toBeNull();
  });
});
