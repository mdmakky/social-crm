import { describe, expect, it } from "vitest";
import { buildWhatsAppBody, buildWhatsAppChange, parseMetaWebhook, waText } from "../src/index.ts";

const parse = (o: unknown) => parseMetaWebhook(Buffer.from(JSON.stringify(o)));
const PN = "106540352242922";
const WABA = "102290129340398";
const ok = (o: unknown) => { const r = parse(o); if (!r.ok) throw new Error(r.reason); return r; };

describe("WhatsApp webhook parser", () => {
  it("reads an inbound text: sender is wa_id, routing key is the phone number id, seconds become milliseconds", () => {
    const r = ok(buildWhatsAppBody(WABA, [buildWhatsAppChange({ phoneNumberId: PN, messages: [waText("16315551181", "wamid.A", "hi", 1749416383)] })]));
    expect(r.platform).toBe("whatsapp");
    expect(r.entries).toHaveLength(1);
    expect(r.entries[0]!.accountId).toBe(PN);
    expect(r.entries[0]!.events).toEqual([{ kind: "message", mid: "wamid.A", senderId: "16315551181", recipientId: PN, timestampMs: 1749416383000, text: "hi", attachments: [], isEcho: false }]);
  });

  it("never routes by entry.id (the WABA id), and splits one POST into one entry per change", () => {
    const r = ok(buildWhatsAppBody(WABA, [
      buildWhatsAppChange({ phoneNumberId: "111", messages: [waText("1555", "wamid.1", "a")] }),
      buildWhatsAppChange({ phoneNumberId: "222", messages: [waText("1666", "wamid.2", "b")] }),
    ]));
    expect(r.entries.map((e) => e.accountId)).toEqual(["111", "222"]);
    expect(r.entries.some((e) => e.accountId === WABA)).toBe(false);
    // each stored raw entry holds exactly its own change, so a per-row body cannot write into another number
    for (const e of r.entries) expect(((e.raw as { changes: unknown[] }).changes)).toHaveLength(1);
  });

  it("keeps a media reference by id only and drops the (private) url; the caption becomes the text", () => {
    const m = { from: "16315551181", id: "wamid.I", timestamp: "1749416383", type: "image", image: { caption: "my photo", mime_type: "image/jpeg", sha256: "x", id: "1003383421387256", url: "https://lookaside.example/secret?token=1" } };
    const e = ok(buildWhatsAppBody(WABA, [buildWhatsAppChange({ phoneNumberId: PN, messages: [m] })])).entries[0]!.events[0]!;
    expect(e).toMatchObject({ kind: "message", text: "my photo", attachments: [{ type: "image", url: null, mediaId: "1003383421387256", mime: "image/jpeg" }] });
    expect(JSON.stringify(e)).not.toContain("lookaside");
  });

  it("handles audio, video, document (with file name), sticker, buttons and interactive replies", () => {
    const at = { from: "16315551181", timestamp: "1749416383" };
    const evs = ok(buildWhatsAppBody(WABA, [buildWhatsAppChange({ phoneNumberId: PN, messages: [
      { ...at, id: "w.a", type: "audio", audio: { id: "9", mime_type: "audio/ogg; codecs=opus", voice: true } },
      { ...at, id: "w.v", type: "video", video: { id: "10", mime_type: "video/mp4", caption: "clip" } },
      { ...at, id: "w.d", type: "document", document: { id: "11", filename: "receipt.pdf", mime_type: "application/pdf" } },
      { ...at, id: "w.s", type: "sticker", sticker: { id: "12", mime_type: "image/webp", animated: false } },
      { ...at, id: "w.b", type: "button", button: { payload: "p", text: "Yes" } },
      { ...at, id: "w.i", type: "interactive", interactive: { type: "button_reply", button_reply: { id: "1", title: "Option A" } } },
      { ...at, id: "w.l", type: "interactive", interactive: { type: "list_reply", list_reply: { id: "2", title: "Row 2", description: "d" } } },
    ] })])).entries[0]!.events;
    expect(evs.map((e) => e.kind)).toEqual(Array(7).fill("message"));
    const [au, vi, doc, st, bu, ib, il] = evs as Extract<(typeof evs)[number], { kind: "message" }>[];
    expect(au!.attachments[0]).toMatchObject({ type: "audio", mediaId: "9", url: null });
    expect(vi).toMatchObject({ text: "clip", attachments: [{ type: "video" }] });
    expect(doc!.attachments[0]).toMatchObject({ type: "document", name: "receipt.pdf" });
    expect(st!.attachments[0]).toMatchObject({ type: "sticker" });
    expect([bu!.text, ib!.text, il!.text]).toEqual(["Yes", "Option A", "Row 2"]);
  });

  it("keeps a visible placeholder for location, contacts, unsupported and unknown types; ignores reactions and system notices", () => {
    const at = { from: "16315551181", timestamp: "1749416383" };
    const evs = ok(buildWhatsAppBody(WABA, [buildWhatsAppChange({ phoneNumberId: PN, messages: [
      { ...at, id: "w.1", type: "location", location: { latitude: 1, longitude: 2, name: "home" } },
      { ...at, id: "w.2", type: "unsupported", unsupported: { type: "poll_creation" }, errors: [{ code: 131051, title: "Message type unknown" }] },
      { ...at, id: "w.3", type: "contacts", contacts: [{ name: { formatted_name: "x" } }] },
      { ...at, id: "w.4", type: "reaction", reaction: { message_id: "wamid.out", emoji: "👍" } },
      { ...at, id: "w.5", type: "system", system: { body: "changed number" } },
    ] })])).entries[0]!.events;
    expect(evs.map((e) => (e.kind === "message" ? e.attachments[0]!.type : `${e.kind}:${(e as { reason: string }).reason}`))).toEqual(["location", "unsupported", "unsupported", "ignored:reaction", "ignored:system"]);
    expect(JSON.stringify(evs)).not.toContain("home"); // the location itself is not copied
  });

  it("does not guess an identity for a sender that has only a business-scoped user id", () => {
    const m = { from_user_id: "US.13491208655302741918", id: "w.u", timestamp: "1749416383", type: "text", text: { body: "hi" } };
    expect(ok(buildWhatsAppBody(WABA, [buildWhatsAppChange({ phoneNumberId: PN, messages: [m] })])).entries[0]!.events).toEqual([{ kind: "ignored", reason: "bsuid_only" }]);
  });

  it("reads delivered and read statuses and ignores the others", () => {
    const base = { recipient_id: "16315551181", timestamp: "1749416400" };
    const evs = ok(buildWhatsAppBody(WABA, [buildWhatsAppChange({ phoneNumberId: PN, statuses: [
      { ...base, id: "wamid.out", status: "delivered" },
      { ...base, id: "wamid.out", status: "read" },
      { ...base, id: "wamid.out", status: "sent" },
      { ...base, id: "wamid.out", status: "failed", errors: [{ code: 131049, title: "x" }] },
      { ...base, id: "wamid.out", status: "delivered", timestamp: "soon" },
    ] })])).entries[0]!.events;
    expect(evs).toEqual([
      { kind: "status", mid: "wamid.out", status: "delivered", userId: "16315551181", timestampMs: 1749416400000 },
      { kind: "status", mid: "wamid.out", status: "read", userId: "16315551181", timestampMs: 1749416400000 },
      { kind: "ignored", reason: "unused_status" },
      { kind: "ignored", reason: "unused_status" },
      { kind: "ignored", reason: "bad_status" },
    ]);
  });

  it("skips changes it does not handle and refuses malformed input without throwing", () => {
    expect(ok(buildWhatsAppBody(WABA, [buildWhatsAppChange({ phoneNumberId: PN, field: "account_update", messages: [waText("1555", "w", "x")] })])).entries).toEqual([]);
    expect(ok({ object: "whatsapp_business_account", entry: [{ id: WABA, changes: [{ field: "messages", value: { messages: [waText("1555", "w", "x")] } }] }] }).entries).toEqual([]); // no metadata
    expect(ok(buildWhatsAppBody(WABA, [buildWhatsAppChange({ phoneNumberId: "0123", messages: [waText("1555", "w", "x")] })])).entries).toEqual([]); // not a valid id
    expect(parse({ object: "whatsapp_business_account" })).toEqual({ ok: false, reason: "bad_shape" });
    expect(parse({ object: "whatsapp_business_account", entry: [null, 3, { changes: "x" }, { changes: [null, { field: "messages", value: 5 }] }] })).toEqual({ ok: true, platform: "whatsapp", entries: [] });
    const bad = ok(buildWhatsAppBody(WABA, [buildWhatsAppChange({ phoneNumberId: PN, messages: [null as never, waText("abc", "w", "x"), { ...waText("1555", "", "x") }, { ...waText("1555", "w", "x"), timestamp: "-5" }, { ...waText("1555", "w", ""), text: { body: "" } }] })])).entries[0]!.events;
    expect(bad.map((e) => (e as { reason: string }).reason)).toEqual(["bad_shape", "bad_id", "bad_mid", "bad_timestamp", "empty"]);
  });

  it("does not change how Messenger and Instagram bodies are read", () => {
    expect(parse({ object: "page", entry: [{ id: "1", messaging: [] }] })).toMatchObject({ ok: true, platform: "messenger" });
    expect(parse({ object: "instagram", entry: [{ id: "1", messaging: [] }] })).toMatchObject({ ok: true, platform: "instagram" });
    expect(parse({ object: "whatsapp", entry: [] })).toEqual({ ok: false, reason: "unsupported_object" });
  });
});
