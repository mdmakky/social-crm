import { describe, expect, it } from "vitest";
import { DELIVERY, dayLabel, isHttps, relTime, windowMinutesLeft } from "@/lib/inbox";

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
