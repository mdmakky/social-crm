import { z } from "zod";
import { endpoint } from "./endpoint.ts";

const W = "/v1/workspaces/:workspaceId";
const Uuid = z.string().uuid();

/** Mirrors @crm/capi CAPI_EVENT_NAMES (contracts has no dependency on that package; a test keeps them equal). */
export const CAPI_EVENT_NAMES = ["Lead", "Purchase", "Schedule", "CompleteRegistration", "Contact", "SubmitApplication"] as const;
export const CapiEventName = z.enum(CAPI_EVENT_NAMES);

/** `mock`: nothing is sent to Meta. `live` is not creatable until a real test event is recorded (docs/architecture/capi-architecture.md section 10). */
export const CapiDatasetDto = z.object({
  id: Uuid, datasetId: z.string(), name: z.string(), mode: z.enum(["mock", "live"]), status: z.enum(["active", "disabled", "needs_reauth"]),
  testEventCode: z.string().nullable(), events: z.array(CapiEventName), tokenLast4: z.string(), createdAt: z.string(),
});
export type CapiDatasetDto = z.infer<typeof CapiDatasetDto>;
/** The access token is write-only: sent once here, sealed server-side, never returned. */
export const CreateCapiDatasetBody = z.object({
  datasetId: z.string().regex(/^[1-9][0-9]{0,99}$/, "The dataset ID is digits only."),
  name: z.string().trim().min(1).max(120),
  accessToken: z.string().min(20).max(2000).regex(/^\S+$/, "Paste the whole token, with no spaces."),
  testEventCode: z.string().regex(/^[A-Za-z0-9_-]{1,40}$/).optional(),
  events: z.array(CapiEventName).max(CAPI_EVENT_NAMES.length).default([]),
});
export type CreateCapiDatasetBody = z.infer<typeof CreateCapiDatasetBody>;
export const CapiDatasetList = z.object({ items: z.array(CapiDatasetDto) });

export const CapiEventStatus = z.enum(["pending", "sent", "failed", "skipped_no_consent", "cancelled", "skipped"]);
/** Delivery history row. No identifiers, no payload: only what is needed to see status and the failure code. */
export const CapiEventDto = z.object({
  id: Uuid, datasetId: Uuid, eventName: z.string(), eventId: z.string(), eventTime: z.string(), status: CapiEventStatus, attempts: z.number().int(),
  nextAttemptAt: z.string().nullable(), lastError: z.string().nullable(), fbtraceId: z.string().nullable(), sentAt: z.string().nullable(), createdAt: z.string(),
});
export type CapiEventDto = z.infer<typeof CapiEventDto>;
export const CapiEventsQuery = z.object({ datasetId: Uuid.optional(), status: CapiEventStatus.optional(), limit: z.coerce.number().int().min(1).max(100).optional(), cursor: Uuid.optional() });
export const CapiEventList = z.object({ items: z.array(CapiEventDto), nextCursor: Uuid.nullable() });
export type CapiEventList = z.infer<typeof CapiEventList>;

export const AdConsentEntry = z.object({ status: z.enum(["granted", "revoked"]), source: z.string(), recordedAt: z.string(), recordedBy: z.string().nullable() });
/** Current state plus the append-only history (newest first, last 20). `recordedBy` is a user id the client resolves against members. */
export const AdConsentDto = z.object({ status: z.enum(["granted", "revoked", "none"]), source: z.string().nullable(), recordedAt: z.string().nullable(), recordedBy: z.string().nullable(), history: z.array(AdConsentEntry) });
export type AdConsentDto = z.infer<typeof AdConsentDto>;
export const SetAdConsentBody = z.object({ status: z.enum(["granted", "revoked"]), source: z.enum(["manual", "form", "import", "api", "customer_request"]) });

