import { describe, expect, it } from "vitest";
import { formatMicro, parseMicro } from "@/lib/ai-money";

describe("ai money (integer micro-units)", () => {
  it("formats", () => {
    expect(formatMicro(0)).toBe("0.00");
    expect(formatMicro(3_000_000)).toBe("3.00");
    expect(formatMicro(1_234_567)).toBe("1.234567");
    expect(formatMicro(500)).toBe("0.0005");
  });
  it("parses plain decimals only, exactly", () => {
    expect(parseMicro("12.5")).toBe(12_500_000);
    expect(parseMicro(" 0.1 ")).toBe(100_000);
    expect(parseMicro("0.000001")).toBe(1);
    expect(parseMicro("5")).toBe(5_000_000);
    for (const bad of ["", "-1", "1.1234567", "1e3", "abc", "1,5", "1.", ".5", "1000000000"]) expect(parseMicro(bad), bad).toBeNull();
  });
  it("round-trips", () => {
    for (const v of [0, 1, 999_999, 1_000_000, 123_456_789]) expect(parseMicro(formatMicro(v))).toBe(v);
  });
});
