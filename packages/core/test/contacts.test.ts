import { describe, expect, it } from "vitest";
import {
  buildContactFromRow, contactKeys, escapeLike, normalizeEmail, normalizePhone, parseCsv, suggestMapping, toCsv, validateCustomValues,
  type CustomFieldDef, type ImportContext,
} from "../src/contacts.ts";

describe("normalizeEmail", () => {
  it("lowercases and trims; rejects invalid", () => {
    expect(normalizeEmail("  Ana.Silva@Example.COM ")).toBe("ana.silva@example.com");
    for (const bad of ["", "   ", "no-at", "a@b", "a b@c.com", "a@@b.com", null, undefined]) expect(normalizeEmail(bad as string)).toBeNull();
  });
});

describe("normalizePhone", () => {
  it("keeps a leading plus, strips formatting, and enforces 7 to 15 digits", () => {
    expect(normalizePhone("+1 (555) 010-9999")).toBe("+15550109999");
    expect(normalizePhone("0171-234 5678")).toBe("01712345678");
    expect(normalizePhone("+880 1712-345678")).toBe("+8801712345678");
  });
  it("rejects too short, too long and non-numeric values", () => {
    for (const bad of ["", "12345", "+1234567890123456", "call me", null]) expect(normalizePhone(bad as string)).toBeNull();
  });
});

describe("contactKeys", () => {
  it("builds duplicate keys from normalized email and phone only", () => {
    expect(contactKeys({ email: "A@x.com", phone: "+1 555 010 9999" })).toEqual(["email:a@x.com", "phone:+15550109999"]);
    expect(contactKeys({ email: "bad", phone: null })).toEqual([]);
  });
});

describe("escapeLike", () => {
  it("escapes wildcard characters so search input is literal", () => {
    expect(escapeLike("50%_off\\")).toBe("50\\%\\_off\\\\");
  });
});

const defs: CustomFieldDef[] = [
  { key: "budget", label: "Budget", type: "number", options: [], required: false },
  { key: "tier", label: "Tier", type: "select", options: ["gold", "silver"], required: true },
  { key: "interests", label: "Interests", type: "multiselect", options: ["a", "b", "c"], required: false },
  { key: "since", label: "Customer since", type: "date", options: [], required: false },
  { key: "vip", label: "VIP", type: "boolean", options: [], required: false },
  { key: "site", label: "Website", type: "url", options: [], required: false },
  { key: "note", label: "Note", type: "text", options: [], required: false },
];

