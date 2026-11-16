import { z } from "zod";
import { endpoint } from "./endpoint.ts";

const W = "/v1/workspaces/:workspaceId";
const Uuid = z.string().uuid();

export const PipelineKind = z.enum(["lead", "sales"]);
export const StageKind = z.enum(["open", "won", "lost"]);
export const Currency = z.string().regex(/^[A-Z]{3}$/, "Use a 3-letter uppercase currency code");

export const StageDto = z.object({ id: Uuid, pipelineId: Uuid, name: z.string(), kind: StageKind, defaultProbability: z.number().int(), position: z.number().int(), archived: z.boolean() });
export type StageDto = z.infer<typeof StageDto>;
export const PipelineDto = z.object({
  id: Uuid, name: z.string(), kind: PipelineKind, defaultCurrency: z.string(), isDefault: z.boolean(), position: z.number().int(), version: z.number().int(), archived: z.boolean(),
  stages: z.array(StageDto),
});
export type PipelineDto = z.infer<typeof PipelineDto>;
export const LostReasonDto = z.object({ id: Uuid, name: z.string(), position: z.number().int(), archived: z.boolean() });
export type LostReasonDto = z.infer<typeof LostReasonDto>;

export const PipelineList = z.object({ pipelines: z.array(PipelineDto), lostReasons: z.array(LostReasonDto) });
export type PipelineList = z.infer<typeof PipelineList>;
export const CreatePipelineBody = z.object({ name: z.string().trim().min(1).max(80), kind: PipelineKind, defaultCurrency: Currency.optional(), isDefault: z.boolean().optional() });
export const UpdatePipelineBody = z.object({ name: z.string().trim().min(1).max(80).optional(), defaultCurrency: Currency.optional(), isDefault: z.literal(true).optional(), expectedVersion: z.number().int() }).refine((b) => b.name !== undefined || b.defaultCurrency !== undefined || b.isDefault !== undefined, "Nothing to update");
export const ArchivePipelineBody = z.object({ expectedVersion: z.number().int() });
export const CreatePipelineStageBody = z.object({ name: z.string().trim().min(1).max(60), defaultProbability: z.number().int().min(1).max(99) });
export const UpdatePipelineStageBody = z.object({ name: z.string().trim().min(1).max(60).optional(), defaultProbability: z.number().int().min(1).max(99).optional() }).refine((b) => b.name !== undefined || b.defaultProbability !== undefined, "Nothing to update");
export const ArchivePipelineStageBody = z.object({ moveToStageId: Uuid });
/** Open stages in the desired order; the won and lost stages always stay last. */
export const ReorderPipelineStagesBody = z.object({ stageIds: z.array(Uuid).min(1).max(50) });
export const CreateLostReasonBody = z.object({ name: z.string().trim().min(1).max(80) });
export const UpdateLostReasonBody = z.object({ name: z.string().trim().min(1).max(80).optional(), archived: z.boolean().optional() }).refine((b) => b.name !== undefined || b.archived !== undefined, "Nothing to update");

export const leadsEndpoints = {
  listPipelines: endpoint({ method: "GET", path: `${W}/pipelines`, response: PipelineList }),
  createPipeline: endpoint({ method: "POST", path: `${W}/pipelines`, body: CreatePipelineBody, response: PipelineDto }),
  updatePipeline: endpoint({ method: "PATCH", path: `${W}/pipelines/:pipelineId`, body: UpdatePipelineBody, response: PipelineDto }),
  archivePipeline: endpoint({ method: "POST", path: `${W}/pipelines/:pipelineId/archive`, body: ArchivePipelineBody, response: PipelineDto }),
  createPipelineStage: endpoint({ method: "POST", path: `${W}/pipelines/:pipelineId/stages`, body: CreatePipelineStageBody, response: StageDto }),
  reorderPipelineStages: endpoint({ method: "PUT", path: `${W}/pipelines/:pipelineId/stage-order`, body: ReorderPipelineStagesBody, response: PipelineDto }),
  updatePipelineStage: endpoint({ method: "PATCH", path: `${W}/stages/:stageId`, body: UpdatePipelineStageBody, response: StageDto }),
  archivePipelineStage: endpoint({ method: "POST", path: `${W}/stages/:stageId/archive`, body: ArchivePipelineStageBody, response: StageDto }),
  createLostReason: endpoint({ method: "POST", path: `${W}/lost-reasons`, body: CreateLostReasonBody, response: LostReasonDto }),
  updateLostReason: endpoint({ method: "PATCH", path: `${W}/lost-reasons/:lostReasonId`, body: UpdateLostReasonBody, response: LostReasonDto }),
} as const;

