import { describe, expect, it } from "vitest";
import { DELIVERY, canDecideDelivery, dayLabel, failureText, isSendKey, replyUsage, isHttps, relTime, windowMinutesLeft } from "@/lib/inbox";

const NOW = new Date("2026-11-13T12:00:00").getTime();
const ago = (ms: number) => new Date(NOW - ms).toISOString();

describe("inbox helpers", () => {
  it("formats relative times", () => {
    expect(relTime(ago(20_000), NOW)).toBe("now");
    expect(relTime(ago(5 * 60_000), NOW)).toBe("5m");
    expect(relTime(ago(3 * 3_600_000), NOW)).toBe("3h");
    expect(relTime(ago(2 * 86_400_000), NOW)).toBe("2d");
    expect(relTime(null, NOW)).toBe("");
  });
  it("labels days", () => {
    expect(dayLabel(ago(1_000), NOW)).toBe("Today");
    expect(dayLabel(ago(86_400_000), NOW)).toBe("Yesterday");
  });
  it("never shows an unknown delivery as sent", () => {
    expect(DELIVERY.unknown?.label).toBe("Delivery unknown");
    expect(DELIVERY.unknown?.label).not.toMatch(/sent/i);
    expect(DELIVERY.failed?.label).toBe("Not sent");
    expect(DELIVERY.received).toBeNull();
  });
  it("only https attachment links are openable", () => {
    expect(isHttps("https://cdn.example.com/a.png")).toBe(true);
    for (const u of ["http://x", "javascript:alert(1)", "data:text/html,x", "//x", null]) expect(isHttps(u)).toBe(false);
  });
  it("counts the 24 hour window from the last inbound message and only while open", () => {
    const last = ago(23 * 3_600_000);
    expect(windowMinutesLeft({ replyWindow: "open", lastInboundAt: last }, NOW)).toBe(60);
    expect(windowMinutesLeft({ replyWindow: "closed", lastInboundAt: last }, NOW)).toBeNull();
    expect(windowMinutesLeft({ replyWindow: "none", lastInboundAt: null }, NOW)).toBeNull();
  });
});

describe("composer helpers", () => {
  const key = (o: Partial<Parameters<typeof isSendKey>[0]> = {}) => ({ key: "Enter", shiftKey: false, ...o });
  it("Enter sends; Shift+Enter, Alt+Enter and other keys do not", () => {
    expect(isSendKey(key())).toBe(true);
    expect(isSendKey(key({ shiftKey: true }))).toBe(false);
    expect(isSendKey(key({ altKey: true }))).toBe(false);
    expect(isSendKey(key({ key: "a" }))).toBe(false);
  });
  it("Enter that confirms an IME composition (Bengali, Japanese) does not send", () => {
    expect(isSendKey(key({ isComposing: true }))).toBe(false);
  });
  it("failure reasons are sentences, never raw codes or Meta text", () => {
    for (const c of ["recipient_unavailable", "rate_limited", "token_invalid", "token_unavailable", "permission_denied", "invalid_request", "marked_not_sent", "meta_error_999", null]) {
      expect(failureText(c)).toMatch(/\.$/);
      expect(failureText(c)).not.toMatch(/meta_error|_/);
    }
    expect(failureText("token_invalid")).toMatch(/Reconnect/);
  });
  it("an unknown message can be decided only after 10 minutes", () => {
    const m = (state: "unknown" | "sent", minsAgo: number) => ({ deliveryState: state, occurredAt: ago(minsAgo * 60_000) });
    expect(canDecideDelivery(m("unknown", 9), NOW)).toBe(false);
    expect(canDecideDelivery(m("unknown", 10), NOW)).toBe(true);
    expect(canDecideDelivery(m("sent", 60), NOW)).toBe(false);
  });
});

describe("per-channel reply limits", () => {
  it("counts Instagram in UTF-8 bytes (Bengali = 3 bytes) and Messenger in characters", () => {
    expect(replyUsage("instagram", "a".repeat(1000), 2000)).toMatchObject({ used: 1000, unit: "bytes", over: false });
    expect(replyUsage("instagram", "a".repeat(1001), 2000).over).toBe(true);
    expect(replyUsage("instagram", "ক".repeat(334), 2000)).toMatchObject({ used: 1002, over: true });
    expect(replyUsage("instagram", "ক".repeat(333), 2000).over).toBe(false);
    expect(replyUsage("messenger", "ক".repeat(1500), 2000)).toMatchObject({ used: 1500, unit: "characters", over: false });
    expect(replyUsage("messenger", "a".repeat(2001), 2000).over).toBe(true);
  });
  it("has sentences for the Instagram failure codes", () => {
    for (const c of ["window_closed", "channel_access", "thread_owned_elsewhere"]) expect(failureText(c)).toMatch(/\.$/);
  });
});
