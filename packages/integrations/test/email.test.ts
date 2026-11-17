import { describe, expect, it } from "vitest";
import { buildMockInbound, createMailgunProvider, EmailSendError, MockEmailProvider, MOCK_SIGNING_KEY, newMessageId, parseMailgunEvent, parseMailgunInbound, parseRecipient, replySubject, signMailgun, stripQuoted, supportAddress, tokenOfMessageId, TokenSeen, verifyMailgunSignature, type OutboundEmail } from "../src/index.ts";

const TOKEN = "abcdefghijklmnopqrst";
const DOMAIN = "inbound.example.test";
const to = supportAddress(TOKEN, DOMAIN);
const parse = (o: Partial<Parameters<typeof buildMockInbound>[0]>) => parseMailgunInbound(buildMockInbound({ ...o, recipient: o.recipient ?? to }))!;

describe("inbound parser (MOCK fixtures, field names UNVERIFIED for verdicts)", () => {
  it("plain message: text, ids, verified sender", () => {
    const m = parse({ text: "Where is my order?", messageId: "m1@example.org" });
    expect(m).toMatchObject({ text: "Where is my order?", messageId: "m1@example.org", fromAddress: "customer@example.org", fromName: "Customer", senderVerified: true, ignoreReason: null, hasText: true });
  });
  it("reply: quoted part stripped, threading headers read", () => {
    const m = parse({ text: "Thanks, that works.\n\nOn Mon, 1 Jan 2026 at 10:00, Support <support@x.test> wrote:\n> earlier\n> text", inReplyTo: "out1@x.test", references: ["a@x.test", "out1@x.test"] });
    expect(m.text).toBe("Thanks, that works.");
    expect(m.inReplyTo).toBe("out1@x.test");
    expect(m.references).toEqual(["a@x.test", "out1@x.test"]);
  });
  it("prefers the provider's stripped-text when present", () => {
    expect(parse({ text: "full\n> q", strippedText: "just this" }).text).toBe("just this");
  });
  it("auto-submitted, precedence bulk, mailing list, empty return path, mailer-daemon, delivery report are ignored with a reason", () => {
    expect(parse({ extraHeaders: [["Auto-Submitted", "auto-replied"]] }).ignoreReason).toBe("auto_submitted");
    expect(parse({ extraHeaders: [["Auto-Submitted", "no"]] }).ignoreReason).toBeNull();
    expect(parse({ extraHeaders: [["Precedence", "bulk"]] }).ignoreReason).toBe("precedence");
    expect(parse({ extraHeaders: [["List-Unsubscribe", "<mailto:x@y.z>"]] }).ignoreReason).toBe("mailing_list");
    expect(parse({ sender: "" }).ignoreReason).toBe("empty_return_path");
    expect(parse({ from: "MAILER-DAEMON <mailer-daemon@example.org>" }).ignoreReason).toBe("automated_sender");
    expect(parse({ from: "noreply@example.org" }).ignoreReason).toBe("automated_sender");
    expect(parse({ extraHeaders: [["Content-Type", "multipart/report; report-type=delivery-status"]] }).ignoreReason).toBe("delivery_report");
  });
  it("HTML-only mail: raw HTML never becomes text", () => {
    const f = buildMockInbound({ recipient: to, text: "", html: "<p onclick=x>steal</p><script>1</script>" });
    f["body-plain"] = "";
    const m = parseMailgunInbound(f)!;
    expect(m.hasText).toBe(false);
    expect(m.text).not.toContain("<");
    expect(m.text).not.toContain("steal");
  });
  it("sender is not verified unless both verdicts pass and domains line up", () => {
    expect(parse({ spf: "Fail" }).senderVerified).toBe(false);
    expect(parse({ dkim: "None" }).senderVerified).toBe(false);
    expect(parse({ sender: "bounce@other.example" }).senderVerified).toBe(false);
    expect(parse({ from: "Boss <boss@example.org>", sender: "boss@mail.example.org" }).senderVerified).toBe(true);
  });
  it("attachments are counted by name and size, never stored", () => {
    const f = buildMockInbound({ recipient: to, attachments: 2 });
    const m = parseMailgunInbound(f, [{ name: "a.pdf", size: 10 }, { name: "b\r\n.png", size: 20 }])!;
    expect(m.attachmentCount).toBe(2);
    expect(m.attachments).toEqual([{ name: "a.pdf", size: 10 }, { name: "b .png", size: 20 }]);
  });
  it("body is cut at 20000 characters", () => {
    expect(parse({ text: "x".repeat(50_000) }).text.length).toBeLessThanOrEqual(20_000);
  });
});