// ---------------------------------------------------------------- leads
const Person = z.object({ id: z.string(), name: z.string() });
const IsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD");
export const LeadPriority = z.enum(["low", "normal", "high"]);
const Money = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

export const LeadDto = z.object({
  id: Uuid, title: z.string(), description: z.string().nullable(),
  primaryContact: z.object({ id: Uuid, name: z.string(), deleted: z.boolean() }),
  pipelineId: Uuid, stageId: Uuid, outcome: StageKind, rank: z.string(),
  /** Null when the caller may not see deal value (valueHidden = true) or when none is set. */
  valueMinor: z.number().int().nullable(), currency: z.string().nullable(), valueHidden: z.boolean(), canEditValue: z.boolean(),
  expectedCloseDate: z.string().nullable(), probability: z.number().int(), probabilityManual: z.boolean(),
  closedAt: z.string().nullable(), lostReasonId: Uuid.nullable(), nextActivityAt: z.string().nullable(),
  priority: LeadPriority, source: z.string(), owner: Person.nullable(),
  version: z.number().int(), createdAt: z.string(), updatedAt: z.string(), deletedAt: z.string().nullable(),
});
export type LeadDto = z.infer<typeof LeadDto>;

export const LeadSort = z.enum(["updated", "created", "close"]);
export const LeadListQuery = z.object({
  pipelineId: Uuid.optional(), stageId: Uuid.optional(), outcome: StageKind.optional(), ownerId: z.string().optional(), contactId: Uuid.optional(),
  q: z.string().max(120).optional(), deleted: z.enum(["true"]).optional(),
  source: z.string().trim().min(1).max(40).optional(),
  /** Value range in minor units. Only for callers who may see deal values (otherwise 403), so a hidden value cannot be probed. */
  minValue: z.coerce.number().int().min(0).optional(), maxValue: z.coerce.number().int().min(0).optional(),
  /** Leads updated within the last N days. */
  activeWithinDays: z.enum(["7", "30", "90"]).optional(),
  sort: LeadSort.optional(), dir: z.enum(["asc", "desc"]).optional(),
  cursor: z.string().max(400).optional(), limit: z.coerce.number().int().min(1).max(100).optional(),
});
export type LeadListQuery = z.input<typeof LeadListQuery>;
/** Same filters as the list, minus paging, sort and stage. */
export const LeadStageCountsQuery = LeadListQuery.omit({ stageId: true, cursor: true, limit: true, sort: true, dir: true, deleted: true });
export type LeadStageCountsQuery = z.input<typeof LeadStageCountsQuery>;
export const LeadStageCounts = z.object({ items: z.array(z.object({ stageId: Uuid, count: z.number().int() })), total: z.number().int() });
export type LeadStageCounts = z.infer<typeof LeadStageCounts>;
export const LeadPage = z.object({ items: z.array(LeadDto), nextCursor: z.string().nullable() });
export type LeadPage = z.infer<typeof LeadPage>;

