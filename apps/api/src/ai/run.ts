import { sql } from "drizzle-orm";
import { JOB_OF_CAPABILITY, pickMediaCfg, pinProblem } from "./jobs.ts";
import { AiError, costMicro, estimateAudioSeconds, estimateMediaTokens, fingerprint, fingerprintBytes, getProvider, invokeMedia, perMinuteCostMicro, priceOf, promptDef, providerDef, renderTemplate, safeError, TemplateError, type AiProvider, type Capability, type MediaInput, type ModelInfo, type PriceOverrides, type ResponseFormat, type ToolCall, type ToolSpec } from "@crm/ai";
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
  /** Operator-wide provider keys from the server environment (GEMINI_API_KEY), by provider id. Used only when the workspace stored no key of its own. Never sent to the browser. */
  envKeys?: Record<string, string>;
  /** Operator-chosen default model per provider (GEMINI_TRANSCRIPTION_MODEL): used when a workspace connects with the server key and picks none. */
  envModels?: Record<string, string>;
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
  /**
   * Native tool calling: used ONLY when the chosen model's stored flags say it takes tools (then `system` is replaced by native.system and the tools are sent). Otherwise the caller's `system` (JSON-in-text) is used unchanged.
   * The model is only known after the config is read, so the choice is made here, in the same transaction as the budget check.
   */
  native?: { tools: ToolSpec[]; system: string };
  /** Structured output: sent as response_format json_schema ONLY when the model supports it and native tools are not in use; otherwise the prompt-based JSON stays. */
  responseSchema?: { name: string; schema: Record<string, unknown> };
};
/** How the answer was asked for: `native_tools`, `json_schema` (response_format) or `text` (prompt only). */
export type RunVia = "native_tools" | "json_schema" | "text";
export type RunFailure = "not_configured" | "budget_exceeded" | "rate_limit" | "timeout" | "auth" | "invalid_request" | "provider_error" | "template_invalid" | "key_unavailable" | "capability_not_configured" | "unsupported_capability" | "payment_required" | "blocked";
export type StreamFailure = RunFailure | "client_aborted";
export type RunResult =
  | { ok: true; text: string; runId: string; provider: string; model: string; mock: boolean; usage: { inputTokens: number; outputTokens: number; costMicro: number }; toolCalls?: ToolCall[]; via: RunVia; finishReason?: string }
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

type Go = Extract<Prepared, { kind: "go" }>;
type Begun = { kind: "stop"; result: RunResult } | { kind: "go"; prep: Go; system: string; base: { provider: string; model: string; promptVersion: number }; inputHash: string; summary: string; adapter: AiProvider; ctx: { workspaceId: string; userId: string }; via: RunVia; tools?: ToolSpec[]; responseFormat?: ResponseFormat };
// The budget counts the HIGHER of our estimate (catalog or workspace price) and the provider's own reported cost: a wrong or stale price can never undercount.
const charge = (estimated: number, reported?: number) => Math.max(estimated, reported ?? 0);
const sleepFor = (deps: AiDeps, attempts: number, e: AiError | null, backoff = deps.backoffMs ?? 500) => (deps.sleep ?? ((ms) => new Promise((res) => setTimeout(res, ms))))(Math.min(MAX_WAIT_MS, Math.max(backoff * 2 ** (attempts - 1), e?.retryAfterMs ?? 0)));
const wallMs = (deps: AiDeps) => (deps.now ?? Date.now)();

/**
 * Step 1 (shared by runAi and runAiStream): ONE short transaction as crm_worker: config, sealed key, active prompt, budget and month usage. The hard stop is decided here; a blocked call is logged and the
 * provider is NOT contacted. Then the request set-up (prompt, capability gates, adapter). Nothing here contacts the provider.
 */