/** Standard names Meta documents (mirrors @crm/capi META_STANDARD_EVENTS; a test keeps them equal). A mapping may also use a custom name of CAPI_CUSTOM_EVENT_NAME shape. */
export const META_STANDARD_EVENTS = ["Lead", "Purchase", "Schedule", "CompleteRegistration", "Contact", "SubmitApplication", "StartTrial", "Subscribe", "InitiateCheckout", "AddPaymentInfo", "Donate", "FindLocation", "CustomizeProduct", "Search", "ViewContent", "AddToCart", "AddToWishlist"] as const;
export const CAPI_CUSTOM_EVENT_NAME = /^[A-Za-z][A-Za-z0-9_]{0,39}$/;
export const MAX_CAPI_MAPPINGS_PER_DATASET = 50;
export const CapiTriggerType = z.enum(["lead_created", "lead_stage_entered", "lead_won", "lead_lost"]);
export const CapiValueMode = z.enum(["lead_value", "fixed", "none"]);
/** One rule: when `triggerType` happens (for `lead_stage_entered`, on `stageId`) send `eventName` to the dataset, with the value picked by `valueMode`. */
export const CapiMappingDto = z.object({
  id: Uuid, datasetId: Uuid, triggerType: CapiTriggerType, stageId: Uuid.nullable(), eventName: z.string(), valueMode: CapiValueMode,
  fixedValueMinor: z.number().int().nullable(), currency: z.string().nullable(), enabled: z.boolean(), askForValue: z.boolean(), createdAt: z.string(), updatedAt: z.string(),
});
export type CapiMappingDto = z.infer<typeof CapiMappingDto>;
export const CapiMappingList = z.object({ items: z.array(CapiMappingDto) });
const MappingFields = z.object({
  triggerType: CapiTriggerType,
  stageId: Uuid.nullable().default(null),
  eventName: z.string().regex(CAPI_CUSTOM_EVENT_NAME, "Start with a letter; letters, digits and underscores only, up to 40 characters.").refine((n) => n !== "PageView", "PageView is sent by your website Pixel, not the CRM."),
  valueMode: CapiValueMode.default("lead_value"),
  fixedValueMinor: z.number().int().min(0).max(9_000_000_000_000).nullable().default(null),
  currency: z.string().regex(/^[A-Z]{3}$/, "Use a three-letter currency code, for example USD.").nullable().default(null),
  enabled: z.boolean().default(true),
  /** With `valueMode: "lead_value"`: when a stage change fires this rule and the lead has no value, the app asks for it before moving. false = skip and record (no_value), as before. */
  askForValue: z.boolean().default(false),
});
/** Cross-field rules shared by create and update; the database repeats them as CHECK constraints. */
const mappingRules = (b: z.infer<typeof MappingFields>, ctx: z.RefinementCtx) => {
  if ((b.triggerType === "lead_stage_entered") !== (b.stageId !== null)) ctx.addIssue({ code: "custom", path: ["stageId"], message: b.triggerType === "lead_stage_entered" ? "Choose the stage." : "Only \"enters a stage\" uses a stage." });
  if (b.valueMode === "fixed" && (b.fixedValueMinor === null || b.currency === null)) ctx.addIssue({ code: "custom", path: ["fixedValueMinor"], message: "Enter an amount and a currency." });
  if (b.valueMode !== "fixed" && (b.fixedValueMinor !== null || b.currency !== null)) ctx.addIssue({ code: "custom", path: ["valueMode"], message: "An amount is only used with a fixed value." });
  if (b.askForValue && b.valueMode !== "lead_value") ctx.addIssue({ code: "custom", path: ["askForValue"], message: "Asking for a value only works when the value comes from the lead." });
  if (b.eventName === "Purchase" && b.valueMode === "none") ctx.addIssue({ code: "custom", path: ["valueMode"], message: "A Purchase needs a value." });
};
/** Create and update take the same fields; update replaces the whole rule. */
export const CreateCapiMappingBody = MappingFields.superRefine(mappingRules);
export type CreateCapiMappingBody = z.infer<typeof CreateCapiMappingBody>;
export const UpdateCapiMappingBody = CreateCapiMappingBody;
/** What WOULD happen if this lead met each rule's trigger. Nothing is queued. `reason` explains why a rule would not send. */
export const CapiMappingPreviewBody = z.object({ leadId: Uuid });
export const CapiPreviewItem = z.object({
  mappingId: Uuid, datasetId: Uuid, datasetName: z.string(), triggerType: CapiTriggerType, stageId: Uuid.nullable(), eventName: z.string(),
  result: z.enum(["send", "skip"]), reason: z.enum(["mapping_disabled", "dataset_inactive", "no_value", "no_consent", "opted_out"]).nullable(),
  value: z.number().nullable(), currency: z.string().nullable(), askForValue: z.boolean(),
});
export const CapiMappingPreview = z.object({ items: z.array(CapiPreviewItem), consent: z.enum(["granted", "revoked", "none"]) });
export type CapiMappingPreview = z.infer<typeof CapiMappingPreview>;