describe("quote stripper", () => {
  it("cuts at wrote: (also wrapped), original message marker, trailing > lines", () => {
    expect(stripQuoted("hi\n\nOn Tue, Jan 2 2026, Ann <a@b.c>\nwrote:\n> x")).toBe("hi");
    expect(stripQuoted("hi\n-----Original Message-----\nFrom: x")).toBe("hi");
    expect(stripQuoted("hi\n> quoted\n>\n")).toBe("hi");
    expect(stripQuoted("> only quoted")).toBe("> only quoted");
  });
});

describe("addresses and ids", () => {
  it("recipient parsing needs the exact domain and token shape", () => {
    expect(parseRecipient(to, DOMAIN)).toEqual({ token: TOKEN, convToken: null });
    expect(parseRecipient(supportAddress(TOKEN, DOMAIN, "abcdefghijklmnop"), DOMAIN)?.convToken).toBe("abcdefghijklmnop");
    expect(parseRecipient(to, "other.test")).toBeNull();
    expect(parseRecipient(`support@${DOMAIN}`, DOMAIN)).toBeNull();
    expect(parseRecipient(`support+short@${DOMAIN}`, DOMAIN)).toBeNull();
    expect(parseRecipient(`sales+${TOKEN}@${DOMAIN}`, DOMAIN)).toBeNull();
  });
  it("our message id carries the account token; subject gets a single Re:", () => {
    const id = newMessageId(TOKEN, "x.test");
    expect(tokenOfMessageId(id)).toBe(TOKEN);
    expect(tokenOfMessageId("foo@bar")).toBeNull();
    expect(replySubject("Re: RE: Order\r\nBcc: x@y.z")).toBe("Re: Order Bcc: x@y.z");
    expect(replySubject("")).toBe("Re: (no subject)");
  });
});

describe("signature (Mailgun: hex HMAC-SHA256 of timestamp+token)", () => {
  const now = 1_800_000_000_000;
  const ts = String(now / 1000);
  const token = "t".repeat(50);
  const good = { timestamp: ts, token, signature: signMailgun(ts, token, MOCK_SIGNING_KEY) };
  it("accepts valid, bad key and tampered fields fail", () => {
    expect(verifyMailgunSignature(good, [MOCK_SIGNING_KEY], now)).toEqual({ ok: true, token });
    expect(verifyMailgunSignature(good, ["other"], now)).toMatchObject({ ok: false, reason: "bad_signature" });
    expect(verifyMailgunSignature({ ...good, token: "u".repeat(50) }, [MOCK_SIGNING_KEY], now)).toMatchObject({ ok: false, reason: "bad_signature" });
    expect(verifyMailgunSignature({ ...good, signature: "zz" }, [MOCK_SIGNING_KEY], now)).toMatchObject({ ok: false, reason: "malformed" });
    expect(verifyMailgunSignature({}, [MOCK_SIGNING_KEY], now)).toMatchObject({ ok: false });
    expect(verifyMailgunSignature(good, [""], now)).toMatchObject({ ok: false });
  });
  it("rejects a stale timestamp (a correct signature is not enough)", () => {
    const old = String(now / 1000 - 3600);
    expect(verifyMailgunSignature({ timestamp: old, token, signature: signMailgun(old, token, MOCK_SIGNING_KEY) }, [MOCK_SIGNING_KEY], now)).toMatchObject({ ok: false, reason: "stale" });
  });
  it("a replayed token is refused by TokenSeen", () => {
    const seen = new TokenSeen(1000);
    expect(seen.firstUse("a", 0)).toBe(true);
    expect(seen.firstUse("a", 10)).toBe(false);
    expect(seen.firstUse("a", 2000)).toBe(true); // expired
  });
});