async function begin(deps: AiDeps, r: RunInput): Promise<Begun> {
  const now = deps.now ?? Date.now;
  const ctx = { workspaceId: r.workspaceId, userId: r.userId };
  const prep: Prepared = await withContext(deps.workerDb, ctx, async (tx): Promise<Prepared> => {
    const cols = sql`id, provider, base_url, default_model, model_prices`;
    // A workspace may pin one model per job. It applies only when the caller named no provider or model, and only while it still works; otherwise the automatic pick below stands.
    let rProvider = r.provider, rModel = r.model;
    const job = JOB_OF_CAPABILITY[r.capability];
    if (job && !r.provider && !r.model) {
      const p = rowsOf(await tx.execute(sql`SELECT provider, model FROM ai_job_models WHERE workspace_id = ${r.workspaceId} AND job = ${job}`))[0];
      const pc = p ? rowsOf(await tx.execute(sql`SELECT ${cols} FROM ai_provider_configs WHERE workspace_id = ${r.workspaceId} AND provider = ${p.provider as string} AND enabled`))[0] : undefined;
      if (p && !pinProblem(pc && { provider: pc.provider as string, defaultModel: pc.default_model as string | null, prices: pc.model_prices as PriceOverrides }, p.provider as string, p.model as string, r.media ? r.media.needs : ["text"])) { rProvider = p.provider as string; rModel = p.model as string; }
    }
    const cfgs = rowsOf(await tx.execute(rProvider
      ? sql`SELECT ${cols} FROM ai_provider_configs WHERE workspace_id = ${r.workspaceId} AND provider = ${rProvider} AND enabled`
      : r.media ? sql`SELECT ${cols} FROM ai_provider_configs WHERE workspace_id = ${r.workspaceId} AND enabled ORDER BY is_default DESC, id`
      : sql`SELECT ${cols} FROM ai_provider_configs WHERE workspace_id = ${r.workspaceId} AND is_default AND enabled`));
    const none: Prepared = { kind: "stop", result: { ok: false, code: r.media ? "capability_not_configured" : "not_configured" } };
    let cfg: Record<string, unknown> | undefined = cfgs[0];
    let model = "";
    let price: ModelInfo | null = null;
    let via: Capability = "text";
    if (r.media) {
      // First config (default first) with a model that has a wanted capability; a pinned r.model must itself qualify.
      const hit = pickMediaCfg(cfgs.map((c) => ({ provider: c.provider as string, defaultModel: c.default_model as string | null, prices: c.model_prices as PriceOverrides, row: c })), r.media.needs, rModel);
      cfg = hit?.cfg.row;
      if (hit) { model = hit.model.id; price = hit.model; via = hit.via; }
    } else if (cfg) {
      model = rModel ?? (cfg.default_model as string);
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
        const shared = def.envKey ? deps.envKeys?.[provider] : undefined;
        if (s) key = deps.box.open({ ciphertext: s.ciphertext as Buffer, nonce: s.nonce as Buffer, keyId: s.key_id as string }, cfg.id as string);
        else if (shared) key = shared;
        else throw new Error("no key");
      } catch {
        const runId = await record(tx, r, { provider, model, status: "error", promptVersion, errorCode: "key_unavailable" });
        return { kind: "stop", result: { ok: false, code: "key_unavailable", runId } };
      }
    }
    return { kind: "go", provider, model, baseUrl: (cfg.base_url as string | null) ?? null, price, via, promptVersion, template, key, mock: def.mock };
  });
  if (prep.kind === "stop") return { kind: "stop", result: prep.result };

  const base = { provider: prep.provider, model: prep.model, promptVersion: prep.promptVersion };
  // Capability gates: only the stored flags decide (unknown model or no flags = false). Otherwise the caller's JSON-in-text system prompt and the prompt-based JSON stay in use.
  const useNative = !r.media && !!r.native?.tools.length && prep.price.supports?.tools === true;
  const useSchema = !r.media && !useNative && !!r.responseSchema && prep.price.supports?.structuredOutput === true;
  let system: string;
  try {
    system = (useNative ? r.native!.system : r.system) ?? renderTemplate(prep.template, r.vars);
  } catch (e) {
    const runId = await withContext(deps.workerDb, ctx, (tx) => record(tx, r, { ...base, status: "error", errorCode: e instanceof TemplateError ? "template_invalid" : "template_error" }));
    return { kind: "stop", result: { ok: false, code: "template_invalid", runId } };
  }
  // Media runs keep only mime, size and a hash of the bytes: never the bytes, the prompt or the output.
  const m = r.media?.input;
  const inputHash = m ? fingerprintBytes(m.bytes) : fingerprint(system + "\n" + r.input);
  const summary = m ? `media ${m.kind} ${m.mime} ${m.bytes.byteLength} bytes` : `in ${system.length + r.input.length} chars`;
  const timeoutMs = deps.timeoutMs ?? 30_000;
  const adapter = (deps.providerFor ?? ((id, o) => getProvider(id, o)))(prep.provider, { baseUrl: prep.baseUrl ?? undefined, timeoutMs, referer: deps.referer, title: deps.title });
  return {
    kind: "go", prep, system, base, inputHash, summary, adapter, ctx, via: useNative ? "native_tools" : useSchema ? "json_schema" : "text",
    ...(useNative ? { tools: r.native!.tools } : {}), ...(useSchema ? { responseFormat: { type: "json_schema" as const, json_schema: r.responseSchema! } } : {}),
  };
}

