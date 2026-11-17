import { describe, expect, it } from "vitest";
import { classifyTelegramSend, createMockTelegram, createTelegramClient, hashTelegramSecret, MOCK_TELEGRAM_TOKEN, parseTelegramUpdate, TelegramError, TelegramSendError, tgMyChatMember, tgPrivateText, verifyTelegramSecret } from "../src/index.ts";

// MOCK ONLY: fixtures follow the Update shape in the Bot API reference; they prove our parser, not Telegram.
const BOT = "7000000001";
const parse = (u: unknown) => parseTelegramUpdate(Buffer.from(JSON.stringify(u)), BOT);
const events = (u: unknown) => { const r = parse(u); if (!r.ok) throw new Error(r.reason); return r.events; };

describe("parseTelegramUpdate", () => {
  it("private text: id key is the numeric user id, mid is chat:message, name from first and last name", () => {
    const [e] = events(tgPrivateText({ updateId: 1, userId: 555, messageId: 42, text: "hello", date: 1_700_000_000 }));
    expect(e).toEqual({ kind: "message", mid: "555:42", senderId: "555", recipientId: BOT, timestampMs: 1_700_000_000_000, text: "hello", attachments: [], isEcho: false, profileName: "Mina Rahman" });
  });
  it("username is display only: used as the name only when there is no first/last name", () => {
    const [e] = events(tgPrivateText({ updateId: 2, userId: 555, messageId: 1, text: "x", user: { first_name: undefined, last_name: undefined, username: "mina_r" } }));
    expect(e).toMatchObject({ senderId: "555", profileName: "mina_r" });
  });
  it("a photo with a caption: caption is the text, largest size kept as metadata, no url", () => {
    const [e] = events(tgPrivateText({ updateId: 3, userId: 555, messageId: 2, extra: { caption: "my receipt", photo: [{ file_id: "small", width: 90, height: 90 }, { file_id: "BIG_ID", width: 800, height: 800 }] } }));
    expect(e).toMatchObject({ kind: "message", text: "my receipt", attachments: [{ type: "photo", url: null, fileId: "BIG_ID" }] });
  });
  it("document, voice, video, sticker keep type, file_id, mime and name; never a url", () => {
    const e = events(tgPrivateText({ updateId: 4, userId: 555, messageId: 3, extra: { document: { file_id: "D", file_name: "a\u0000b.pdf", mime_type: "application/pdf" }, voice: { file_id: "V", mime_type: "audio/ogg" }, video: { file_id: "W" }, sticker: { file_id: "S" } } }))[0] as { attachments: Record<string, unknown>[]; text: unknown };
    expect(e.text).toBeNull();
    expect(e.attachments).toEqual([{ type: "document", url: null, fileId: "D", mime: "application/pdf", name: "ab.pdf" }, { type: "voice", url: null, fileId: "V", mime: "audio/ogg" }, { type: "video", url: null, fileId: "W" }, { type: "sticker", url: null, fileId: "S" }]);
    expect(JSON.stringify(e)).not.toMatch(/https?:/);
  });
  it("location and other unsupported media become a visible placeholder, not a silent drop", () => {
    expect(events(tgPrivateText({ updateId: 5, userId: 555, messageId: 4, extra: { location: { latitude: 1, longitude: 2 } } }))[0]).toMatchObject({ kind: "message", attachments: [{ type: "unsupported", url: null }] });
  });
  it("group, supergroup and channel messages are ignored", () => {
    for (const type of ["group", "supergroup", "channel"]) {
      const u = tgPrivateText({ updateId: 6, userId: 555, messageId: 5, text: "hi" });
      (u.message.chat as { type: string }).type = type;
      expect(events(u)).toEqual([{ kind: "ignored", reason: "not_private" }]);
    }
  });
  it("edited_message, business_message, bots and empty service messages are ignored", () => {
    expect(events({ update_id: 7, edited_message: { message_id: 1 } })).toEqual([{ kind: "ignored", reason: "edited_message" }]);
    expect(events({ update_id: 8, business_message: { message_id: 1 } })).toEqual([{ kind: "ignored", reason: "unsupported_update" }]);
    expect(events(tgPrivateText({ updateId: 9, userId: 555, messageId: 6, text: "x", user: { is_bot: true } }))).toEqual([{ kind: "ignored", reason: "from_bot" }]);
    expect(events(tgPrivateText({ updateId: 10, userId: 555, messageId: 7, extra: { new_chat_title: "x" } }))).toEqual([{ kind: "ignored", reason: "empty" }]);
  });
  it("a chat id that differs from the sender id is not trusted", () => {
    const u = tgPrivateText({ updateId: 11, userId: 555, messageId: 8, text: "x" });
    u.message.chat.id = 777;
    expect(events(u)).toEqual([{ kind: "ignored", reason: "id_mismatch" }]);
  });
  it("my_chat_member: blocked (kicked) marks unreachable, member marks reachable again; groups are ignored", () => {
    expect(events(tgMyChatMember({ updateId: 12, userId: 555, status: "kicked", date: 1_700_000_000 }))).toEqual([{ kind: "reachability", userId: "555", unreachable: true, timestampMs: 1_700_000_000_000 }]);
    expect(events(tgMyChatMember({ updateId: 13, userId: 555, status: "member" }))[0]).toMatchObject({ kind: "reachability", unreachable: false });
    const g = tgMyChatMember({ updateId: 14, userId: 555, status: "kicked" });
    (g.my_chat_member.chat as { type: string }).type = "supergroup";
    expect(events(g)).toEqual([{ kind: "ignored", reason: "unsupported_member_update" }]);
  });
  it("not JSON or without update_id is rejected, never thrown", () => {
    expect(parseTelegramUpdate(Buffer.from("nope"), BOT)).toEqual({ ok: false, reason: "not_json" });
    expect(parse({ message: {} })).toEqual({ ok: false, reason: "bad_shape" });
    expect(parse([1])).toEqual({ ok: false, reason: "bad_shape" });
  });
});

