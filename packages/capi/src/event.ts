import { z } from "zod";
import { sha256 } from "./hash.ts";

/** Standard events a CRM can honestly send (the website Pixel owns PageView, AddToCart, ...: architecture section 2). */
export const CAPI_EVENT_NAMES = ["Lead", "Purchase", "Schedule", "CompleteRegistration", "Contact", "SubmitApplication"] as const;
export type CapiEventName = (typeof CAPI_EVENT_NAMES)[number];
export const ACTION_SOURCES = ["system_generated", "website", "email", "app", "phone_call", "chat", "physical_store", "business_messaging", "other"] as const;

/** Meta rejects events older than 7 days (research doc). */
export const MAX_EVENT_AGE_MS = 7 * 24 * 3_600_000;
const HEX64 = /^[0-9a-f]{64}$/;
const hashes = z.array(z.string().regex(HEX64)).min(1).max(10);

export const CapiUserData = z.strictObject({
  em: hashes.optional(), ph: hashes.optional(), fn: hashes.optional(), ln: hashes.optional(), ct: hashes.optional(), st: hashes.optional(),
  zp: hashes.optional(), country: hashes.optional(), external_id: hashes.optional(),
  fbp: z.string().regex(/^fb\.\d\.\d{10,13}\.\d+$/).optional(), fbc: z.string().regex(/^fb\.\d\.\d{10,13}\.\S+$/).optional(),
});

/** The stored and sent shape. user_data holds ONLY hashes (and fbp/fbc); raw PII has no field here and strictObject rejects extras. */
export const CapiEvent = z.strictObject({
  event_name: z.enum(CAPI_EVENT_NAMES),
  /** Unix seconds of the business event, never the retry time. */
  event_time: z.number().int().positive(),
  event_id: z.string().min(8).max(128),
  action_source: z.enum(ACTION_SOURCES),
  user_data: CapiUserData,
  custom_data: z.strictObject({ value: z.number().nonnegative().finite().optional(), currency: z.string().regex(/^[A-Z]{3}$/).optional() })
    .refine((d) => (d.value === undefined) === (d.currency === undefined), "value and currency go together").optional(),
}).superRefine((e, ctx) => {
  if (e.event_name === "Purchase" && (e.custom_data?.value === undefined || e.custom_data.currency === undefined)) ctx.addIssue({ code: "custom", message: "Purchase needs custom_data.value and currency" });
});
export type CapiEvent = z.infer<typeof CapiEvent>;

/** Deterministic: the same CRM event on the same dataset and event name always yields the same id, so retries, replays and a Pixel that shares the id dedupe. */
export const eventId = (i: { workspaceId: string; datasetId: string; crmEventRef: string; eventName: string }) =>
  sha256([i.workspaceId, i.datasetId, i.crmEventRef, i.eventName].join("|")).slice(0, 40);

export type Staleness = "ok" | "too_old" | "in_future";
export function staleness(eventTimeSec: number, nowMs: number): Staleness {
  const t = eventTimeSec * 1000;
  if (nowMs - t > MAX_EVENT_AGE_MS) return "too_old";
  if (t - nowMs > 5 * 60_000) return "in_future";
  return "ok";
}

/** Delay after failed attempt number `attempts`: 2, 4, 8 ... minutes, capped at 6 hours. */
export const backoffMs = (attempts: number) => Math.min(2 ** Math.max(1, attempts) * 60_000, 6 * 3_600_000);
export const MAX_ATTEMPTS = 6;
