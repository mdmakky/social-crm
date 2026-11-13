import { parse } from "csv-parse/sync";

export const CONTACT_SOURCES = ["manual", "import", "messenger", "instagram", "facebook_lead_ad", "web_form", "referral", "other"] as const;
export const IMPORT_LIMITS = { maxBytes: 5 * 1024 * 1024, maxRows: 5000, maxColumns: 50 } as const;

export function normalizeEmail(v: string | null | undefined): string | null {
  const s = (v ?? "").trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) && s.length <= 254 ? s : null;
}

/** Keeps a leading "+", strips formatting. 7 to 15 digits (E.164 maximum). Numbers without a country prefix are compared as written. */
export function normalizePhone(v: string | null | undefined): string | null {
  const s = (v ?? "").trim();
  if (!/^[+\d\s().-]+$/.test(s)) return null;
  const digits = s.replace(/\D/g, "");
  if (digits.length < 7 || digits.length > 15) return null;
  return (s.startsWith("+") ? "+" : "") + digits;
}

export const contactKeys = (c: { email?: string | null; phone?: string | null }): string[] => {
  const e = normalizeEmail(c.email);
  const p = normalizePhone(c.phone);
  return [...(e ? [`email:${e}`] : []), ...(p ? [`phone:${p}`] : [])];
};

/** Escapes LIKE wildcards so user search text matches literally (use with ESCAPE '\'). */
export const escapeLike = (s: string) => s.replace(/[\\%_]/g, (m) => `\\${m}`);

// ---------- custom fields ----------

export type CustomFieldDef = { key: string; label: string; type: "text" | "number" | "date" | "select" | "multiselect" | "boolean" | "url"; options: string[]; required: boolean };
export type CustomValidation = { ok: true; values: Record<string, unknown> } | { ok: false; errors: Record<string, string> };

function validDate(s: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return false;
  const d = new Date(Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!));
  return d.getUTCFullYear() === +m[1]! && d.getUTCMonth() === +m[2]! - 1 && d.getUTCDate() === +m[3]!;
}

export function validateCustomValues(defs: CustomFieldDef[], input: Record<string, unknown>): CustomValidation {
  const errors: Record<string, string> = {};
  const values: Record<string, unknown> = {};
  const byKey = new Map(defs.map((d) => [d.key, d]));
  for (const key of Object.keys(input)) if (!byKey.has(key)) errors[key] = "Unknown field";
  for (const d of defs) {
    const v = input[d.key];
    if (v === undefined || v === null || v === "" || (Array.isArray(v) && v.length === 0)) {
      if (d.required) errors[d.key] = `${d.label} is required`;
      continue;
    }
    switch (d.type) {
      case "text":
        if (typeof v !== "string" || v.length > 500) errors[d.key] = "Use text up to 500 characters";
        else values[d.key] = v;
        break;
      case "number":
        if (typeof v !== "number" || !Number.isFinite(v)) errors[d.key] = "Enter a number";
        else values[d.key] = v;
        break;
      case "date":
        if (typeof v !== "string" || !validDate(v)) errors[d.key] = "Use a real date as YYYY-MM-DD";
        else values[d.key] = v;
        break;
      case "boolean":
        if (typeof v !== "boolean") errors[d.key] = "Choose yes or no";
        else values[d.key] = v;
        break;
      case "select":
        if (typeof v !== "string" || !d.options.includes(v)) errors[d.key] = "Choose one of the listed options";
        else values[d.key] = v;
        break;
      case "multiselect":
        if (!Array.isArray(v) || v.some((x) => typeof x !== "string" || !d.options.includes(x))) errors[d.key] = "Choose only listed options";
        else values[d.key] = Array.from(new Set(v as string[]));
        break;
      case "url":
        try {
          const u = new URL(String(v));
          if (typeof v !== "string" || !["http:", "https:"].includes(u.protocol) || v.length > 2000) throw new Error("scheme");
          values[d.key] = v;
        } catch {
          errors[d.key] = "Enter a web address starting with http:// or https://";
        }
        break;
    }
  }
  return Object.keys(errors).length ? { ok: false, errors } : { ok: true, values };
}

