import { describe, expect, it } from "vitest";
import { buildBatch, buildMessagePayload, mockSecret, parseMetaWebhook, signedFixture, signMetaBody, verifyMetaSignature } from "../src/index.ts";

const raw = Buffer.from('{"a":1}');
describe("signature", () => {
  const sig = signMetaBody(raw, "s1");
  it("accepts valid, string and bytes agree", () => {
    expect(sig).toMatch(/^sha256=[0-9a-f]{64}$/);
    expect(signMetaBody('{"a":1}', "s1")).toBe(sig);
    expect(verifyMetaSignature(raw, sig, ["s1"])).toBe(true);
  });
  it("rejects wrong secret, tampered body, bad header forms", () => {
    expect(verifyMetaSignature(raw, sig, ["s2"])).toBe(false);
    expect(verifyMetaSignature(Buffer.from('{"a":2}'), sig, ["s1"])).toBe(false);
    for (const h of [null, undefined, "", sig.slice(0, -2), sig + "00", sig.toUpperCase(), "sha256=" + sig.slice(7).toUpperCase(), sig.replace("sha256=", "sha1="), " " + sig]) expect(verifyMetaSignature(raw, h, ["s1"])).toBe(false);
  });
  it("supports rotation and refuses empty secrets", () => {
    expect(verifyMetaSignature(raw, sig, ["new", "s1"])).toBe(true);
    expect(verifyMetaSignature(raw, sig, [])).toBe(false);
    expect(verifyMetaSignature(raw, signMetaBody(raw, ""), [""])).toBe(false);
    expect(verifyMetaSignature(raw, sig, [undefined as unknown as string])).toBe(false);
  });
});

