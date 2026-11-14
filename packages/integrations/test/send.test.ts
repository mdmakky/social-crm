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