// ---------- CSV ----------

export class ImportError extends Error {}

export function parseCsv(text: string): { headers: string[]; rows: string[][] } {
  if (text.length > IMPORT_LIMITS.maxBytes) throw new ImportError("The file is larger than 5 MB.");
  const body = text.replace(/^\uFEFF/, "");
  if (body.trim() === "") throw new ImportError("The file is empty.");
  const first = body.split(/\r?\n/, 1)[0] ?? "";
  const delimiter = ([",", ";", "\t"] as const).map((d) => ({ d, n: first.split(d).length })).sort((a, b) => b.n - a.n)[0]!.d;
  let records: string[][];
  try {
    records = parse(body, { delimiter, skip_empty_lines: true, relax_column_count: true, trim: false }) as string[][];
  } catch (e) {
    throw new ImportError(`CSV format problem: ${(e as Error).message}`);
  }
  const headers = (records.shift() ?? []).map((h) => h.trim());
  if (headers.length > IMPORT_LIMITS.maxColumns) throw new ImportError(`The file has more than ${IMPORT_LIMITS.maxColumns} columns.`);
  if (records.length === 0) throw new ImportError("The file has a header but no data rows.");
  if (records.length > IMPORT_LIMITS.maxRows) throw new ImportError(`The file has more than ${IMPORT_LIMITS.maxRows} rows. Split it into smaller files.`);
  // Our own export prefixes cells that start with = + - @ with an apostrophe (spreadsheet formula injection guard); undo it so exports re-import cleanly.
  const unguard = (v: string) => (/^'[=+\-@]/.test(v) ? v.slice(1) : v);
  const rows = records.map((r, i) => {
    if (r.length > headers.length) throw new ImportError(`Row ${i + 2} has more values than the header has columns.`);
    return headers.map((_, c) => unguard((r[c] ?? "").trim()));
  });
  return { headers, rows };
}

const csvCell = (v: string): string => {
  const safe = /^[=+\-@\t\r]/.test(v) ? `'${v}` : v; // spreadsheet formula injection guard
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};
export const toCsv = (headers: string[], rows: string[][]): string => [headers, ...rows].map((r) => r.map(csvCell).join(",")).join("\r\n");

// ---------- import mapping ----------

export type ImportField = "name" | "first_name" | "last_name" | "email" | "phone" | "company" | "source" | "lifecycle_stage" | "owner_email" | "tags" | `custom:${string}`;

const SYNONYMS: Record<Exclude<ImportField, `custom:${string}`>, string[]> = {
  name: ["name", "fullname", "contact", "contactname", "customer", "customername"],
  first_name: ["firstname", "first", "givenname"],
  last_name: ["lastname", "last", "surname", "familyname"],
  email: ["email", "emailaddress", "mail"],
  phone: ["phone", "phonenumber", "mobile", "mobilenumber", "cell", "telephone", "tel"],
  company: ["company", "companyname", "organization", "organisation", "business", "employer"],
  source: ["source", "leadsource", "channel"],
  lifecycle_stage: ["stage", "lifecycle", "lifecyclestage", "status"],
  owner_email: ["owner", "owneremail", "assignedto", "accountowner"],
  tags: ["tags", "tag", "labels"],
};
const squash = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

export function suggestMapping(headers: string[], defs: CustomFieldDef[]): (ImportField | null)[] {
  const used = new Set<string>();
  return headers.map((h) => {
    const k = squash(h);
    let hit: ImportField | null = null;
    for (const [field, words] of Object.entries(SYNONYMS)) if (words.includes(k)) hit = field as ImportField;
    if (!hit) {
      const d = defs.find((x) => squash(x.label) === k || squash(x.key) === k);
      if (d) hit = `custom:${d.key}`;
    }
    if (!hit || used.has(hit)) return null;
    used.add(hit);
    return hit;
  });
}

export type ImportContext = {
  stages: { id: string; name: string }[];
  defaultStageId: string;
  members: { userId: string; email: string }[];
  customDefs: CustomFieldDef[];
};
export type ImportedContact = { name: string; email: string | null; phone: string | null; company: string | null; source: string; lifecycleStageId: string; ownerUserId: string | null; tags: string[]; custom: Record<string, unknown> };
export type RowResult = { ok: true; contact: ImportedContact } | { ok: false; errors: { field: string; message: string }[] };

const TRUE = new Set(["true", "yes", "y", "1"]);
const FALSE = new Set(["false", "no", "n", "0"]);

export function buildContactFromRow(row: string[], mapping: readonly (ImportField | null)[], ctx: ImportContext): RowResult {
  const get = (f: ImportField) => {
    const i = mapping.indexOf(f);
    return i === -1 ? "" : (row[i] ?? "").trim();
  };
  const errors: { field: string; message: string }[] = [];

  const rawEmail = get("email");
  const email = normalizeEmail(rawEmail);
  if (rawEmail && !email) errors.push({ field: "email", message: `"${rawEmail}" is not a valid email address` });
  const rawPhone = get("phone");
  const phone = normalizePhone(rawPhone);
  if (rawPhone && !phone) errors.push({ field: "phone", message: `"${rawPhone}" is not a valid phone number (7 to 15 digits)` });

  const name = get("name") || [get("first_name"), get("last_name")].filter(Boolean).join(" ") || email || "";
  if (!name && !phone) errors.push({ field: "name", message: "Add a name, an email or a phone number" });
  const finalName = name || (phone ?? "");

  let stageId = ctx.defaultStageId;
  const rawStage = get("lifecycle_stage");
  if (rawStage) {
    const s = ctx.stages.find((x) => x.name.toLowerCase() === rawStage.toLowerCase());
    if (s) stageId = s.id;
    else errors.push({ field: "lifecycle_stage", message: `Unknown lifecycle stage "${rawStage}"` });
  }

  let ownerUserId: string | null = null;
  const rawOwner = get("owner_email");
  if (rawOwner) {
    const m = ctx.members.find((x) => x.email.toLowerCase() === rawOwner.toLowerCase());
    if (m) ownerUserId = m.userId;
    else errors.push({ field: "owner_email", message: `"${rawOwner}" is not a member of this workspace` });
  }

  const tags = Array.from(new Set(get("tags").split(/[,;|]/).map((t) => t.trim()).filter(Boolean)));
  if (tags.length > 20 || tags.some((t) => t.length > 40)) errors.push({ field: "tags", message: "Use at most 20 tags of up to 40 characters" });

  const rawCustom: Record<string, unknown> = {};
  for (const d of ctx.customDefs) {
    const raw = get(`custom:${d.key}`);
    if (raw === "") continue;
    if (d.type === "number") rawCustom[d.key] = raw.trim() !== "" && Number.isFinite(Number(raw)) ? Number(raw) : raw;
    else if (d.type === "boolean") rawCustom[d.key] = TRUE.has(raw.toLowerCase()) ? true : FALSE.has(raw.toLowerCase()) ? false : raw;
    else if (d.type === "select") rawCustom[d.key] = d.options.find((o) => o.toLowerCase() === raw.toLowerCase()) ?? raw;
    else if (d.type === "multiselect") rawCustom[d.key] = raw.split(/[;,|]/).map((x) => x.trim()).filter(Boolean).map((x) => d.options.find((o) => o.toLowerCase() === x.toLowerCase()) ?? x);
    else rawCustom[d.key] = raw;
  }
  const custom = validateCustomValues(ctx.customDefs, rawCustom);
  if (!custom.ok) for (const [k, m] of Object.entries(custom.errors)) errors.push({ field: `custom:${k}`, message: m });

  if (errors.length) return { ok: false, errors };
  const source = get("source").toLowerCase();
  return {
    ok: true,
    contact: {
      name: finalName,
      email,
      phone: rawPhone || null,
      company: get("company") || null,
      source: (CONTACT_SOURCES as readonly string[]).includes(source) ? source : "import",
      lifecycleStageId: stageId,
      ownerUserId,
      tags,
      custom: custom.ok ? custom.values : {},
    },
  };
}
