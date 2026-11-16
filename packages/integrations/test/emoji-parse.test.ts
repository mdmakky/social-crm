import { describe, expect, it } from "vitest";
import { buildMessagePayload, buildWhatsAppBody, buildWhatsAppChange, parseMetaWebhook, waText } from "../src/index.ts";

/** The text a customer sends must reach the Inbox byte for byte on every channel: emoji (tones, ZWJ, flags, variation selectors), Bangla, newlines. */
const SAMPLES = [
  "Hello 😀 world 🎉",
  "Thanks 👍🏽 🙏🏿 👋🏻",
  "Family 👨‍👩‍👧‍👦 👩🏽‍💻 🏳️‍🌈 🧑‍🤝‍🧑",
  "Flags 🇧🇩 🇺🇸 🏴󠁧󠁢󠁥󠁮󠁧󠁿",
  "Hearts ❤️ ☀️ ✌️ #️⃣ 1️⃣",
  "ধন্যবাদ 🙏 আপনাকে ✅ thanks 😊",
  "😀 start, mid 😀 dle, end 😀",
  "line one 😀\nলাইন দুই 🙏\n\n🇧🇩 line four",
  "😀😃😄😁😆😅🤣😂🙂🙃",
];
const parse = (o: unknown) => { const r = parseMetaWebhook(Buffer.from(JSON.stringify(o))); if (!r.ok) throw new Error(r.reason); return r; };
const textOf = (r: ReturnType<typeof parse>) => { const e = r.entries[0]!.events[0]!; if (e.kind !== "message") throw new Error("not a message"); return e.text; };

describe("emoji survive the webhook parsers", () => {
  it.each(SAMPLES)("Messenger: %s", (t) => {
    expect(textOf(parse(buildMessagePayload({ object: "page", accountId: "111", userId: "222", mid: "m1", text: t, timestampMs: 1 })))).toBe(t);
  });
  it.each(SAMPLES)("Instagram: %s", (t) => {
    expect(textOf(parse(buildMessagePayload({ object: "instagram", accountId: "111", userId: "222", mid: "m2", text: t, timestampMs: 1 })))).toBe(t);
  });
  it.each(SAMPLES)("WhatsApp: %s", (t) => {
    expect(textOf(parse(buildWhatsAppBody("102", [buildWhatsAppChange({ phoneNumberId: "106", messages: [waText("16315551181", "wamid.E", t, 1749416383)] })])))).toBe(t);
  });
});
