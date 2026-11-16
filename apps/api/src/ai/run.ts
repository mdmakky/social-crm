import { sql } from "drizzle-orm";
import { AiError, costMicro, estimateAudioSeconds, estimateMediaTokens, fingerprint, fingerprintBytes, getProvider, invokeMedia, perMinuteCostMicro, pickModel, priceOf, promptDef, providerDef, renderTemplate, safeError, TemplateError, type AiProvider, type Capability, type MediaInput, type ModelInfo, type PriceOverrides } from "@crm/ai";
import { schema, withContext, type Db, type Tx } from "@crm/db";
import type { SecretBox } from "@crm/integrations";

export type AiDeps = {
  /** crm_worker connection: reads the sealed key and appends runs. The app role can do neither. */
  workerDb: Db;
  box: SecretBox;
  /** Tests inject a fake provider. Production resolves from the registry. */
  providerFor?: (id: string, o: { baseUrl?: string; timeoutMs: number; referer?: string; title?: string }) => AiProvider;
  /** Optional OpenRouter attribution headers (OPENROUTER_REFERER, OPENROUTER_TITLE). Passed to the adapter, never required. */
  referer?: string;
  title?: string;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  timeoutMs?: number;
  /** Extra tries after the first, for rate_limit and timeout, and for errors the adapter marks retryable (OpenRouter 502/503). */
  maxRetries?: number;
  backoffMs?: number;
};

export type RunInput = {
  workspaceId: string;
  userId: string;
  capability: string;
  promptKey: string;
  vars: Record<string, string>;
  /** The data the model works on (for example the conversation). It is sent, never stored. */
  input: string;
  entity?: { type: string; id: string };
  maxOutputTokens?: number;
  /** Agent runs: the already composed system text (skips the prompt template), sampling temperature, an optional provider/model override and the agent that made the call. */
  system?: string;
  temperature?: number;
  provider?: string | null;
  model?: string | null;
  agent?: { id: string; version: number };
  /**
   * Media calls (vision, OCR, transcription): the SAME path as text, so the budget hard stop, retries and run log apply unchanged. `needs` lists acceptable capabilities in order of preference;
   * the workspace's default provider is tried first, then its other enabled ones. Bytes are sent and dropped: the run row keeps only mime, size and a hash.
   */
  media?: { needs: Capability[]; prompt: string; input: MediaInput; language?: string };
};
export type RunFailure = "not_configured" | "budget_exceeded" | "rate_limit" | "timeout" | "auth" | "invalid_request" | "provider_error" | "template_invalid" | "key_unavailable" | "capability_not_configured" | "unsupported_capability" | "payment_required" | "blocked";
export type RunResult =
  | { ok: true; text: string; runId: string; provider: string; model: string; mock: boolean; usage: { inputTokens: number; outputTokens: number; costMicro: number } }
  | { ok: false; code: RunFailure; runId?: string };

const rowsOf = (r: unknown) => (r as { rows: Record<string, unknown>[] }).rows;
const monthStart = (ms: number) => { const d = new Date(ms); return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)); };
const RETRYABLE = new Set(["rate_limit", "timeout"]);
const MAX_WAIT_MS = 30_000;

type Prepared =
  | { kind: "stop"; result: RunResult }
  | { kind: "go"; provider: string; model: string; baseUrl: string | null; price: ModelInfo; via: Capability; promptVersion: number; template: string; key: string | null; mock: boolean };

type RunRow = { provider: string; model: string; status: "ok" | "error" | "blocked_budget"; promptVersion: number; inputTokens?: number; outputTokens?: number; costMicro?: number; latencyMs?: number; attempts?: number; errorCode?: string; inputHash?: string; summary?: string };

async function record(tx: Tx, r: RunInput, row: RunRow): Promise<string> {
  const [x] = await tx.insert(schema.aiRuns).values({
    workspaceId: r.workspaceId, capability: r.capability, provider: row.provider, model: row.model, promptKey: r.promptKey, promptVersion: row.promptVersion, status: row.status,
    inputTokens: row.inputTokens ?? 0, outputTokens: row.outputTokens ?? 0, costMicro: row.costMicro ?? 0, latencyMs: row.latencyMs ?? 0, attempts: row.attempts ?? 0, errorCode: row.errorCode ?? null,
    requestedBy: r.userId, agentId: r.agent?.id ?? null, agentVersion: r.agent?.version ?? null, entityType: r.entity?.type ?? null, entityId: r.entity?.id ?? null, inputHash: row.inputHash ?? null, summary: row.summary ?? null,
  }).returning({ id: schema.aiRuns.id });
  return x!.id;
}

/**
 * Runs one AI call for a workspace. Order matters:
 *  1. ONE short transaction as crm_worker: config, sealed key, active prompt, budget and month usage. The hard stop is decided here; a blocked call is logged and the provider is NOT contacted.
 *  2. The provider call, with NO transaction open, a timeout, and bounded retry (rate_limit and timeout only, exponential backoff).
 *  3. A second short transaction appends the run (tokens, cost, latency). Prompts, replies and keys are never stored or logged.
 * Soft edge: calls already in flight when the cap is crossed still finish, so spend can overshoot the cap by what is in flight.
 */
