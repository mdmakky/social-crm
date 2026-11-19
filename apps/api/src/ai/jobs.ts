import { AI_JOBS, type AiJobKey, type AiJobModelDto } from "@crm/contracts";
import { pickModel, priceOf, providerDef, type Capability, type ModelInfo, type PriceOverrides } from "@crm/ai";

/** A workspace's enabled provider config, reduced to what job resolution needs. */
export type JobCfg = { provider: string; defaultModel: string | null; prices: PriceOverrides; isDefault?: boolean };

/** Which job a run belongs to, from the capability string the call already carries. Unknown capabilities have no job (no pin applies). */
export const JOB_OF_CAPABILITY: Record<string, AiJobKey> = { reply_suggestion: "reply", agent: "agent", vision: "vision", ocr: "document", transcription: "transcription" };

/**
 * Media rule (used by runAi and the job list, one copy): the first config (callers pass the default first) with a model that has a wanted capability.
 * A pinned model must itself qualify.
 */
export function pickMediaCfg<C extends JobCfg>(cfgs: C[], needs: readonly Capability[], pinnedModel?: string | null): { cfg: C; model: ModelInfo; via: Capability } | null {
  for (const c of cfgs) {
    if (!providerDef(c.provider)) continue;
    const hit = pickModel(c.provider, pinnedModel ?? c.defaultModel, needs, c.prices);
    if (hit && (!pinnedModel || hit.model.id === pinnedModel)) return { cfg: c, ...hit };
  }
  return null;
}

/** A plain sentence when this provider+model cannot do the work, else null. `cfg` is the ENABLED config of the pinned provider (undefined = not set up or turned off). */
export function pinProblem(cfg: JobCfg | undefined, provider: string, model: string, needs: readonly Capability[]): string | null {
  const label = providerDef(provider)?.label ?? provider;
  if (!cfg || !providerDef(provider)) return `${label} is not set up or is turned off, so the pinned model is not used.`;
  const m = priceOf(provider, model, cfg.prices);
  if (!m) return `${model} is no longer enabled for ${label}, so the pinned model is not used.`;
  if (!needs.some((n) => m.capabilities.includes(n))) return `${model} cannot do this job any more, so the pinned model is not used.`;
  return null;
}

/** What a call for this job would use with no pin. `cfgs` are the workspace's enabled configs, default first. */
export function automaticFor(cfgs: JobCfg[], job: AiJobKey): { provider: string; model: string } | null {
  const needs = [AI_JOBS[job].needs] as Capability[];
  if (needs[0] === "text") {
    const d = cfgs.find((c) => c.isDefault);
    return d?.defaultModel && providerDef(d.provider) && priceOf(d.provider, d.defaultModel, d.prices) ? { provider: d.provider, model: d.defaultModel } : null;
  }
  const hit = pickMediaCfg(cfgs, needs);
  return hit ? { provider: hit.cfg.provider, model: hit.model.id } : null;
}

export function resolveJob(cfgs: JobCfg[], job: AiJobKey, pin: { provider: string; model: string } | null): AiJobModelDto {
  const auto = () => { const a = automaticFor(cfgs, job); return a ? { ...a, automatic: true } : null; };
  if (!pin) return { job, pinned: null, effective: auto(), problem: null };
  const problem = pinProblem(cfgs.find((c) => c.provider === pin.provider), pin.provider, pin.model, [AI_JOBS[job].needs] as Capability[]);
  return { job, pinned: { provider: pin.provider, model: pin.model }, effective: problem ? auto() : { ...pin, automatic: false }, problem };
}