/**
 * Before a stage change: what would fire, and does the app need to ask for a deal value first. `contactId` because the web works by contact (a contact without a lead gets one on its first move).
 * `value` is null when the caller may not see the lead's value (never leaked); `needsValue` is true when some enabled rule of an active dataset has `askForValue` and the lead has no value.
 */
export const StageCheckQuery = z.object({ stageId: Uuid });
export const StageCheckFire = z.object({ mappingId: Uuid, datasetName: z.string(), datasetMode: z.enum(["mock", "live"]), eventName: z.string(), trigger: CapiTriggerType, ask: z.boolean() });
export const StageCheck = z.object({
  stageId: Uuid, stageName: z.string(), stageKind: z.enum(["open", "won", "lost"]),
  fires: z.array(StageCheckFire), needsValue: z.boolean(), canSetValue: z.boolean(),
  value: z.object({ valueMinor: z.number().int(), currency: z.string() }).nullable(), valueHidden: z.boolean(),
  currency: z.string(), consent: z.enum(["granted", "revoked", "none"]),
});
export type StageCheck = z.infer<typeof StageCheck>;

export const capiEndpoints = {
  checkStageChange: endpoint({ method: "GET", path: `${W}/contacts/:contactId/stage-check`, query: StageCheckQuery, response: StageCheck }),
  listCapiDatasets: endpoint({ method: "GET", path: `${W}/capi/datasets`, response: CapiDatasetList }),
  createCapiDataset: endpoint({ method: "POST", path: `${W}/capi/datasets`, body: CreateCapiDatasetBody, response: CapiDatasetDto }),
  disableCapiDataset: endpoint({ method: "POST", path: `${W}/capi/datasets/:datasetId/disable`, response: CapiDatasetDto }),
  listCapiMappings: endpoint({ method: "GET", path: `${W}/capi/datasets/:datasetId/mappings`, response: CapiMappingList }),
  createCapiMapping: endpoint({ method: "POST", path: `${W}/capi/datasets/:datasetId/mappings`, body: CreateCapiMappingBody, response: CapiMappingDto }),
  updateCapiMapping: endpoint({ method: "PUT", path: `${W}/capi/datasets/:datasetId/mappings/:mappingId`, body: UpdateCapiMappingBody, response: CapiMappingDto }),
  deleteCapiMapping: endpoint({ method: "DELETE", path: `${W}/capi/datasets/:datasetId/mappings/:mappingId`, response: z.object({ ok: z.literal(true) }) }),
  previewCapiMappings: endpoint({ method: "POST", path: `${W}/capi/mappings/preview`, body: CapiMappingPreviewBody, response: CapiMappingPreview }),
  listCapiEvents: endpoint({ method: "GET", path: `${W}/capi/events`, query: CapiEventsQuery, response: CapiEventList }),
  getAdConsent: endpoint({ method: "GET", path: `${W}/contacts/:contactId/ad-consent`, response: AdConsentDto }),
  setAdConsent: endpoint({ method: "POST", path: `${W}/contacts/:contactId/ad-consent`, body: SetAdConsentBody, response: AdConsentDto }),
} as const;