describe("secret token", () => {
  const secret = "abc_DEF-123".repeat(4);
  const hash = hashTelegramSecret(secret);
  it("accepts only the exact secret; wrong, missing, empty and unknown account are refused", () => {
    expect(verifyTelegramSecret(secret, hash)).toBe(true);
    expect(verifyTelegramSecret(secret + "x", hash)).toBe(false);
    expect(verifyTelegramSecret(undefined, hash)).toBe(false);
    expect(verifyTelegramSecret("", hash)).toBe(false);
    expect(verifyTelegramSecret(secret, null)).toBe(false);
    expect(verifyTelegramSecret(secret, "not-a-hash")).toBe(false);
  });
  it("compares fixed-length digests (no early exit on length or prefix)", () => {
    expect(verifyTelegramSecret(secret.slice(0, 3), hash)).toBe(false);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).not.toContain(secret);
  });
});

describe("sendMessage failure mapping (fake responses only)", () => {
  const send = async (status: number, json: unknown) => {
    const calls: { url: string; body: Record<string, unknown> }[] = [];
    const fetch = (async (url: string, init: RequestInit) => { calls.push({ url, body: JSON.parse(init.body as string) }); return new Response(JSON.stringify(json), { status }); }) as unknown as typeof globalThis.fetch;
    const err = await createTelegramClient({ fetch, baseUrl: "http://tg.test" }).sendMessage("TOKEN", "555", "hi").then(() => null, (e) => e as TelegramSendError);
    return { err, calls };
  };
  it("success returns chat:message id, sends plain text without parse_mode, token only in the path", async () => {
    const calls: { url: string; body: Record<string, unknown> }[] = [];
    const fetch = (async (url: string, init: RequestInit) => { calls.push({ url, body: JSON.parse(init.body as string) }); return new Response(JSON.stringify({ ok: true, result: { message_id: 9 } })); }) as unknown as typeof globalThis.fetch;
    expect(await createTelegramClient({ fetch, baseUrl: "http://tg.test" }).sendMessage("TOKEN", "555", "a *b*")).toEqual({ messageId: "555:9" });
    expect(calls[0]!.url).toBe("http://tg.test/botTOKEN/sendMessage");
    expect(calls[0]!.body).toEqual({ chat_id: 555, text: "a *b*" });
  });
  it("429 is a rejected, rate_limited failure that keeps retry_after", async () => {
    const { err } = await send(429, { ok: false, error_code: 429, description: "Too Many Requests: retry after 17", parameters: { retry_after: 17 } });
    expect(err).toMatchObject({ outcome: "rejected", reason: "rate_limited", retryAfter: 17, httpStatus: 429 });
  });
  it("403 and 400 chat not found are not_reachable; other 400 is invalid_request; 401 is token_invalid", async () => {
    expect((await send(403, { ok: false, error_code: 403, description: "Forbidden: bot was blocked by the user" })).err).toMatchObject({ outcome: "rejected", reason: "not_reachable" });
    expect((await send(400, { ok: false, error_code: 400, description: "Bad Request: chat not found" })).err).toMatchObject({ reason: "not_reachable" });
    expect((await send(400, { ok: false, error_code: 400, description: "Bad Request: message is too long" })).err).toMatchObject({ reason: "invalid_request" });
    expect((await send(401, { ok: false, error_code: 401, description: "Unauthorized" })).err).toMatchObject({ reason: "token_invalid" });
  });
  it("5xx, a network failure and an unreadable 200 are ambiguous (never retried, never shown as failed)", async () => {
    expect((await send(502, { ok: false })).err).toMatchObject({ outcome: "ambiguous" });
    expect((await send(200, { ok: true })).err).toMatchObject({ outcome: "ambiguous" });
    const net = await createTelegramClient({ fetch: (async () => { throw new Error("boom TOKEN"); }) as unknown as typeof globalThis.fetch }).sendMessage("TOKEN", "1", "x").catch((e) => e as TelegramSendError);
    expect(net).toMatchObject({ outcome: "ambiguous", reason: "no_response" });
    expect(String((net as Error).message)).not.toContain("TOKEN");
  });
  it("classifyTelegramSend never keeps response text", () => {
    expect(classifyTelegramSend(403, 403, "secret customer text", null).message).not.toMatch(/customer/);
  });
});

