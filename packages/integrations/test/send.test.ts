import { describe, expect, it } from "vitest";
import { createMetaGraph, SendError } from "../src/index.ts";

const graphWith = (respond: (url: URL, init: RequestInit) => Response | Promise<Response>) => {
  const seen: { url: URL; init: RequestInit }[] = [];
  const g = createMetaGraph({ appId: "1", appSecret: "s", version: "v25.0", fetch: (async (u: URL, init: RequestInit) => { seen.push({ url: new URL(String(u)), init }); return respond(u, init); }) as unknown as typeof fetch });
  return { g, seen };
};
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
const fail = async (p: Promise<unknown>) => (await p.then(() => null, (e) => e)) as SendError;

describe("sendText (real client, fake fetch: proves our request and classification, not Meta)", () => {
  it("POSTs {version}/{pageId}/messages with RESPONSE, token only in the header, and returns the message id", async () => {
    const { g, seen } = graphWith(() => json({ recipient_id: "77", message_id: "m_abc" }));
    expect(await g.sendText("1001", "PAGE-TOKEN-XYZ", "77", "Hello")).toEqual({ messageId: "m_abc" });
    const r = seen[0]!;
    expect(r.init.method).toBe("POST");
    expect(r.url.pathname).toBe("/v25.0/1001/messages");
    expect(r.url.toString()).not.toContain("PAGE-TOKEN-XYZ");
    expect((r.init.headers as Record<string, string>).authorization).toBe("Bearer PAGE-TOKEN-XYZ");
    expect(JSON.parse(r.init.body as string)).toEqual({ recipient: { id: "77" }, messaging_type: "RESPONSE", message: { text: "Hello" } });
    expect(r.init.body as string).not.toContain("tag"); // no HUMAN_AGENT or other message tag
  });
  it("a 4xx Graph error is a refusal with code and subcode, and the error never carries the response text or token", async () => {
    const e = await fail(graphWith(() => json({ error: { message: "secret text TOKEN", code: 551, error_subcode: 1234 } }, 400)).g.sendText("1", "TOKEN", "2", "hi"));
    expect(e).toBeInstanceOf(SendError);
    expect(e).toMatchObject({ outcome: "rejected", httpStatus: 400, code: 551, subcode: 1234 });
    expect(e.message).not.toMatch(/TOKEN|secret/);
  });
  it("5xx, unreadable body, 2xx without an id, and network/timeout failures are all ambiguous (never treated as failed)", async () => {
    expect(await fail(graphWith(() => json({ error: { code: 2 } }, 500)).g.sendText("1", "t", "2", "x"))).toMatchObject({ outcome: "ambiguous", httpStatus: 500 });
    expect(await fail(graphWith(() => new Response("<html>bad gateway</html>", { status: 502 })).g.sendText("1", "t", "2", "x"))).toMatchObject({ outcome: "ambiguous", httpStatus: 502 });
    expect(await fail(graphWith(() => json({ recipient_id: "2" })).g.sendText("1", "t", "2", "x"))).toMatchObject({ outcome: "ambiguous", httpStatus: 200 });
    expect(await fail(graphWith(() => { throw new Error("socket hang up"); }).g.sendText("1", "t", "2", "x"))).toMatchObject({ outcome: "ambiguous", httpStatus: null });
    expect(await fail(graphWith(() => new Response("{", { status: 200 })).g.sendText("1", "t", "2", "x"))).toMatchObject({ outcome: "ambiguous" });
  });
});

