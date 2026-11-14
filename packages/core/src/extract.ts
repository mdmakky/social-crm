import { normalizeEmail } from "./contacts.ts";

/**
 * Deterministic contact-data extraction from chat text. Pure, bounded, no I/O: it is safe to run inside webhook processing.
 * Phones: Bangladeshi mobile numbers in every common written form, and international numbers only when written with an explicit +CC or 00CC prefix
 * (a bare national number from another country is ambiguous with order numbers and amounts, so it is NOT extracted: documented limitation).
 * Confidence is a deterministic score from the format and nearby context words, not a model output.
 */
export type ExtractedMethod = { kind: "phone" | "email"; value: string; raw: string; confidence: number };

export const MAX_EXTRACT_TEXT = 4000;
export const MAX_PER_MESSAGE = 5;

const BN_DIGITS = "০১২৩৪৫৬৭৮৯";
/** Bengali digits to ASCII (customers often type numbers in Bangla). */
export const asciiDigits = (s: string) => s.replace(/[০-৯]/g, (d) => String(BN_DIGITS.indexOf(d)));

const CONTEXT = /(phone|mobile|call|whats\s?app|number|contact|ফোন|মোবাইল|নম্বর|নাম্বার|কল|হোয়াটসঅ্যাপ)/i;
// Runs of digits with common separators. Bounded length; whitespace-separated groups are re-split below so a number next to other numbers is still found.
const RUN = /(?<![\d+])\+?\d(?:[\d\s().-]{4,28}\d)?(?!\d)/g;

type Hit = { value: string; confidence: number };

/** Classifies one candidate written number. Returns the E.164 value or null when it is not a plausible phone number. */
export function classifyPhone(raw: string): Hit | null {
  const compact = raw.replace(/[\s().-]/g, "");
  if (!/^\+?\d{8,17}$/.test(compact)) return null;
  let m: RegExpExecArray | null;
  if ((m = /^\+880(1[3-9]\d{8})$/.exec(compact))) return { value: `+880${m[1]}`, confidence: 0.95 };
  if ((m = /^00880(1[3-9]\d{8})$/.exec(compact))) return { value: `+880${m[1]}`, confidence: 0.94 };
  if ((m = /^880(1[3-9]\d{8})$/.exec(compact))) return { value: `+880${m[1]}`, confidence: 0.92 };
  if ((m = /^01([3-9]\d{8})$/.exec(compact))) return { value: `+8801${m[1]}`, confidence: 0.9 };
  const intl = /^\+([1-9]\d{7,14})$/.exec(compact) ?? /^00([1-9]\d{7,14})$/.exec(compact);
  if (intl) {
    const d = intl[1]!;
    if (/^(\d)\1+$/.test(d)) return null; // 11111111: not a real number
    return { value: `+${d}`, confidence: compact.startsWith("+") ? 0.8 : 0.75 };
  }
  return null;
}

export function extractPhones(text: string): ExtractedMethod[] {
  const src = asciiDigits(text.slice(0, MAX_EXTRACT_TEXT));
  const out: ExtractedMethod[] = [];
  const seen = new Set<string>();
  for (const m of src.matchAll(RUN)) {
    const tokens = m[0].split(/\s+/).filter(Boolean);
    let i = 0;
    while (i < tokens.length) {
      let taken = 0;
      for (let end = Math.min(tokens.length, i + 5); end > i; end--) {
        const raw = tokens.slice(i, end).join(" ");
        const hit = classifyPhone(raw);
        if (!hit) continue;
        if (!seen.has(hit.value)) {
          seen.add(hit.value);
          const before = src.slice(Math.max(0, (m.index ?? 0) - 40), m.index ?? 0);
          out.push({ kind: "phone", value: hit.value, raw: raw.slice(0, 40), confidence: Math.min(0.99, hit.confidence + (CONTEXT.test(before) ? 0.04 : 0)) });
        }
        taken = end - i;
        break;
      }
      i += taken || 1;
    }
    if (out.length >= MAX_PER_MESSAGE) break;
  }
  return out.slice(0, MAX_PER_MESSAGE);
}

// Candidate emails: bounded local part and labels, so cost is linear. Validity is then decided by normalizeEmail (the same rule manual entry uses).
const EMAIL = /[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63}){1,5}/g;
// "icon@2x.png" style asset names look like emails; real addresses never end in these.
const FILE_TLD = /^(png|jpe?g|gif|webp|svg|bmp|ico|css|js|json|html?|pdf|zip)$/i;

export function extractEmails(text: string): ExtractedMethod[] {
  const out: ExtractedMethod[] = [];
  const seen = new Set<string>();
  for (const m of text.slice(0, MAX_EXTRACT_TEXT).matchAll(EMAIL)) {
    const raw = m[0].replace(/^[._%+-]+/, "");
    const value = normalizeEmail(raw);
    const tld = value?.split(".").pop() ?? "";
    if (!value || tld.length < 2 || !/^[a-z]+$/.test(tld) || FILE_TLD.test(tld) || value.includes("..")) continue;
    if (seen.has(value)) continue;
    seen.add(value);
    out.push({ kind: "email", value, raw: raw.slice(0, 120), confidence: 0.95 });
    if (out.length >= MAX_PER_MESSAGE) break;
  }
  return out;
}

/** Everything extractable from one message, phones first. */
export const extractContactData = (text: string): ExtractedMethod[] => [...extractPhones(text), ...extractEmails(text)];