describe("validateCustomValues", () => {
  it("accepts valid values of every type", () => {
    const r = validateCustomValues(defs, { budget: 1200.5, tier: "gold", interests: ["a", "c"], since: "2026-02-28", vip: true, site: "https://example.com/x", note: "ok" });
    expect(r.ok).toBe(true);
  });
  it("requires required fields and rejects unknown keys", () => {
    const r = validateCustomValues(defs, { bogus: 1 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(Object.keys(r.errors).sort()).toEqual(["bogus", "tier"]);
  });
  it("reports per-field type errors", () => {
    const r = validateCustomValues(defs, { tier: "bronze", budget: "lots", interests: ["z"], since: "2026-02-30", vip: "yes", site: "javascript:alert(1)", note: "x".repeat(501) });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(Object.keys(r.errors).sort()).toEqual(["budget", "interests", "note", "since", "site", "tier", "vip"]);
  });
  it("treats null and empty as cleared and still enforces required", () => {
    const r = validateCustomValues(defs, { tier: "silver", budget: null, note: "" });
    expect(r).toEqual({ ok: true, values: { tier: "silver" } });
  });
});

describe("parseCsv", () => {
  it("handles quotes, embedded commas and newlines, CRLF and a BOM", () => {
    const text = '﻿Name,Email,Note\r\n"Silva, Ana",ana@x.com,"line1\nline2"\r\nBob,bob@x.com,\r\n';
    const r = parseCsv(text);
    expect(r.headers).toEqual(["Name", "Email", "Note"]);
    expect(r.rows).toEqual([["Silva, Ana", "ana@x.com", "line1\nline2"], ["Bob", "bob@x.com", ""]]);
  });
  it("detects semicolon and tab delimiters", () => {
    expect(parseCsv("a;b\n1;2").rows).toEqual([["1", "2"]]);
    expect(parseCsv("a\tb\n1\t2").rows).toEqual([["1", "2"]]);
  });
  it("skips blank lines and pads short rows", () => {
    expect(parseCsv("a,b,c\n\n1,2\n").rows).toEqual([["1", "2", ""]]);
  });
  it("refuses malformed, empty, oversized and over-wide files with clear errors", () => {
    expect(() => parseCsv('a,b\n"unterminated,2')).toThrow(/CSV/);
    expect(() => parseCsv("")).toThrow(/empty/i);
    expect(() => parseCsv("a,b\n")).toThrow(/no data rows/i);
    expect(() => parseCsv("a\n" + "1\n".repeat(5001))).toThrow(/5000/);
    expect(() => parseCsv(Array.from({ length: 60 }, (_, i) => `c${i}`).join(",") + "\n1")).toThrow(/columns/i);
  });
});

describe("suggestMapping", () => {
  it("maps common header spellings and custom field labels, and leaves unknown columns unmapped", () => {
    const m = suggestMapping(["Full Name", "E-mail", "Mobile", "Company Name", "Stage", "Tags", "Customer since", "Favorite color"], defs);
    expect(m).toEqual(["name", "email", "phone", "company", "lifecycle_stage", "tags", "custom:since", null]);
  });
  it("never maps two columns to the same field", () => {
    const m = suggestMapping(["Email", "E-mail address"], defs);
    expect(m.filter((x) => x === "email")).toHaveLength(1);
  });
  it("maps first and last name separately", () => {
    expect(suggestMapping(["First name", "Last name"], defs)).toEqual(["first_name", "last_name"]);
  });
});

const ictx: ImportContext = {
  stages: [{ id: "s1", name: "New" }, { id: "s2", name: "Customer" }],
  defaultStageId: "s1",
  members: [{ userId: "u1", email: "owner@x.com" }],
  customDefs: defs.filter((d) => d.key !== "tier").map((d) => ({ ...d })),
};

describe("buildContactFromRow", () => {
  const headers = ["name", "email", "phone", "stage", "owner", "tags", "budget"];
  const mapping = ["name", "email", "phone", "lifecycle_stage", "owner_email", "tags", "custom:budget"] as const;
  it("builds a contact with normalized keys, stage, owner, tags and custom values", () => {
    const r = buildContactFromRow(["Ana Silva", "ANA@X.com", "+1 555 010 9999", "customer", "Owner@X.com", "vip; lead|vip", "1500"], mapping, ictx);
    expect(r).toEqual({
      ok: true,
      contact: { name: "Ana Silva", nameDerived: false, email: "ana@x.com", phone: "+1 555 010 9999", company: null, source: "import", lifecycleStageId: "s2", ownerUserId: "u1", tags: ["vip", "lead"], custom: { budget: 1500 } },
    });
    expect(headers).toHaveLength(7);
  });
  it("falls back to the email as the name and to the default stage", () => {
    const r = buildContactFromRow(["", "solo@x.com", "", "", "", "", ""], mapping, ictx);
    expect(r.ok && r.contact.name).toBe("solo@x.com");
    expect(r.ok && r.contact.lifecycleStageId).toBe("s1");
  });
  it("joins first and last name", () => {
    const r = buildContactFromRow(["Ana", "Silva", "a@x.com"], ["first_name", "last_name", "email"], ictx);
    expect(r.ok && r.contact.name).toBe("Ana Silva");
  });
  it("reports every problem in a row at once", () => {
    const r = buildContactFromRow(["", "bad-email", "12", "Nonexistent", "stranger@x.com", "", "abc"], mapping, ictx);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.map((e) => e.field).sort()).toEqual(["custom:budget", "email", "lifecycle_stage", "name", "owner_email", "phone"]);
  });
  it("rejects a row with no name, email or phone", () => {
    const r = buildContactFromRow(["", "", "", "", "", "", ""], mapping, ictx);
    expect(r.ok).toBe(false);
  });
  it("limits tags", () => {
    const r = buildContactFromRow(["Ana", Array.from({ length: 21 }, (_, i) => `t${i}`).join(",")], ["name", "tags"], ictx);
    expect(r.ok).toBe(false);
  });
});

describe("toCsv (export) neutralises spreadsheet formula injection", () => {
  it("prefixes cells that start with = + - @ tab or CR, quotes when needed, and escapes quotes", () => {
    const csv = toCsv(["name", "note"], [["=HYPERLINK(\"http://evil\")", "plain"], ["+1 555", "@cmd"], ["-5", "a,b"], ["say \"hi\"", "line\nbreak"]]);
    const lines = csv.split("\r\n");
    expect(lines[0]).toBe("name,note");
    expect(lines[1]).toBe("\"'=HYPERLINK(\"\"http://evil\"\")\",plain");
    expect(lines[2]).toBe("'+1 555,'@cmd");
    expect(lines[3]).toBe("'-5,\"a,b\"");
    expect(csv).toContain('"say ""hi""","line\nbreak"');
  });
  it("values that needed the formula guard still round-trip (the importer removes our apostrophe)", () => {
    const rows = [["+44 20 7946 0958", "-5"], ["=SUM(A1)", "@home"]];
    expect(parseCsv(toCsv(["Phone", "Note"], rows)).rows).toEqual(rows);
  });
  it("round-trips through the parser", () => {
    const rows = [["Ana, \"A\" Silva", "a@x.com"], ["Bob", ""]];
    const parsed = parseCsv(toCsv(["Name", "Email"], rows));
    expect(parsed.rows).toEqual(rows);
  });
});


describe("hostile input is linear time and bounded (security review B1, M1)", () => {
  const hostile = "x@" + ".a".repeat(50_000) + "@";
  it("normalizeEmail rejects a 100k-character quadratic payload quickly", () => {
    const t = performance.now();
    expect(normalizeEmail(hostile)).toBeNull();
    expect(normalizeEmail("x@" + ".a".repeat(2_000_000) + "@")).toBeNull();
    expect(performance.now() - t).toBeLessThan(50);
  });
  it("normalizeEmail still accepts ordinary and long-but-valid addresses", () => {
    expect(normalizeEmail("first.last+tag@sub.example.co.uk")).toBe("first.last+tag@sub.example.co.uk");
    expect(normalizeEmail("a".repeat(64) + "@example.com")).not.toBeNull();
    expect(normalizeEmail("a".repeat(65) + "@example.com")).toBeNull();
    expect(normalizeEmail("a@" + "b".repeat(250) + ".com")).toBeNull();
  });
  it("normalizePhone and the CSV parser stay fast on huge cells", () => {
    const t = performance.now();
    expect(normalizePhone("1 ".repeat(1_000_000))).toBeNull();
    expect(() => parseCsv("Email\n" + "x".repeat(5_000_000))).toThrow(/1000 characters/);
    expect(performance.now() - t).toBeLessThan(300);
  });
  it("counts bytes, not characters, for the size limit", () => {
    expect(() => parseCsv("Name\n" + "€".repeat(1_800_000))).toThrow(/5 MB/);
  });
  it("aborts early on too many rows or columns without materialising everything", () => {
    const t = performance.now();
    expect(() => parseCsv("a\n" + "1\n".repeat(2_000_000))).toThrow(/5000/);
    expect(() => parseCsv(Array.from({ length: 60 }, (_, i) => `c${i}`).join(",") + "\n1")).toThrow(/columns/);
    expect(performance.now() - t).toBeLessThan(1500);
  });
  it("refuses NUL bytes in files and fields", () => {
    expect(() => parseCsv("Name\nA\u0000B")).toThrow(/NUL|invalid/i);
  });
});

describe("import fixes (security M3, integrity m7, m11)", () => {
  const ctx2 = { stages: [{ id: "s1", name: "New" }], defaultStageId: "s1", members: [], customDefs: [] };
  it("flags a name derived from the email or phone so updates never overwrite a real name", () => {
    const a = buildContactFromRow(["real@example.com"], ["email"], ctx2);
    expect(a.ok && a.contact.nameDerived).toBe(true);
    const b = buildContactFromRow(["+1 555 010 4444"], ["phone"], ctx2);
    expect(b.ok && b.contact.nameDerived).toBe(true);
    const c = buildContactFromRow(["Ana", "ana@x.com"], ["name", "email"], ctx2);
    expect(c.ok && c.contact.nameDerived).toBe(false);
  });
  it("applies the same field limits as manual creation", () => {
    const r = buildContactFromRow(["x".repeat(121), "y".repeat(121), "1".repeat(41)], ["name", "company", "phone"], ctx2);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.map((e) => e.field).sort()).toEqual(["company", "name", "phone"]);
  });
  it("collapses line breaks inside names and companies", () => {
    const r = buildContactFromRow(["Ana\r\nCosta", "Acme\nInc"], ["name", "company"], ctx2);
    expect(r.ok && r.contact.name).toBe("Ana Costa");
    expect(r.ok && r.contact.company).toBe("Acme Inc");
  });
  it("treats a 00 international prefix like +", () => {
    expect(normalizePhone("0044 20 7946 0958")).toBe("+442079460958");
    expect(normalizePhone("+44 20 7946 0958")).toBe("+442079460958");
    expect(normalizePhone("020 7946 0958")).toBe("02079460958");
  });
  it("custom values: unsafe numbers are refused and partial validation skips untouched fields", () => {
    const d: CustomFieldDef[] = [{ key: "n", label: "N", type: "number", options: [], required: false }, { key: "tier", label: "Tier", type: "select", options: ["gold"], required: true }];
    expect(validateCustomValues(d, { n: Number.MAX_SAFE_INTEGER + 2, tier: "gold" }).ok).toBe(false);
    expect(validateCustomValues(d, { n: 1e21, tier: "gold" }).ok).toBe(false);
    expect(validateCustomValues(d, { n: 5 }, { partial: true })).toEqual({ ok: true, values: { n: 5 } });
    expect(validateCustomValues(d, { n: 5 }).ok).toBe(false);
  });
});
