import type { LeadListQuery, LeadStageCountsQuery, PipelineDto } from "@crm/contracts";
import { toMinor } from "./leads";

/** The Leads list state. It lives in the URL (shareable, back button), so every field round-trips through parseFilters/toSearch. */
export type Filters = {
  q: string; pipeline: string; stage: string; status: "open" | "won" | "lost" | "all"; owner: string; source: string; min: string; max: string;
  active: "" | "7" | "30" | "90"; sort: "updated" | "created" | "close"; dir: "asc" | "desc";
};
export type Params = { get(name: string): string | null };

const live = (pipelines: PipelineDto[]) => pipelines.filter((p) => !p.archived);
const stageOwner = (pipelines: PipelineDto[], stageId: string) => pipelines.find((p) => p.stages.some((s) => s.id === stageId));
/** What "no status param" means: a chosen stage already decides the outcome, otherwise the list shows open leads. */
const defaultStatus = (stage: string): Filters["status"] => (stage ? "all" : "open");

export function parseFilters(sp: Params, pipelines: PipelineDto[]): Filters {
  const act = live(pipelines);
  const stage = stageOwner(act, sp.get("stage") ?? "") ? (sp.get("stage") as string) : "";
  const wanted = sp.get("pipeline");
  const pipeline = stage ? stageOwner(act, stage)!.id : act.length < 2 || wanted === "all" ? "" : (act.find((p) => p.id === wanted) ?? act.find((p) => p.isDefault) ?? act[0])?.id ?? "";
  const status = sp.get("status");
  const active = sp.get("active");
  const sort = sp.get("sort");
  return {
    q: (sp.get("q") ?? "").slice(0, 120), pipeline, stage,
    status: status === "open" || status === "won" || status === "lost" || status === "all" ? status : defaultStatus(stage),
    owner: sp.get("owner") ?? "", source: (sp.get("source") ?? "").slice(0, 40),
    min: /^\d+(\.\d+)?$/.test(sp.get("min") ?? "") ? sp.get("min")! : "", max: /^\d+(\.\d+)?$/.test(sp.get("max") ?? "") ? sp.get("max")! : "",
    active: active === "7" || active === "30" || active === "90" ? active : "",
    sort: sort === "created" || sort === "close" ? sort : "updated", dir: sp.get("dir") === "asc" ? "asc" : "desc",
  };
}

/** Only non-default values are written, so a clean list has a clean URL. */
export function toSearch(f: Filters, pipelines: PipelineDto[]): string {
  const act = live(pipelines);
  const sp = new URLSearchParams();
  if (f.q.trim()) sp.set("q", f.q.trim());
  if (f.stage) sp.set("stage", f.stage);
  else if (act.length > 1) {
    const def = act.find((p) => p.isDefault) ?? act[0]!;
    if (f.pipeline === "") sp.set("pipeline", "all"); else if (f.pipeline !== def.id) sp.set("pipeline", f.pipeline);
  }
  if (f.status !== defaultStatus(f.stage)) sp.set("status", f.status);
  if (f.owner) sp.set("owner", f.owner);
  if (f.source.trim()) sp.set("source", f.source.trim());
  if (f.min) sp.set("min", f.min);
  if (f.max) sp.set("max", f.max);
  if (f.active) sp.set("active", f.active);
  if (f.sort !== "updated") sp.set("sort", f.sort);
  if (f.dir !== "desc") sp.set("dir", f.dir);
  return sp.toString();
}

const currencyOf = (f: Filters, pipelines: PipelineDto[]) => (pipelines.find((p) => p.id === f.pipeline) ?? live(pipelines).find((p) => p.isDefault) ?? pipelines[0])?.defaultCurrency ?? "USD";

/** Filters shared by the list and the stage counts (no stage, status, paging or sort). */
const shared = (f: Filters, pipelines: PipelineDto[]): LeadStageCountsQuery => {
  const cur = currencyOf(f, pipelines);
  const min = f.min ? toMinor(f.min, cur) : null;
  const max = f.max ? toMinor(f.max, cur) : null;
  return {
    ...(f.q.trim() ? { q: f.q.trim() } : {}), ...(f.pipeline ? { pipelineId: f.pipeline } : {}), ...(f.owner ? { ownerId: f.owner } : {}),
    ...(f.source.trim() ? { source: f.source.trim() } : {}), ...(min !== null ? { minValue: min } : {}), ...(max !== null ? { maxValue: max } : {}), ...(f.active ? { activeWithinDays: f.active } : {}),
  };
};
export const toCountsQuery = (f: Filters, pipelines: PipelineDto[]): LeadStageCountsQuery => shared(f, pipelines);
export const toListQuery = (f: Filters, pipelines: PipelineDto[], cursor?: string): LeadListQuery => ({
  ...shared(f, pipelines), limit: 50, sort: f.sort, dir: f.dir,
  ...(f.stage ? { stageId: f.stage } : {}), ...(f.status !== "all" ? { outcome: f.status } : {}), ...(cursor ? { cursor } : {}),
});

/** How many leads the current list holds, from the per-stage counts (which ignore stage and status). */
export function listTotal(counts: { stageId: string; count: number }[], f: Filters, pipelines: PipelineDto[]): number {
  const kind = new Map(pipelines.flatMap((p) => p.stages.map((s) => [s.id, s.kind] as const)));
  return counts.filter((c) => (f.stage ? c.stageId === f.stage : f.status === "all" || kind.get(c.stageId) === f.status)).reduce((n, c) => n + c.count, 0);
}