const p = (o: object | string) => parseMetaWebhook(Buffer.from(typeof o === "string" ? o : JSON.stringify(o)));
describe("parser", () => {
  it("parses messenger and instagram messages", () => {
    const m = p(buildMessagePayload({ accountId: "111", userId: "222", mid: "m1", text: "hi", timestampMs: 1700000000000 }));
    expect(m).toMatchObject({ ok: true, platform: "messenger" });
    if (!m.ok) throw 0;
    expect(m.entries[0]).toMatchObject({ accountId: "111", events: [{ kind: "message", mid: "m1", senderId: "222", recipientId: "111", text: "hi", isEcho: false }] });
    const i = p(buildMessagePayload({ object: "instagram", accountId: "111", userId: "222", mid: "m2", text: "yo", timestampMs: 1 }));
    expect(i).toMatchObject({ ok: true, platform: "instagram" });
  });
  it("echo keeps sender/recipient as received", () => {
    const r = p(buildMessagePayload({ accountId: "111", userId: "222", mid: "m3", text: "x", timestampMs: 5, echo: true }));
    if (!r.ok) throw 0;
    expect(r.entries[0]!.events[0]).toMatchObject({ isEcho: true, senderId: "111", recipientId: "222" });
  });
  it("read and delivery", () => {
    const r = p({ object: "page", entry: [{ id: "1", messaging: [{ sender: { id: "2" }, recipient: { id: "1" }, read: { watermark: 10 } }, { sender: { id: "2" }, recipient: { id: "1" }, delivery: { watermark: 11 } }] }] });
    if (!r.ok) throw 0;
    expect(r.entries[0]!.events).toEqual([{ kind: "read", userId: "2", watermarkMs: 10 }, { kind: "delivery", userId: "2", watermarkMs: 11 }]);
  });
  it("multi-entry batch keeps raw entry; bad entry ids are dropped alone", () => {
    const b = buildBatch([buildMessagePayload({ accountId: "1", userId: "9", mid: "a", text: "t", timestampMs: 1 }), buildMessagePayload({ accountId: "2", userId: "9", mid: "b", text: "t", timestampMs: 2 })]);
    (b.entry as object[]).push({ id: "0123", messaging: [] }, { id: "abc" }, { id: "x".repeat(5) }, 5 as never);
    const r = p(b);
    if (!r.ok) throw 0;
    expect(r.entries.map((e) => e.accountId)).toEqual(["1", "2"]);
    expect(r.entries[0]!.raw).toEqual(b.entry[0]);
  });
  it("ignores bad ids, mids, timestamps, empties, unsupported kinds", () => {
    const base = { sender: { id: "2" }, recipient: { id: "1" } };
    const ev = (m: unknown) => { const r = p({ object: "page", entry: [{ id: "1", messaging: [m] }] }); if (!r.ok) throw 0; return r.entries[0]!.events[0]; };
    expect(ev({ sender: { id: "02" }, recipient: { id: "1" }, timestamp: 1, message: { mid: "m", text: "t" } })).toEqual({ kind: "ignored", reason: "bad_id" });
    expect(ev({ ...base, timestamp: 1, message: { mid: "", text: "t" } })).toMatchObject({ reason: "bad_mid" });
    expect(ev({ ...base, timestamp: 1, message: { mid: "m".repeat(256), text: "t" } })).toMatchObject({ reason: "bad_mid" });
    for (const t of [0, -1, 1.5, "1", null, Infinity]) expect(ev({ ...base, timestamp: t, message: { mid: "m", text: "t" } })).toMatchObject({ reason: "bad_timestamp" });
    expect(ev({ ...base, timestamp: 1, message: { mid: "m" } })).toMatchObject({ reason: "empty" });
    expect(ev({ ...base, timestamp: 1, postback: { payload: "x" } })).toMatchObject({ kind: "ignored" });
    expect(ev({ ...base, timestamp: 1, reaction: {} })).toMatchObject({ kind: "ignored" });
    expect(ev("str")).toMatchObject({ kind: "ignored" });
  });
  it("truncates text, caps and sanitises attachments", () => {
    const att = Array.from({ length: 30 }, (_, i) => ({ type: "image", payload: { url: i === 0 ? "http://x/y" : "https://x/y" } }));
    const r = p({ object: "page", entry: [{ id: "1", messaging: [{ sender: { id: "2" }, recipient: { id: "1" }, timestamp: 1, message: { mid: "m", text: "a".repeat(30000), attachments: [...att, { type: "t".repeat(51) }] } }] }] });
    if (!r.ok) throw 0;
    const e = r.entries[0]!.events[0]!;
    if (e.kind !== "message") throw 0;
    expect(e.text!.length).toBe(20000);
    expect(e.attachments.length).toBe(20);
    expect(e.attachments[0]!.url).toBeNull();
    expect(e.attachments[1]!.url).toBe("https://x/y");
  });
  it("caps entries and events", () => {
    const ev = { sender: { id: "2" }, recipient: { id: "1" }, read: { watermark: 1 } };
    const r = p({ object: "page", entry: Array.from({ length: 150 }, () => ({ id: "1", messaging: Array.from({ length: 1100 }, () => ev) })) });
    if (!r.ok) throw 0;
    expect(r.entries.length).toBe(100);
    expect(r.entries[0]!.events.length).toBe(1000);
  });
  it("rejects hostile or odd bodies without throwing", () => {
    expect(p("nope")).toEqual({ ok: false, reason: "not_json" });
    for (const s of ["[]", "null", "1", '"x"', "{}", '{"object":"page"}', '{"object":"page","entry":{}}']) expect(p(s)).toEqual({ ok: false, reason: "bad_shape" });
    expect(p({ object: "whatsapp", entry: [] })).toEqual({ ok: false, reason: "unsupported_object" });
    const pp = p('{"object":"page","__proto__":{"polluted":1},"entry":[{"id":"1","__proto__":{"x":1},"messaging":[{"__proto__":{"y":1},"constructor":{"prototype":{"z":1}}}]}]}');
    expect(pp.ok).toBe(true);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(({} as Record<string, unknown>).z).toBeUndefined();
    expect(p('{"object":"page","entry":[{"id":"1","messaging":[[[[[[[[1]]]]]]]]}]}')).toMatchObject({ ok: true });
    expect(p('{"object":"page","entry":[{"id":"1","messaging":"x"}]}')).toMatchObject({ ok: true, entries: [{ events: [] }] });
  });
  it("signed mock fixture verifies and parses", () => {
    const f = signedFixture(buildMessagePayload({ accountId: "1", userId: "2", mid: "m", text: "t", timestampMs: 1 }));
    expect(verifyMetaSignature(f.raw, f.signature, [mockSecret])).toBe(true);
    expect(parseMetaWebhook(f.raw).ok).toBe(true);
  });
});

describe("Instagram webhook parsing", () => {
  const body = (m: unknown) => Buffer.from(JSON.stringify({ object: "instagram", entry: [{ id: "17841", time: 1, messaging: [m] }] }));
  const pair = { sender: { id: "55" }, recipient: { id: "17841" } };
  it("reads the instagram object, echoes, unsupported media and messaging_seen", () => {
    const r = parseMetaWebhook(body({ ...pair, timestamp: 100, message: { mid: "m1", is_unsupported: true } }));
    expect(r.ok && r.platform).toBe("instagram");
    expect(r.ok && r.entries[0]!.events[0]).toMatchObject({ kind: "message", attachments: [{ type: "unsupported", url: null }], isEcho: false });
    expect((parseMetaWebhook(body({ ...pair, timestamp: 100, read: { mid: "m1" } })) as { ok: true; entries: { events: unknown[] }[] }).entries[0]!.events[0]).toEqual({ kind: "read", userId: "55", watermarkMs: 100 });
    expect((parseMetaWebhook(body({ ...pair, timestamp: 100, reaction: { mid: "m1" } })) as { ok: true; entries: { events: unknown[] }[] }).entries[0]!.events[0]).toMatchObject({ kind: "ignored" });
    expect((parseMetaWebhook(body({ ...pair, timestamp: 100, message: { mid: "m2" } })) as { ok: true; entries: { events: unknown[] }[] }).entries[0]!.events[0]).toMatchObject({ kind: "ignored", reason: "empty" });
  });
});