export const CreateLeadBody = z.object({
  title: z.string().trim().min(1).max(160), description: z.string().max(5000).nullable().optional(),
  primaryContactId: Uuid, pipelineId: Uuid.optional(), stageId: Uuid.optional(),
  valueMinor: Money.nullable().optional(), currency: Currency.nullable().optional(),
  expectedCloseDate: IsoDate.nullable().optional(), probability: z.number().int().min(1).max(99).optional(),
  priority: LeadPriority.optional(), source: z.string().trim().min(1).max(40).optional(), ownerUserId: z.string().nullable().optional(),
  allowDuplicate: z.boolean().optional(),
}).refine((b) => (b.valueMinor == null) === (b.currency == null), "Value and currency go together");
export type CreateLeadBody = z.input<typeof CreateLeadBody>;
export const UpdateLeadBody = z.object({
  expectedVersion: z.number().int(),
  title: z.string().trim().min(1).max(160).optional(), description: z.string().max(5000).nullable().optional(), primaryContactId: Uuid.optional(),
  valueMinor: Money.nullable().optional(), currency: Currency.nullable().optional(),
  expectedCloseDate: IsoDate.nullable().optional(), probability: z.number().int().min(1).max(99).optional(), resetProbability: z.literal(true).optional(),
  priority: LeadPriority.optional(), ownerUserId: z.string().nullable().optional(),
}).refine((b) => Object.keys(b).some((k) => k !== "expectedVersion"), "Nothing to update");
export type UpdateLeadBody = z.input<typeof UpdateLeadBody>;
export const MoveLeadBody = z.object({ expectedVersion: z.number().int(), stageId: Uuid, lostReasonId: Uuid.optional(), beforeLeadId: Uuid.optional(), afterLeadId: Uuid.optional() });
export type MoveLeadBody = z.input<typeof MoveLeadBody>;
export const BulkStageBody = z.object({ leadIds: z.array(Uuid).min(1).max(100), stageId: Uuid, lostReasonId: Uuid.optional() });
export type BulkStageBody = z.input<typeof BulkStageBody>;
/** One entry per requested id, in order. code is "ok" on success, otherwise the error code of the single move (not_found, forbidden, invalid_body, lost_reason_required, ...). */
export const BulkStageResult = z.object({ results: z.array(z.object({ id: Uuid, ok: z.boolean(), code: z.string() })) });
export type BulkStageResult = z.infer<typeof BulkStageResult>;
export const LeadVersionBody = z.object({ expectedVersion: z.number().int() });
export const LeadVersionQuery = z.object({ expectedVersion: z.coerce.number().int() });

export const LeadTransition = z.object({ id: Uuid, fromStageId: Uuid.nullable(), toStageId: Uuid, fromOutcome: StageKind.nullable(), toOutcome: StageKind, actor: Person.nullable(), lostReasonId: Uuid.nullable(), occurredAt: z.string() });
export const LeadTransitionList = z.object({ items: z.array(LeadTransition) });
export const LeadActivity = z.object({ id: Uuid, kind: z.string(), actor: Person.nullable(), data: z.record(z.string(), z.unknown()), occurredAt: z.string() });
export const LeadActivityList = z.object({ items: z.array(LeadActivity) });
export const LeadValueGrant = z.object({ userId: z.string(), name: z.string(), canEdit: z.boolean() });
export const LeadValueGrantList = z.object({ items: z.array(LeadValueGrant) });
export const SetValueGrantBody = z.object({ canEdit: z.boolean() });
export const DuplicateLeadDetails = z.object({ duplicates: z.array(z.object({ id: Uuid, title: z.string() })) });

export const leadRecordEndpoints = {
  listLeads: endpoint({ method: "GET", path: `${W}/leads`, query: LeadListQuery, response: LeadPage }),
  createLead: endpoint({ method: "POST", path: `${W}/leads`, body: CreateLeadBody, response: LeadDto }),
  leadStageCounts: endpoint({ method: "GET", path: `${W}/leads/stage-counts`, query: LeadStageCountsQuery, response: LeadStageCounts }),
  bulkMoveLeads: endpoint({ method: "POST", path: `${W}/leads/bulk-stage`, body: BulkStageBody, response: BulkStageResult }),
  getLead: endpoint({ method: "GET", path: `${W}/leads/:leadId`, response: LeadDto }),
  updateLead: endpoint({ method: "PATCH", path: `${W}/leads/:leadId`, body: UpdateLeadBody, response: LeadDto }),
  moveLead: endpoint({ method: "POST", path: `${W}/leads/:leadId/move`, body: MoveLeadBody, response: LeadDto }),
  deleteLead: endpoint({ method: "DELETE", path: `${W}/leads/:leadId`, query: LeadVersionQuery, response: LeadDto }),
  restoreLead: endpoint({ method: "POST", path: `${W}/leads/:leadId/restore`, body: LeadVersionBody, response: LeadDto }),
  listLeadTransitions: endpoint({ method: "GET", path: `${W}/leads/:leadId/transitions`, response: LeadTransitionList }),
  listLeadActivities: endpoint({ method: "GET", path: `${W}/leads/:leadId/activities`, response: LeadActivityList }),
  listLeadValueGrants: endpoint({ method: "GET", path: `${W}/leads/:leadId/value-grants`, response: LeadValueGrantList }),
  setLeadValueGrant: endpoint({ method: "PUT", path: `${W}/leads/:leadId/value-grants/:userId`, body: SetValueGrantBody, response: LeadValueGrant }),
  removeLeadValueGrant: endpoint({ method: "DELETE", path: `${W}/leads/:leadId/value-grants/:userId`, response: LeadValueGrantList }),
} as const;