/**
 * Runs one AI call for a workspace. Order matters:
 *  1. begin(): the budget hard stop and set-up (see above).
 *  2. The provider call, with NO transaction open, a timeout, and bounded retry (rate_limit and timeout only, exponential backoff).
 *  3. A second short transaction appends the run (tokens, cost, latency). Prompts, replies and keys are never stored or logged.
 * Soft edge: calls already in flight when the cap is crossed still finish, so spend can overshoot the cap by what is in flight.
 */
export async function runAi(deps: AiDeps, r: RunInput): Promise<RunResult> {
  const b = await begin(deps, r);
  if (b.kind === "stop") return b.result;
  const { prep, system, base, inputHash, summary, adapter, ctx, via, tools, responseFormat } = b;
  const t0 = wallMs(deps);
  const maxRetries = deps.maxRetries ?? 2;
  let attempts = 0;
  let outcome: { ok: true; text: string; inputTokens: number; outputTokens: number; cost: number; routedModel?: string; toolCalls?: ToolCall[]; finishReason?: string } | { ok: false; code: string } | null = null;
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
        const g = await adapter.generate({ apiKey: prep.key ?? "", model: prep.model, maxOutputTokens: r.maxOutputTokens ?? 400, temperature: r.temperature ?? 0.4, messages: [{ role: "system", content: system }, { role: "user", content: r.input }], ...(tools ? { tools } : {}), ...(responseFormat ? { responseFormat } : {}) });
        outcome = { ok: true, text: g.text, inputTokens: g.usage.inputTokens, outputTokens: g.usage.outputTokens, cost: charge(costMicro(prep.price, g.usage), g.usage.reportedCostMicro), ...(g.routedModel ? { routedModel: g.routedModel } : {}), ...(g.toolCalls?.length ? { toolCalls: g.toolCalls } : {}), finishReason: g.finishReason };
      }
    } catch (e) {
      const code = e instanceof AiError ? e.code : "provider_error";
      const retryable = e instanceof AiError && e.retryable !== undefined ? e.retryable : RETRYABLE.has(code);
      // Wait = the larger of our backoff and the provider's Retry-After, never more than 30 s. Retries stay bounded by maxRetries.
      if (retryable && attempts <= maxRetries) { await sleepFor(deps, attempts, e instanceof AiError ? e : null); continue; }
      outcome = { ok: false, code };
    }
  }
  const latencyMs = Math.max(0, wallMs(deps) - t0);

  let runId: string | undefined;
  try {
    runId = await withContext(deps.workerDb, ctx, (tx) => record(tx, r, outcome.ok
      ? { ...base, status: "ok", inputTokens: outcome.inputTokens, outputTokens: outcome.outputTokens, costMicro: outcome.cost, latencyMs, attempts, inputHash, summary: `${summary}, out ${outcome.text.length} chars${outcome.toolCalls ? `, ${outcome.toolCalls.length} tool calls` : ""}${outcome.routedModel && outcome.routedModel !== prep.model ? `, routed to ${outcome.routedModel.slice(0, 100)}` : ""}` }
      : { ...base, status: "error", latencyMs, attempts, errorCode: outcome.code, inputHash, summary }));
  } catch (e) {
    console.error(JSON.stringify({ msg: "ai run record failed", error: safeError(e) }));
  }
  if (!outcome.ok) return { ok: false, code: outcome.code as RunFailure, runId };
  return { ok: true, text: outcome.text, runId: runId ?? "", provider: prep.provider, model: prep.model, mock: prep.mock, via, ...(outcome.toolCalls ? { toolCalls: outcome.toolCalls } : {}), ...(outcome.finishReason ? { finishReason: outcome.finishReason } : {}), usage: { inputTokens: outcome.inputTokens, outputTokens: outcome.outputTokens, costMicro: outcome.cost } };
}

