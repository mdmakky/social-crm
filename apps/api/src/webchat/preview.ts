import { createHmac, timingSafeEqual } from "node:crypto";

/** Preview grant: lets the owner's own web app test a widget whose allowlist (rightly) does not list our origin. See decision D270. */
export const PREVIEW_TTL_MS = 10 * 60_000;
export type PreviewClaims = { w: string; ws: string; u: string; exp: number };

const mac = (key: Buffer, body: string) => createHmac("sha256", key).update(body).digest("base64url");

export function signPreview(key: Buffer, c: Omit<PreviewClaims, "exp">, now = Date.now()): { grant: string; expiresAt: string } {
  const exp = now + PREVIEW_TTL_MS;
  const body = Buffer.from(JSON.stringify({ ...c, exp })).toString("base64url");
  return { grant: `${body}.${mac(key, body)}`, expiresAt: new Date(exp).toISOString() };
}

/** Claims of a well-formed, correctly signed, unexpired grant; otherwise null. The caller still has to compare widget and workspace. */
export function verifyPreview(key: Buffer, grant: string | undefined, now = Date.now()): PreviewClaims | null {
  const m = /^([A-Za-z0-9_-]{1,400})\.([A-Za-z0-9_-]{43})$/.exec(grant ?? "");
  if (!m) return null;
  const want = Buffer.from(mac(key, m[1]!));
  const got = Buffer.from(m[2]!);
  if (want.length !== got.length || !timingSafeEqual(want, got)) return null;
  try {
    const c = JSON.parse(Buffer.from(m[1]!, "base64url").toString()) as PreviewClaims;
    return typeof c.w === "string" && typeof c.ws === "string" && typeof c.u === "string" && typeof c.exp === "number" && c.exp > now ? c : null;
  } catch {
    return null;
  }
}