describe("client and mock", () => {
  it("setWebhook sends the documented parameters, with allowed_updates always explicit", async () => {
    const bodies: Record<string, unknown>[] = [];
    const fetch = (async (_u: string, init: RequestInit) => { bodies.push(JSON.parse(init.body as string)); return new Response(JSON.stringify({ ok: true, result: true })); }) as unknown as typeof globalThis.fetch;
    await createTelegramClient({ fetch }).setWebhook("T", { url: "https://x.test/webhooks/telegram/abc", secretToken: "s", maxConnections: 3, allowedUpdates: ["message", "my_chat_member"], dropPendingUpdates: false });
    expect(bodies[0]).toEqual({ url: "https://x.test/webhooks/telegram/abc", secret_token: "s", max_connections: 3, allowed_updates: ["message", "my_chat_member"], drop_pending_updates: false });
  });
  it("an invalid token is an auth error", async () => {
    const fetch = (async () => new Response(JSON.stringify({ ok: false, error_code: 401 }), { status: 401 })) as unknown as typeof globalThis.fetch;
    await expect(createTelegramClient({ fetch }).getMe("bad")).rejects.toMatchObject({ kind: "auth" });
    await expect(createMockTelegram().getMe("bad")).rejects.toBeInstanceOf(TelegramError);
  });
  it("mock: getMe, webhook, health and send", async () => {
    const m = createMockTelegram();
    expect(await m.getMe(MOCK_TELEGRAM_TOKEN)).toMatchObject({ id: "7000000001", username: "mock_support_bot" });
    await m.setWebhook(MOCK_TELEGRAM_TOKEN, { url: "http://x/y", secretToken: "s", maxConnections: 3, allowedUpdates: [], dropPendingUpdates: false });
    expect((await m.getWebhookInfo(MOCK_TELEGRAM_TOKEN)).url).toBe("http://x/y");
    expect((await m.sendMessage(MOCK_TELEGRAM_TOKEN, "5", "hi")).messageId).toMatch(/^5:\d+$/);
    await m.deleteWebhook(MOCK_TELEGRAM_TOKEN);
    expect((await m.getWebhookInfo(MOCK_TELEGRAM_TOKEN)).url).toBe("");
  });
});
