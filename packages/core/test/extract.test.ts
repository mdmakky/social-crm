import { describe, expect, it } from "vitest";
import { classifyPhone, extractContactData, extractEmails, extractPhones } from "../src/extract.ts";

const vals = (t: string) => extractPhones(t).map((p) => p.value);

describe("Bangladeshi phone formats", () => {
  it.each(["01712345678", "+8801712345678", "8801712345678", "01712-345678", "01712 345 678", "+880 1712-345678", "008801712345678", "+88 01712345678", "(01712) 345678"])("normalises %s", (raw) => {
    expect(vals(`call me on ${raw} please`)).toEqual(["+8801712345678"]);
  });
  it("covers every mobile operator prefix 013-019 and rejects 010, 011, 012", () => {
    for (const p of ["013", "014", "015", "016", "017", "018", "019"]) expect(vals(`${p}12345678`)).toEqual([`+880${p.slice(1)}12345678`]);
    for (const p of ["010", "011", "012"]) expect(vals(`${p}12345678`)).toEqual([]);
  });
  it("reads Bengali digits", () => {
    expect(vals("আমার নাম্বার ০১৭১২৩৪৫৬৭৮")).toEqual(["+8801712345678"]);
  });
  it("finds several numbers in one message, once each, in order", () => {
    expect(vals("01712345678 or 01812345678, again 01712-345678")).toEqual(["+8801712345678", "+8801812345678"]);
  });
  it("finds a number next to other digits, and ignores quantities and dates", () => {
    expect(vals("order 10 20 30 01712345678 thanks")).toEqual(["+8801712345678"]);
    expect(vals("2026-11-14 total 1500 qty 25 ref 123456")).toEqual([]);
  });
});

describe("international phones", () => {
  it("accepts explicit +CC and 00CC forms", () => {
    expect(vals("US +1 415 555 2671")).toEqual(["+14155552671"]);
    expect(vals("UK +44 7911 123456")).toEqual(["+447911123456"]);
    expect(vals("0044 7911 123456")).toEqual(["+447911123456"]);
  });
  it("does not guess bare national numbers from other countries", () => {
    expect(vals("4155552671")).toEqual([]);
    expect(vals("07911123456")).toEqual([]);
  });
  it("rejects repeated digits and too short/long", () => {
    expect(vals("+11111111111")).toEqual([]);
    expect(vals("+1234567")).toEqual([]);
    expect(vals("+1234567890123456")).toEqual([]);
  });
});

describe("confidence, bounds, hostile input", () => {
  it("scores by format and a nearby context word", () => {
    const [a] = extractPhones("+8801712345678");
    const [b] = extractPhones("my phone number: 01712345678");
    const [c] = extractPhones("01712345678");
    expect(a!.confidence).toBe(0.95);
    expect(c!.confidence).toBe(0.9);
    expect(b!.confidence).toBeCloseTo(0.94, 2);
    expect(classifyPhone("+14155552671")!.confidence).toBe(0.8);
  });
  it("keeps the number as the customer wrote it, bounded", () => {
    expect(extractPhones("01712-345678")[0]!.raw).toBe("01712-345678");
  });
  it("caps results per message and runs fast on adversarial text", () => {
    const many = Array.from({ length: 20 }, (_, i) => `0171234${String(1000 + i)}`).join(" ");
    expect(extractPhones(many).length).toBeLessThanOrEqual(5);
    const t0 = performance.now();
    extractPhones("1 ".repeat(5000) + "-".repeat(5000) + "9".repeat(5000));
    expect(performance.now() - t0).toBeLessThan(200);
  });
  it("returns nothing for empty and non-phone text", () => {
    expect(extractPhones("")).toEqual([]);
    expect(extractPhones("hello, price?")).toEqual([]);
  });
});

const emails = (t: string) => extractEmails(t).map((e) => e.value);

describe("email extraction", () => {
  it("finds, lower-cases and normalises addresses; strips surrounding punctuation", () => {
    expect(emails("Mail me at Rahim.Uddin+crm@Example.COM, thanks")).toEqual(["rahim.uddin+crm@example.com"]);
    expect(emails("(a@b.co) and <c@d.org>.")).toEqual(["a@b.co", "c@d.org"]);
    expect(emails("my email is info@shop.com.bd.")).toEqual(["info@shop.com.bd"]);
  });
  it("keeps each address once and keeps what was written", () => {
    const r = extractEmails("a@b.com A@B.COM a@b.com");
    expect(r.map((e) => e.value)).toEqual(["a@b.com"]);
    expect(r[0]).toMatchObject({ kind: "email", raw: "a@b.com", confidence: 0.95 });
  });
  it("rejects malformed addresses, asset names and non-addresses", () => {
    for (const t of ["a@b", "@b.com", "a@.com", "a@b..com", "icon@2x.png", "logo@3x.jpg", "price@100", "a@b.c", "user@domain.123"]) expect(emails(t), t).toEqual([]);
  });
  it("caps results and stays fast on adversarial text", () => {
    expect(extractEmails(Array.from({ length: 20 }, (_, i) => `u${i}@x.com`).join(" ")).length).toBe(5);
    const t0 = performance.now();
    extractEmails("a".repeat(5000) + "@" + "b.".repeat(2000) + "@".repeat(2000));
    expect(performance.now() - t0).toBeLessThan(200);
  });
  it("combines phones and emails from one message", () => {
    expect(extractContactData("call 01712345678 or mail a@b.com").map((m) => [m.kind, m.value])).toEqual([["phone", "+8801712345678"], ["email", "a@b.com"]]);
  });
});