export type RunStreamEvent =
  | { type: "delta"; text: string }
  | { type: "done"; runId: string; provider: string; model: string; mock: boolean; usage: { inputTokens: number; outputTokens: number; costMicro: number }; finishReason: string }
  | { type: "error"; code: StreamFailure; runId?: string };
const estTokens = (chars: number) => Math.max(1, Math.ceil(chars / 4));

/**
 * Streaming variant of runAi: the SAME begin() (config, key, prompt, budget hard stop BEFORE anything starts), the same retry rule and the same run log; no second path.
 *  - Retries (rate_limit, timeout, retryable provider errors) happen only BEFORE the first delta; once any text was emitted a failure ends the stream with an error event: output is never replayed.
 *  - Usage and cost come from the final usage event (cost = max(estimate, reported)); with no usage event the tokens are estimated (4 chars per token) and the run is still logged.
 *  - `signal` (client went away) or the consumer closing the iterator aborts the upstream call; the run is logged as error `client_aborted` with what is known.
 *  - Providers without generateStream are called once and the whole text is emitted as one delta. The text is never stored and no transaction is open while the stream runs.
 */
export async function* runAiStream(deps: AiDeps, r: RunInput, signal?: AbortSignal): AsyncGenerator<RunStreamEvent> {
  const b = await begin(deps, r);
  if (b.kind === "stop") { yield b.result.ok ? { type: "error", code: "provider_error" } : { type: "error", code: b.result.code, runId: b.result.runId }; return; }
  const { prep, system, base, inputHash, summary, adapter, ctx } = b;
  const up = new AbortController();
  const link = () => up.abort();
  if (signal?.aborted) up.abort(); else signal?.addEventListener("abort", link, { once: true });
  const t0 = wallMs(deps);
  const maxRetries = deps.maxRetries ?? 2;
  const inTokensEst = estTokens(system.length + r.input.length);
  let attempts = 0, text = "", started = false, done = false, recorded = false;
  let usage: { inputTokens: number; outputTokens: number; reportedCostMicro?: number } | null = null;
  let finishReason = "other", routed: string | undefined;
  let fail: { code: StreamFailure } | null = null;

  const finish = async (code: StreamFailure | null) => {
    if (recorded) return undefined;
    recorded = true;
    const inputTokens = usage?.inputTokens ?? inTokensEst, outputTokens = usage?.outputTokens ?? (text ? estTokens(text.length) : 0);
    const cost = charge(costMicro(prep.price, { inputTokens, outputTokens }), usage?.reportedCostMicro);
    const latencyMs = Math.max(0, wallMs(deps) - t0);
    try {
      return await withContext(deps.workerDb, ctx, (tx) => record(tx, r, code === null
        ? { ...base, status: "ok", inputTokens, outputTokens, costMicro: cost, latencyMs, attempts, inputHash, summary: `${summary}, out ${text.length} chars, streamed${routed && routed !== prep.model ? `, routed to ${routed.slice(0, 100)}` : ""}` }
        : { ...base, status: "error", inputTokens, outputTokens, costMicro: cost, latencyMs, attempts, errorCode: code, inputHash, summary: `${summary}, streamed, ${text.length} chars before ${code}` }));
    } catch (e) {
      console.error(JSON.stringify({ msg: "ai run record failed", error: safeError(e) }));
      return undefined;
    }
  };

  try {
    while (!done && !fail) {
      attempts++;
      let err: { code: RunFailure; retryable: boolean; error: AiError | null } | null = null;
      try {
        const req = { apiKey: prep.key ?? "", model: prep.model, maxOutputTokens: r.maxOutputTokens ?? 400, temperature: r.temperature ?? 0.4, messages: [{ role: "system" as const, content: system }, { role: "user" as const, content: r.input }], signal: up.signal };
        if (!adapter.generateStream) {
          const g = await adapter.generate(req);
          started = true; text = g.text; usage = g.usage; finishReason = g.finishReason; routed = g.routedModel; done = true;
          if (text) yield { type: "delta", text };
        } else {
          // Race each step against the abort: an adapter that is slow to notice the abort must not hold the run open.
          const it = adapter.generateStream(req)[Symbol.asyncIterator]();
          const aborted = new Promise<null>((res) => { if (up.signal.aborted) res(null); else up.signal.addEventListener("abort", () => res(null), { once: true }); });
          for (;;) {
            const step = await Promise.race([it.next(), aborted]);
            if (step === null) { void Promise.resolve(it.return?.()).catch(() => undefined); break; }
            if (step.done) break;
            const ev = step.value;
            if (ev.type === "delta") { started = true; text += ev.text; yield { type: "delta", text: ev.text }; }
            else if (ev.type === "usage") usage = { inputTokens: ev.inputTokens, outputTokens: ev.outputTokens, ...(ev.reportedCostMicro !== undefined ? { reportedCostMicro: ev.reportedCostMicro } : {}) };
            else if (ev.type === "done") { finishReason = ev.finishReason; routed = ev.routedModel; done = true; }
            else { err = { code: ev.code as RunFailure, retryable: ev.retryable ?? RETRYABLE.has(ev.code), error: ev.retryAfterMs ? new AiError(ev.code, ev.status, { retryAfterMs: ev.retryAfterMs }) : null }; break; }
          }
        }
      } catch (e) {
        const code = e instanceof AiError ? e.code : "provider_error";
        err = { code, retryable: e instanceof AiError && e.retryable !== undefined ? e.retryable : RETRYABLE.has(code), error: e instanceof AiError ? e : null };
      }
      if (up.signal.aborted && (signal?.aborted ?? false)) { fail = { code: "client_aborted" }; break; }
      if (!err && !done) err = { code: "provider_error", retryable: false, error: null }; // the adapter ended without done
      if (err) {
        if (!started && err.retryable && attempts <= maxRetries) { await sleepFor(deps, attempts, err.error); continue; }
        fail = { code: err.code };
      }
    }
    const runId = await finish(fail ? fail.code : null);
    if (fail) yield { type: "error", code: fail.code, runId };
    else yield { type: "done", runId: runId ?? "", provider: prep.provider, model: prep.model, mock: prep.mock, finishReason, usage: { inputTokens: usage?.inputTokens ?? inTokensEst, outputTokens: usage?.outputTokens ?? estTokens(text.length), costMicro: charge(costMicro(prep.price, { inputTokens: usage?.inputTokens ?? inTokensEst, outputTokens: usage?.outputTokens ?? estTokens(text.length) }), usage?.reportedCostMicro) } };
  } finally {
    // The consumer closed the iterator (client gone) before a result: abort upstream and log what is known.
    up.abort();
    signal?.removeEventListener("abort", link);
    await finish("client_aborted");
  }
}