describe("Instagram channel (real client, fake fetch)", () => {
  it("sends to me/messages with the Page token and no messaging_type, recipient = IGSID", async () => {
    const { g, seen } = graphWith(() => json({ recipient_id: "55", message_id: "ig_mid" }));
    expect(await g.sendText("17841000", "PAGE-TOKEN-XYZ", "55", "Hi", "instagram")).toEqual({ messageId: "ig_mid" });
    const r = seen[0]!;
    expect(r.url.pathname).toBe("/v25.0/me/messages");
    expect(r.url.toString()).not.toContain("PAGE-TOKEN-XYZ");
    expect(JSON.parse(r.init.body as string)).toEqual({ recipient: { id: "55" }, message: { text: "Hi" } });
  });
  it("classifies Instagram errors with their subcodes", async () => {
    const e = await fail(graphWith(() => json({ error: { code: 10, error_subcode: 2534022 } }, 400)).g.sendText("1", "t", "2", "x", "instagram"));
    expect(e).toMatchObject({ outcome: "rejected", code: 10, subcode: 2534022 });
  });
  it("asks for name, username and profile_pic of an Instagram person and falls back to the username", async () => {
    const { g, seen } = graphWith(() => json({ username: "nusrat.j", profile_pic: "https://scontent.cdninstagram.com/v/p.jpg" }));
    expect(await g.getUserProfile("55", "t", "instagram")).toEqual({ name: "nusrat.j", picUrl: "https://scontent.cdninstagram.com/v/p.jpg" });
    expect(seen[0]!.url.searchParams.get("fields")).toBe("name,username,profile_pic");
    const m = graphWith(() => json({ name: "A B" }));
    await m.g.getUserProfile("55", "t");
    expect(m.seen[0]!.url.searchParams.get("fields")).toBe("name,profile_pic"); // Messenger request unchanged
  });
  it("getInstagramAccount returns details, or null on any failure (it must never break connecting)", async () => {
    const ok = graphWith(() => json({ username: "shop.bd", name: "Shop", profile_picture_url: "https://scontent.cdninstagram.com/v/s.jpg" }));
    expect(await ok.g.getInstagramAccount("1784", "t")).toEqual({ username: "shop.bd", name: "Shop", pictureUrl: "https://scontent.cdninstagram.com/v/s.jpg" });
    expect(ok.seen[0]!.url.searchParams.get("fields")).toBe("username,name,profile_picture_url");
    expect(await graphWith(() => json({ error: { code: 100 } }, 400)).g.getInstagramAccount("1784", "t")).toBeNull();
    expect(await graphWith(() => { throw new Error("x"); }).g.getInstagramAccount("1784", "t")).toBeNull();
    expect(await graphWith(() => json({ username: "bad name!", profile_picture_url: "http://evil/x.jpg" })).g.getInstagramAccount("1784", "t")).toBeNull();
  });
});

describe("Unified Login (Instagram without a Page): real client, fake fetch", () => {
  it("sends to /{ig-id}/messages (not me/messages: `me` is the system user) with the token in the header and no messaging_type", async () => {
    const { g, seen } = graphWith(() => json({ recipient_id: "55", message_id: "ig_u_1" }));
    expect(await g.sendText("17841", "SUAT-TOKEN", "55", "Hi", "instagram_unified")).toEqual({ messageId: "ig_u_1" });
    const r = seen[0]!;
    expect(r.url.host).toBe("graph.facebook.com");
    expect(r.url.pathname).toBe("/v25.0/17841/messages");
    expect(JSON.parse(r.init.body as string)).toEqual({ recipient: { id: "55" }, message: { text: "Hi" } });
    expect((r.init.headers as Record<string, string>).authorization).toBe("Bearer SUAT-TOKEN");
    expect(r.url.toString()).not.toContain("SUAT-TOKEN");
  });
  it("lists the shared Instagram accounts with id and username, dropping malformed entries", async () => {
    const { g, seen } = graphWith(() => json({ data: [{ id: "17841", username: "shop.bd" }, { id: "no-digits", username: "x" }, { id: "17842", username: "bad name!" }, { id: "17843" }] }));
    expect(await g.listAssignedInstagramAccounts("TOK")).toEqual([{ id: "17841", username: "shop.bd" }, { id: "17842", username: null }, { id: "17843", username: null }]);
    expect(seen[0]!.url.pathname).toBe("/v25.0/me/assigned_instagram_accounts");
    expect(seen[0]!.url.searchParams.get("fields")).toBe("id,username");
    expect((seen[0]!.init.headers as Record<string, string>).authorization).toBe("Bearer TOK");
    expect(await g.listAssignedInstagramAccounts("TOK").catch(() => "x")).toBeTruthy();
  });
  it("an auth error while listing is a GraphError of kind auth", async () => {
    const e = (await graphWith(() => json({ error: { code: 190 } }, 400)).g.listAssignedInstagramAccounts("t").then(() => null, (x) => x)) as { kind: string };
    expect(e.kind).toBe("auth");
  });
});
