import { createHash } from "node:crypto";

/** SHA-256 hex of a normalised value (Meta: lowercase hex, UTF-8). */
export const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

const clean = (s: string) => s.normalize("NFC").trim().toLowerCase();
const nonEmpty = (s: string) => (s.length > 0 ? s : null);

/**
 * Normalisers per Meta's customer information parameters rules (docs read 2026-11-13, see docs/research/meta-capi-research.md).
 * Each returns null when the value cannot become a valid identifier: it is then OMITTED, never guessed.
 */
export const normalize = {
  /** em: trim, lowercase. Must look like an address; anything else is dropped. */
  em: (v: string) => {
    const s = clean(v);
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) ? s : null;
  },
  /** ph: digits only, no leading zeros, country code included (we cannot add one: a number without it is dropped by the length rule). */
  ph: (v: string) => {
    const s = v.replace(/\D/g, "").replace(/^0+/, "");
    return s.length >= 8 && s.length <= 15 ? s : null;
  },
  /** fn, ln: lowercase, punctuation and digits removed (letters of any script are kept). */
  name: (v: string) => nonEmpty(clean(v).replace(/[^\p{L}\p{M} ]/gu, "").replace(/\s+/g, " ").trim()),
  /** ct: lowercase letters only, no spaces or punctuation. */
  ct: (v: string) => nonEmpty(clean(v).replace(/[^\p{L}\p{M}]/gu, "")),
  /** st: lowercase letters only (a two-letter code is expected for US states). */
  st: (v: string) => nonEmpty(clean(v).replace(/[^\p{L}\p{M}]/gu, "")),
  /** zp: lowercase, no spaces or dashes; US ZIP+4 is cut to the first 5 digits. */
  zp: (v: string) => {
    const s = clean(v).replace(/[\s-]/g, "");
    if (/^\d{9}$/.test(s)) return s.slice(0, 5);
    return nonEmpty(s.replace(/[^\p{L}\p{N}]/gu, ""));
  },
  /** country: ISO 3166-1 alpha-2, lowercase. */
  country: (v: string) => {
    const s = clean(v);
    return /^[a-z]{2}$/.test(s) ? s : null;
  },
  /** external_id: trimmed, case kept (an id is not a name); empty is dropped. */
  external_id: (v: string) => nonEmpty(v.trim()),
};

export type UserInput = {
  email?: string | null;
  phone?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  city?: string | null;
  state?: string | null;
  zip?: string | null;
  country?: string | null;
  externalId?: string | null;
  /** Captured by the website Pixel / click; sent as is. Never synthesised. */
  fbp?: string | null;
  fbc?: string | null;
};

export type UserData = Partial<Record<"em" | "ph" | "fn" | "ln" | "ct" | "st" | "zp" | "country" | "external_id", string[]>> & { fbp?: string; fbc?: string };

const FBP = /^fb\.\d\.\d{10,13}\.\d+$/;
const FBC = /^fb\.\d\.\d{10,13}\.\S+$/;

/** Normalise then hash every hashed field; fbp/fbc pass through unhashed and only when well formed. Missing or invalid values are omitted. */
export function buildUserData(i: UserInput): UserData {
  const out: UserData = {};
  const put = (k: Exclude<keyof UserData, "fbp" | "fbc">, v: string | null | undefined, n: (s: string) => string | null) => {
    if (!v) return;
    const x = n(v);
    if (x) out[k] = [sha256(x)];
  };
  put("em", i.email, normalize.em);
  put("ph", i.phone, normalize.ph);
  put("fn", i.firstName, normalize.name);
  put("ln", i.lastName, normalize.name);
  put("ct", i.city, normalize.ct);
  put("st", i.state, normalize.st);
  put("zp", i.zip, normalize.zp);
  put("country", i.country, normalize.country);
  put("external_id", i.externalId, normalize.external_id);
  if (i.fbp && FBP.test(i.fbp)) out.fbp = i.fbp;
  if (i.fbc && FBC.test(i.fbc)) out.fbc = i.fbc;
  return out;
}
