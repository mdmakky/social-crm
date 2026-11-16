export const CONSENT_PURPOSE = "ad_measurement";
export type ConsentStatus = "granted" | "revoked";
export type GateResult = { allow: true } | { allow: false; reason: "no_consent" | "opted_out" };

/**
 * Consent gate. `latest` is the newest consent record for the contact and purpose (or null).
 * Default is deny: no record means no send; a revocation always wins over any earlier grant because only the latest record counts.
 */
export function consentGate(latest: { status: ConsentStatus } | null | undefined): GateResult {
  if (!latest) return { allow: false, reason: "no_consent" };
  return latest.status === "granted" ? { allow: true } : { allow: false, reason: "opted_out" };
}
