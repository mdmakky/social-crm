import type { ContactLead, ContactSummary, PipelineDto, StageDto } from "@crm/contracts";

/** One contact = one lead in the UI (D260). A contact without a lead sits in the first stage of the default pipeline; nothing is stored until someone changes it. */
export type ShownStage = { id: string; name: string; kind: StageDto["kind"]; position: number; virtual: boolean };

const KIND_ORDER = { open: 0, won: 1, lost: 2 } as const;
export const activePipelines = (pipelines: PipelineDto[]) => pipelines.filter((p) => !p.archived);
export const defaultPipeline = (pipelines: PipelineDto[]) => { const a = activePipelines(pipelines); return a.find((p) => p.isDefault) ?? a[0]; };
/** Open stages first, then won, then lost; archived stages are not offered. */
export const orderedStages = (p: PipelineDto | undefined): StageDto[] => (p?.stages.filter((s) => !s.archived) ?? []).slice().sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || a.position - b.position);
export const firstStageOf = (pipelines: PipelineDto[]): StageDto | undefined => orderedStages(defaultPipeline(pipelines)).find((s) => s.kind === "open");
const pipelineOfStage = (pipelines: PipelineDto[], stageId: string) => pipelines.find((p) => p.stages.some((s) => s.id === stageId));

/** The stage to show for a lead, or the virtual first stage when there is none. */
export function shownStage(pipelines: PipelineDto[], lead: ContactLead | null): ShownStage | null {
  if (lead) {
    const s = pipelineOfStage(pipelines, lead.stageId)?.stages.find((x) => x.id === lead.stageId);
    return { id: lead.stageId, name: lead.stageName, kind: lead.stageKind, position: s?.position ?? 0, virtual: false };
  }
  const f = firstStageOf(pipelines);
  return f ? { id: f.id, name: f.name, kind: f.kind, position: f.position, virtual: true } : null;
}
/** Stages a contact can move to: its lead's pipeline, else the default pipeline. */
export const stagesForContact = (pipelines: PipelineDto[], c: Pick<ContactSummary, "lead">): StageDto[] => orderedStages((c.lead ? pipelineOfStage(pipelines, c.lead.stageId) : undefined) ?? defaultPipeline(pipelines));
export const stageHue = (s: Pick<ShownStage, "kind" | "position">): 1 | 2 | 3 | 4 | 5 | 6 | "muted" => (s.kind === "won" ? 2 : s.kind === "lost" ? "muted" : (((s.position % 6) + 6) % 6) + 1 as 1 | 2 | 3 | 4 | 5 | 6);

/** Why a bulk move did not go through, in plain words (same codes as the lead bulk move). */
export const CODE_TEXT: Record<string, string> = { not_found: "no longer exist", forbidden: "you may not move", lost_reason_required: "need a lost reason", version_conflict: "changed meanwhile", contact_deleted: "were deleted", pipeline_archived: "are in an archived pipeline", invalid_body: "cannot go to that stage", rate_limited: "were skipped (too many changes, wait a minute)", no_pipeline: "have no pipeline to join" };

/** Map an old /leads URL to the Contacts list: only the filters that exist there survive. */
export function leadsQueryToContacts(sp: Record<string, string | string[] | undefined>): string {
  const one = (k: string) => (typeof sp[k] === "string" ? (sp[k] as string) : "");
  const out = new URLSearchParams();
  const map: [string, string][] = [["stage", "stageId"], ["q", "search"], ["owner", "ownerId"], ["source", "source"]];
  for (const [from, to] of map) if (one(from)) out.set(to, one(from));
  return out.toString();
}
