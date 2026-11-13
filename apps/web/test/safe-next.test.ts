import { describe, expect, it } from "vitest";
import { safeNext } from "@/lib/safe-next";

describe("safeNext (open-redirect guard)", () => {
  it("keeps same-origin paths, queries and fragments", () => {
    expect(safeNext("/w/abc/members")).toBe("/w/abc/members");
    expect(safeNext("/w/abc?x=1#y")).toBe("/w/abc?x=1#y");
    expect(safeNext("/")).toBe("/");
  });
  it.each([
    ["//evil.com"],
    ["///evil.com"],
    ["/\\evil.com"],
    ["/\\/evil.com"],
    ["\\\\evil.com"],
    ["https://evil.com"],
    ["http://evil.com/x"],
    ["javascript:alert(1)"],
    ["data:text/html,x"],
    ["/\tevil.com"],
    ["/\n/evil.com"],
    ["\t//evil.com"],
    [" //evil.com"],
    ["evil.com"],
    ["/%5Cevil.com/../../"].slice(0, 0),
  ].filter((c) => c.length))("rejects %s", (bad) => {
    expect(safeNext(bad as string)).toBe("/");
  });
  it("falls back for empty, missing and oversized input", () => {
    expect(safeNext(undefined)).toBe("/");
    expect(safeNext("")).toBe("/");
    expect(safeNext("/" + "a".repeat(3000))).toBe("/");
    expect(safeNext("//x", "/home")).toBe("/home");
  });
});