describe("bounce event (shape UNVERIFIED)", () => {
  const sig = { timestamp: "1800000000", token: "t".repeat(50), signature: "0".repeat(64) };
  it("permanent failure and complaint map; temporary and delivered are ignored", () => {
    const ev = (event: string, severity?: string) => parseMailgunEvent({ signature: sig, "event-data": { event, severity, reason: "mailbox full", message: { headers: { "message-id": "crm.x@y" } } } })!.event;
    expect(ev("failed", "permanent")).toMatchObject({ event: "bounce", messageId: "crm.x@y" });
    expect(ev("complained")).toMatchObject({ event: "complaint" });
    expect(ev("failed", "temporary")).toBeNull();
    expect(ev("delivered")).toBeNull();
    expect(parseMailgunEvent({ nope: 1 })).toBeNull();
  });
});

describe("outbound: Mailgun adapter with a FAKE fetch, and the mock provider", () => {
  const mail: OutboundEmail = { from: { name: "Acme", address: "support@x.test" }, to: "c@example.org", replyTo: "support+t@in.x.test", subject: "Re: Hi", text: "Hello", messageId: "crm.id@x.test", inReplyTo: "in1@example.org", references: ["a@b.c", "in1@example.org"], autoSubmitted: "no" };
  const run = (res: () => Response | Promise<Response>) => {
    const calls: { url: string; init: RequestInit }[] = [];
    const p = createMailgunProvider({ apiKey: "key-1", domain: "x.test", fetch: (async (url: string, init: RequestInit) => { calls.push({ url, init }); return res(); }) as unknown as typeof fetch });
    return { p, calls };
  };
  it("sends form fields with basic auth and our headers", async () => {
    const { p, calls } = run(() => new Response(JSON.stringify({ id: "<20260101.1@x.test>", message: "Queued. Thank you." }), { status: 200 }));
    expect(await p.send(mail)).toEqual({ providerId: "<20260101.1@x.test>" });
    expect(calls[0]!.url).toBe("https://api.mailgun.net/v3/x.test/messages");
    const h = calls[0]!.init.headers as Record<string, string>;
    expect(h["authorization"]).toBe("Basic " + Buffer.from("api:key-1").toString("base64"));
    const body = calls[0]!.init.body as URLSearchParams;
    expect(Object.fromEntries(body)).toMatchObject({ from: "Acme <support@x.test>", to: "c@example.org", subject: "Re: Hi", "h:Reply-To": "support+t@in.x.test", "h:Message-Id": "<crm.id@x.test>", "h:In-Reply-To": "<in1@example.org>", "h:References": "<a@b.c> <in1@example.org>", "h:Auto-Submitted": "no" });
  });
  it("failure mapping: 401/403 auth, 400 rejected, 429 rate, 5xx and network ambiguous, junk body ambiguous", async () => {
    const code = async (r: () => Response | Promise<Response>) => { try { await run(r).p.send(mail); return "sent"; } catch (e) { const x = e as EmailSendError; return `${x.outcome}:${x.code}`; } };
    expect(await code(() => new Response("{}", { status: 401 }))).toBe("rejected:provider_auth");
    expect(await code(() => new Response("{}", { status: 403 }))).toBe("rejected:provider_auth");
    expect(await code(() => new Response("{}", { status: 400 }))).toBe("rejected:provider_rejected");
    expect(await code(() => new Response("{}", { status: 429 }))).toBe("rejected:rate_limited");
    expect(await code(() => new Response("{}", { status: 503 }))).toBe("ambiguous:provider_unavailable");
    expect(await code(() => { throw new Error("socket"); })).toBe("ambiguous:no_response");
    expect(await code(() => new Response("not json", { status: 200 }))).toBe("ambiguous:unreadable_response");
  });
  it("mock provider records the mail and can be scripted to fail", async () => {
    const m = new MockEmailProvider();
    await m.send(mail);
    expect(m.outbox).toHaveLength(1);
    m.next.push(new EmailSendError("rejected", 400, "provider_rejected"));
    await expect(m.send(mail)).rejects.toMatchObject({ code: "provider_rejected" });
  });
});
