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

export const CapiEventStatus = z.enum(["pending", "sent", "failed", "skipped_no_consent"]);
/** Delivery history row. No identifiers, no payload: only what is needed to see status and the failure code. */
export const CapiEventDto = z.object({
  id: Uuid, datasetId: Uuid, eventName: CapiEventName, eventId: z.string(), eventTime: z.string(), status: CapiEventStatus, attempts: z.number().int(),
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

export const capiEndpoints = {
  listCapiDatasets: endpoint({ method: "GET", path: `${W}/capi/datasets`, response: CapiDatasetList }),
  createCapiDataset: endpoint({ method: "POST", path: `${W}/capi/datasets`, body: CreateCapiDatasetBody, response: CapiDatasetDto }),
  disableCapiDataset: endpoint({ method: "POST", path: `${W}/capi/datasets/:datasetId/disable`, response: CapiDatasetDto }),
  listCapiEvents: endpoint({ method: "GET", path: `${W}/capi/events`, query: CapiEventsQuery, response: CapiEventList }),
  getAdConsent: endpoint({ method: "GET", path: `${W}/contacts/:contactId/ad-consent`, response: AdConsentDto }),
  setAdConsent: endpoint({ method: "POST", path: `${W}/contacts/:contactId/ad-consent`, body: SetAdConsentBody, response: AdConsentDto }),
} as const;