export async function runAi(deps: AiDeps, r: RunInput): Promise<RunResult> {
  const now = deps.now ?? Date.now;
  const ctx = { workspaceId: r.workspaceId, userId: r.userId };
  const prep: Prepared = await withContext(deps.workerDb, ctx, async (tx): Promise<Prepared> => {
    const cols = sql`id, provider, base_url, default_model, model_prices`;
    const cfgs = rowsOf(await tx.execute(r.provider
      ? sql`SELECT ${cols} FROM ai_provider_configs WHERE workspace_id = ${r.workspaceId} AND provider = ${r.provider} AND enabled`
      : r.media ? sql`SELECT ${cols} FROM ai_provider_configs WHERE workspace_id = ${r.workspaceId} AND enabled ORDER BY is_default DESC, id`
      : sql`SELECT ${cols} FROM ai_provider_configs WHERE workspace_id = ${r.workspaceId} AND is_default AND enabled`));
    const none: Prepared = { kind: "stop", result: { ok: false, code: r.media ? "capability_not_configured" : "not_configured" } };
    let cfg: Record<string, unknown> | undefined = cfgs[0];
    let model = "";
    let price: ModelInfo | null = null;
    let via: Capability = "text";
    if (r.media) {
      // First config (default first) with a model that has a wanted capability; a pinned r.model must itself qualify.
      cfg = undefined;
      for (const c of cfgs) {
        if (!providerDef(c.provider as string)) continue;
        const hit = pickModel(c.provider as string, r.model ?? (c.default_model as string | null), r.media.needs, c.model_prices as PriceOverrides);
        if (hit && (!r.model || hit.model.id === r.model)) { cfg = c; model = hit.model.id; price = hit.model; via = hit.via; break; }
      }
    } else if (cfg) {
      model = r.model ?? (cfg.default_model as string);
      price = priceOf(cfg.provider as string, model, cfg.model_prices as PriceOverrides);
    }
    const def = cfg ? providerDef(cfg.provider as string) : null;
    if (!cfg || !def || !cfg.default_model || !price) return none;
    const provider = cfg.provider as string;
    const pr = r.system === undefined ? rowsOf(await tx.execute(sql`SELECT version, template FROM ai_prompts WHERE workspace_id = ${r.workspaceId} AND key = ${r.promptKey} AND active`))[0] : undefined;
    const builtin = promptDef(r.promptKey);
    if (r.system === undefined && !pr && !builtin) return { kind: "stop", result: { ok: false, code: "not_configured" } };
    const promptVersion = pr ? Number(pr.version) : 0;
    const template = pr ? (pr.template as string) : builtin?.defaultTemplate ?? "";

    const b = rowsOf(await tx.execute(sql`SELECT monthly_cap_micro, hard_stop FROM ai_budgets WHERE workspace_id = ${r.workspaceId}`))[0];
    if (b && b.hard_stop && b.monthly_cap_micro !== null) {
      const used = rowsOf(await tx.execute(sql`SELECT coalesce(sum(cost_micro), 0)::bigint AS used FROM ai_runs WHERE workspace_id = ${r.workspaceId} AND created_at >= ${monthStart(now()).toISOString()}::timestamptz`))[0]!;
      if (BigInt(used.used as string | number) >= BigInt(b.monthly_cap_micro as string | number)) {
        const runId = await record(tx, r, { provider, model, status: "blocked_budget", promptVersion, errorCode: "budget_exceeded" });
        return { kind: "stop", result: { ok: false, code: "budget_exceeded", runId } };
      }
    }
    let key: string | null = null;
    if (!def.mock) {
      const s = rowsOf(await tx.execute(sql`SELECT ciphertext, nonce, key_id FROM ai_provider_secrets WHERE workspace_id = ${r.workspaceId} AND config_id = ${cfg.id as string} ORDER BY id DESC LIMIT 1`))[0];
      try {
        if (!s) throw new Error("no key");
        key = deps.box.open({ ciphertext: s.ciphertext as Buffer, nonce: s.nonce as Buffer, keyId: s.key_id as string }, cfg.id as string);
      } catch {
        const runId = await record(tx, r, { provider, model, status: "error", promptVersion, errorCode: "key_unavailable" });
        return { kind: "stop", result: { ok: false, code: "key_unavailable", runId } };
      }
    }
    return { kind: "go", provider, model, baseUrl: (cfg.base_url as string | null) ?? null, price, via, promptVersion, template, key, mock: def.mock };
  });
  if (prep.kind === "stop") return prep.result;

  const base = { provider: prep.provider, model: prep.model, promptVersion: prep.promptVersion };
  let system: string;
  try {
    system = r.system ?? renderTemplate(prep.template, r.vars);
  } catch (e) {
    const runId = await withContext(deps.workerDb, ctx, (tx) => record(tx, r, { ...base, status: "error", errorCode: e instanceof TemplateError ? "template_invalid" : "template_error" }));
    return { ok: false, code: "template_invalid", runId };
  }
  // Media runs keep only mime, size and a hash of the bytes: never the bytes, the prompt or the output.
  const m = r.media?.input;
  const inputHash = m ? fingerprintBytes(m.bytes) : fingerprint(system + "\n" + r.input);
  const summary = m ? `media ${m.kind} ${m.mime} ${m.bytes.byteLength} bytes` : `in ${system.length + r.input.length} chars`;
  const timeoutMs = deps.timeoutMs ?? 30_000;
  const adapter = (deps.providerFor ?? ((id, o) => getProvider(id, o)))(prep.provider, { baseUrl: prep.baseUrl ?? undefined, timeoutMs, referer: deps.referer, title: deps.title });

  const t0 = now();
  const maxRetries = deps.maxRetries ?? 2;
  let attempts = 0;
  let outcome: { ok: true; text: string; inputTokens: number; outputTokens: number; cost: number; routedModel?: string } | { ok: false; code: string } | null = null;
  // The budget counts the HIGHER of our estimate (catalog or workspace price) and the provider's own reported cost: a wrong or stale price can never undercount.
  const charge = (estimated: number, reported?: number) => Math.max(estimated, reported ?? 0);
  while (outcome === null) {
    attempts++;
    try {
      if (r.media) {
        const g = await invokeMedia(adapter, prep.via, { apiKey: prep.key ?? "", model: prep.model, media: r.media.input, prompt: r.media.prompt, maxOutputTokens: r.maxOutputTokens ?? 1500, language: r.media.language });
        // Tokens as the provider reported them; a documented estimate only when it reported none. Transcription adds the per-minute price over the reported (else estimated) duration.
        const inputTokens = g.usage.inputTokens || (prep.via === "transcription" ? 0 : estimateMediaTokens(r.media.input.kind, r.media.input.bytes.byteLength));
        const perMin = prep.via === "transcription" && prep.price.transcriptionMicroPerMinute ? perMinuteCostMicro(prep.price.transcriptionMicroPerMinute, g.durationSec ?? estimateAudioSeconds(r.media.input.bytes.byteLength)) : 0;
        outcome = { ok: true, text: g.text, inputTokens, outputTokens: g.usage.outputTokens, cost: charge(costMicro(prep.price, { inputTokens, outputTokens: g.usage.outputTokens }) + perMin, g.usage.reportedCostMicro), ...(g.routedModel ? { routedModel: g.routedModel } : {}) };
      } else {
        const g = await adapter.generate({ apiKey: prep.key ?? "", model: prep.model, maxOutputTokens: r.maxOutputTokens ?? 400, temperature: r.temperature ?? 0.4, messages: [{ role: "system", content: system }, { role: "user", content: r.input }] });
        outcome = { ok: true, text: g.text, inputTokens: g.usage.inputTokens, outputTokens: g.usage.outputTokens, cost: charge(costMicro(prep.price, g.usage), g.usage.reportedCostMicro), ...(g.routedModel ? { routedModel: g.routedModel } : {}) };
      }
    } catch (e) {
      const code = e instanceof AiError ? e.code : "provider_error";
      const retryable = e instanceof AiError && e.retryable !== undefined ? e.retryable : RETRYABLE.has(code);
      // Wait = the larger of our backoff and the provider's Retry-After, never more than 30 s. Retries stay bounded by maxRetries.
      if (retryable && attempts <= maxRetries) { await (deps.sleep ?? ((ms) => new Promise((res) => setTimeout(res, ms))))(Math.min(MAX_WAIT_MS, Math.max((deps.backoffMs ?? 500) * 2 ** (attempts - 1), e instanceof AiError ? e.retryAfterMs ?? 0 : 0))); continue; }
      outcome = { ok: false, code };
    }
  }
  const latencyMs = Math.max(0, now() - t0);

  let runId: string | undefined;
  try {
    runId = await withContext(deps.workerDb, ctx, (tx) => record(tx, r, outcome.ok
      ? { ...base, status: "ok", inputTokens: outcome.inputTokens, outputTokens: outcome.outputTokens, costMicro: outcome.cost, latencyMs, attempts, inputHash, summary: `${summary}, out ${outcome.text.length} chars${outcome.routedModel && outcome.routedModel !== prep.model ? `, routed to ${outcome.routedModel.slice(0, 100)}` : ""}` }
      : { ...base, status: "error", latencyMs, attempts, errorCode: outcome.code, inputHash, summary }));
  } catch (e) {
    console.error(JSON.stringify({ msg: "ai run record failed", error: safeError(e) }));
  }
  if (!outcome.ok) return { ok: false, code: outcome.code as RunFailure, runId };
  return { ok: true, text: outcome.text, runId: runId ?? "", provider: prep.provider, model: prep.model, mock: prep.mock, usage: { inputTokens: outcome.inputTokens, outputTokens: outcome.outputTokens, costMicro: outcome.cost } };
}
