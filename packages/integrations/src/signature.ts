import { createHmac, timingSafeEqual } from "node:crypto";

export function signMetaBody(raw: Uint8Array | string, secret: string): string {
  return "sha256=" + createHmac("sha256", secret).update(raw).digest("hex");
}

/** Checks every secret (no early exit) so timing does not reveal which one matched. Never throws. */
export function verifyMetaSignature(raw: Uint8Array, header: string | null | undefined, secrets: string[]): boolean {
  try {
    if (typeof header !== "string" || !/^sha256=[0-9a-f]{64}$/.test(header)) return false;
    const got = Buffer.from(header.slice(7), "hex");
    let ok = false;
    for (const s of secrets) {
      if (typeof s !== "string" || s === "") continue;
      const want = createHmac("sha256", s).update(raw).digest();
      if (timingSafeEqual(got, want)) ok = true;
    }
    return ok;
  } catch {
    return false;
  }
}
