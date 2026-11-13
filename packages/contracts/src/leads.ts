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
