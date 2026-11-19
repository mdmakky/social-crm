import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { z } from "zod";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import { ActivateAiPromptBody, AI_JOBS, AiJobSchema, AiUsageQuery, SetAiJobModelBody, type AiJobKey, type AiJobModelDto, MediaAskBody, MediaDescribeBody, MediaExtractBody, MediaTranscribeBody, type AiCapabilities, type MediaResult, SetAiBudgetBody, SetAiPromptBody, SetAiProviderBody, type AiBudgetDto, type AiPromptDto, type AiProviderDto, type AiStatusDto, type AiUsageDto, type SuggestReplyResult } from "@crm/contracts";
import { checkTemplate, modelsFor, priceOf, PROMPTS, PROVIDERS, promptDef, providerDef, renderTemplate, REPLY_SUGGESTION_KEY, TemplateError, type Capability, type PriceOverrides, type StoredModel } from "@crm/ai";
import { can } from "@crm/core/permissions";
import { schema, withContext, type Db, type Tx } from "@crm/db";
import { writeAudit } from "../audit.ts";
import { actor, body, fail, forbidden, isUuid, query, wctx, type SC, type ScopedEnv } from "../routes/scope.ts";
import { WindowCounter } from "../throttle.ts";
import { streamSSE } from "hono/streaming";
import { pinProblem, resolveJob, type JobCfg } from "./jobs.ts";
import { runAi, runAiStream, type AiDeps, type RunInput } from "./run.ts";
import { MEDIA_FAILURES, type MediaOutcome, type MediaService } from "./media.ts";
import { createModelBrowser, type ModelBrowser, type ModelList } from "./openrouter-browser.ts";

export type AiRouteDeps = { ai?: AiDeps; media?: MediaService; configsPerUser?: number; suggestionsPerUser?: number; browser?: ModelBrowser; browsesPerUser?: number; streamKeepaliveMs?: number };
const rowsOf = (r: unknown) => (r as { rows: Record<string, unknown>[] }).rows;
const uniqueViolation = (e: unknown) => (e as { cause?: { code?: string } })?.cause?.code === "23505";
const MESSAGES_CONTEXT = 12;
const MESSAGE_CHARS = 600;
const CONTEXT_CHARS = 6000;

/** https only, no credentials, and no host that is obviously internal. ponytail: a name that RESOLVES to a private address (DNS rebinding) is not caught; add an egress allow-list before untrusted workspaces can set a base URL. */
export function safeBaseUrl(raw: string): string | null {
  try {
    const u = new URL(raw);
    if (u.protocol !== "https:" || u.username || u.password || u.search || u.hash) return null;
    const h = u.hostname.toLowerCase();
    if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local") || h.endsWith(".internal") || h.includes(":")) return null;
    if (/^\d+\.\d+\.\d+\.\d+$/.test(h)) {
      const [a, b] = h.split(".").map(Number) as [number, number];
      if (a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) return null;
    }
    return u.toString().replace(/\/+$/, "");
  } catch {
    return null;
  }
}

const toProvider = (id: string, cfg?: typeof schema.aiProviderConfigs.$inferSelect): AiProviderDto => {
  const def = PROVIDERS[id]!;
  const prices = (cfg?.modelPrices ?? {}) as PriceOverrides;
  return {
    id, label: def.label, mock: def.mock, customBaseUrl: def.customBaseUrl,
    models: modelsFor(id, prices).map((m) => ({ id: m.id, label: m.label, inputMicroPer1M: m.inputMicroPer1M, outputMicroPer1M: m.outputMicroPer1M, capabilities: [...m.capabilities], ...(m.contextLength ? { contextLength: m.contextLength } : {}), ...(m.supports ? { supports: m.supports } : {}) })),
    configured: !!cfg, enabled: cfg?.enabled ?? false, isDefault: cfg?.isDefault ?? false, defaultModel: cfg?.defaultModel ?? null, keyLast4: cfg?.keyLast4 ?? null, baseUrl: cfg?.baseUrl ?? null, modelPrices: prices,
  };
};

const ROUTER_OR_BAD_ID = (id: string) => id.startsWith("openrouter/") || !/^[\w.:~@+-]+(\/[\w.:~@+-]+)+$/.test(id);

/**
 * What gets stored per enabled model. Prices come from the request. For OpenRouter the extra fields are never trusted from the client: capabilities are the client's choice INTERSECTED with what the
 * server can confirm (the list it fetched itself, else what this workspace already has stored for that id; nothing confirmable = text only), and context length / tool support are copied from that same source.
 * Router aliases (`openrouter/...`) are refused. Every other provider keeps prices only.
 */
export function sanitizeModelPrices(provider: string, input: Record<string, StoredModel>, existing: PriceOverrides, cached: ModelList | null): { ok: true; prices: PriceOverrides } | { ok: false; message: string } {
  const entries = Object.entries(input);
  if (provider !== "openrouter") {
    if (entries.length > 20) return { ok: false, message: "At most 20 model prices" };
    return { ok: true, prices: Object.fromEntries(entries.map(([id, p]) => [id, { inputMicroPer1M: p.inputMicroPer1M, outputMicroPer1M: p.outputMicroPer1M }])) };
  }
  const prices: PriceOverrides = {};
  for (const [id, p] of entries) {
    if (ROUTER_OR_BAD_ID(id)) return { ok: false, message: `"${id}" is not a model id that can be enabled (router aliases such as openrouter/auto are not supported).` };
    const known = cached?.items.find((m) => m.id === id);
    const prev = existing[id];
    const allowed: readonly Capability[] = known ? known.capabilities : prev?.capabilities ?? [];
    const caps = (p.capabilities ?? []).filter((c, i, a) => c !== "text" && allowed.includes(c) && a.indexOf(c) === i) as Capability[];
    const contextLength = known ? known.contextLength ?? undefined : prev?.contextLength;
    const supports = known ? known.supports : prev?.supports;
    prices[id] = { inputMicroPer1M: p.inputMicroPer1M, outputMicroPer1M: p.outputMicroPer1M, ...(caps.length ? { capabilities: caps } : {}), ...(contextLength ? { contextLength } : {}), ...(supports ? { supports } : {}) };
  }
  return { ok: true, prices };
}

/**
 * AI settings and the reply-suggestion capability. Permissions: ai.configure (owner, admin) manages providers, prompts and budget; ai.use (owner, admin, agent) asks for a draft.
 * The provider key is write-only: sealed with the SecretBox (config id as AAD), inserted by the app role, readable only by crm_worker inside runAi. No response, audit entry or log carries it.
 */
export function aiRoutes(db: Db, deps: AiRouteDeps = {}) {
  const r = new Hono<ScopedEnv>();
  const configs = new WindowCounter(deps.configsPerUser ?? 20, 10 * 60_000);
  const suggestions = new WindowCounter(deps.suggestionsPerUser ?? 20, 60_000);
  const browses = new WindowCounter(deps.browsesPerUser ?? 30, 10 * 60_000);
  const browser = deps.browser ?? createModelBrowser();
  const manage = (c: SC) => can(c.get("role"), "ai.configure", {});

  /** OpenRouter model browser: the public list, no key, no database transaction (the fetch happens here, outside any). Owner and admin only. */
  r.get("/ai/providers/openrouter/models", async (c) => {
    if (!manage(c)) return forbidden(c);
    if (!browses.allow(`${c.get("workspaceId")}:${c.get("userId")}`)) { c.header("Retry-After", "600"); return fail(c, 429, "rate_limited", "Too many model list requests. Try again in a few minutes."); }
    try {
      const l = await browser.list();
      return c.json({ items: l.items, syncedAt: l.syncedAt, mock: browser.mock, unverified: true });
    } catch (e) {
      console.error(JSON.stringify({ msg: "openrouter model list failed", error: (e as Error).name }));
      return fail(c, 502, "models_unavailable", "The OpenRouter model list could not be loaded. Try again in a moment.");
    }
  });

  r.get("/ai/providers", async (c) => {
    if (!manage(c)) return forbidden(c);
    const rows = await withContext(db, wctx(c), (tx) => tx.select().from(schema.aiProviderConfigs).where(eq(schema.aiProviderConfigs.workspaceId, c.get("workspaceId"))));
    return c.json({ items: Object.keys(PROVIDERS).map((id) => toProvider(id, rows.find((x) => x.provider === id))) });
  });

  r.put("/ai/providers/:provider", async (c) => {
    if (!manage(c)) return forbidden(c);
    const providerId = c.req.param("provider");
    const def = providerDef(providerId);
    if (!def) return fail(c, 404, "not_found");
    if (!configs.allow(`${c.get("workspaceId")}:${c.get("userId")}`)) { c.header("Retry-After", "600"); return fail(c, 429, "rate_limited", "Too many changes. Try again in a few minutes."); }
    const b = await body(c, SetAiProviderBody);
    if (!b.ok) return b.res;
    const d = b.data;
    if (def.mock && (d.apiKey !== undefined || d.baseUrl)) return fail(c, 400, "invalid_body", "The mock provider takes no key or URL.");
    if (!def.customBaseUrl && d.baseUrl) return fail(c, 400, "invalid_body", "This provider does not take a custom URL.");
    let baseUrl: string | null | undefined;
    if (d.baseUrl) { baseUrl = safeBaseUrl(d.baseUrl); if (!baseUrl) return fail(c, 400, "invalid_body", "Use a public https URL without credentials."); } else if (d.baseUrl === null) baseUrl = null;
    if (d.apiKey !== undefined && !deps.ai) return fail(c, 503, "ai_not_configured", "Secret storage is not configured on this server.");
    const { workspaceId, userId } = wctx(c);

    return withContext(db, wctx(c), async (tx) => {
      const [existing] = await tx.select().from(schema.aiProviderConfigs).where(and(eq(schema.aiProviderConfigs.workspaceId, workspaceId), eq(schema.aiProviderConfigs.provider, providerId)));
      if (!existing && !def.mock && d.apiKey === undefined) return fail(c, 400, "key_required", "Add the provider's API key to connect it.");
      let prices = (existing?.modelPrices ?? {}) as PriceOverrides;
      if (d.modelPrices) {
        const s = sanitizeModelPrices(providerId, d.modelPrices as Record<string, StoredModel>, prices, browser.peek());
        if (!s.ok) return fail(c, 400, "invalid_body", s.message);
        prices = s.prices;
      }
      const model = d.defaultModel ?? existing?.defaultModel ?? modelsFor(providerId, prices)[0]?.id ?? null;
      if (!model || !priceOf(providerId, model, prices)) return fail(c, 400, "unknown_model", providerId === "openrouter" ? "Enable at least one model and choose one of the enabled models as the default." : "Choose a listed model, or add its price so spend can be counted.");
      const enabled = d.enabled ?? existing?.enabled ?? true;
      const others = await tx.select({ id: schema.aiProviderConfigs.id, isDefault: schema.aiProviderConfigs.isDefault, enabled: schema.aiProviderConfigs.enabled }).from(schema.aiProviderConfigs).where(eq(schema.aiProviderConfigs.workspaceId, workspaceId));
      const hasOtherDefault = others.some((o) => o.isDefault && o.id !== existing?.id && o.enabled);
      const isDefault = enabled && (d.isDefault ?? (existing ? existing.isDefault : !hasOtherDefault));
      if (isDefault) await tx.update(schema.aiProviderConfigs).set({ isDefault: false, updatedAt: new Date() }).where(and(eq(schema.aiProviderConfigs.workspaceId, workspaceId), eq(schema.aiProviderConfigs.isDefault, true)));
      const keyLast4 = d.apiKey !== undefined ? d.apiKey.slice(-4) : existing?.keyLast4 ?? null;
      let row: typeof schema.aiProviderConfigs.$inferSelect;
      if (existing) {
        [row] = await tx.update(schema.aiProviderConfigs).set({ ...(baseUrl !== undefined ? { baseUrl } : {}), defaultModel: model, enabled, isDefault, keyLast4, modelPrices: prices, updatedAt: new Date() }).where(and(eq(schema.aiProviderConfigs.workspaceId, workspaceId), eq(schema.aiProviderConfigs.id, existing.id))).returning() as [typeof row];
      } else {
        [row] = await tx.insert(schema.aiProviderConfigs).values({ id: randomUUID(), workspaceId, provider: providerId, baseUrl: baseUrl ?? null, defaultModel: model, enabled, isDefault, keyLast4, modelPrices: prices, createdBy: userId }).returning() as [typeof row];
      }
      if (d.apiKey !== undefined) {
        const sealed = deps.ai!.box.seal(d.apiKey, row.id);
        await tx.insert(schema.aiProviderSecrets).values({ workspaceId, configId: row.id, ciphertext: sealed.ciphertext, nonce: sealed.nonce, keyId: sealed.keyId });
      }
      await writeAudit(tx, { ...actor(c), workspaceId, action: "ai.provider.configured", entityType: "ai_provider", entityId: row.id, summary: { provider: providerId, model, enabled, isDefault, keyRotated: d.apiKey !== undefined } });
      return c.json(toProvider(providerId, row));
    });
  });

  const promptDto = async (tx: Tx, workspaceId: string, key: string): Promise<AiPromptDto> => {
    const def = promptDef(key)!;
    const rows = await tx.select().from(schema.aiPrompts).where(and(eq(schema.aiPrompts.workspaceId, workspaceId), eq(schema.aiPrompts.key, key))).orderBy(desc(schema.aiPrompts.version));
    return {
      key, label: def.label, variables: [...def.variables], defaultTemplate: def.defaultTemplate, activeVersion: rows.find((x) => x.active)?.version ?? 0,
      versions: rows.map((x) => ({ version: x.version, template: x.template, active: x.active, createdAt: x.createdAt.toISOString(), createdBy: x.createdBy })),
    };
  };

  r.get("/ai/prompts", async (c) => {
    if (!manage(c)) return forbidden(c);
    return c.json({ items: await withContext(db, wctx(c), async (tx) => { const out: AiPromptDto[] = []; for (const k of Object.keys(PROMPTS)) out.push(await promptDto(tx, c.get("workspaceId"), k)); return out; }) });
  });

  r.put("/ai/prompts/:key", async (c) => {
    if (!manage(c)) return forbidden(c);
    const key = c.req.param("key");
    const def = promptDef(key);
    if (!def) return fail(c, 404, "not_found");
    const b = await body(c, SetAiPromptBody);
    if (!b.ok) return b.res;
    try {
      checkTemplate(b.data.template, def.variables);
      renderTemplate(b.data.template, Object.fromEntries(def.variables.map((v) => [v, "x"])));
    } catch (e) {
      if (e instanceof TemplateError) return fail(c, 400, "invalid_template", e.kind === "unknown_variable" ? `Unknown placeholder {{${e.variable}}}. Allowed: ${def.variables.map((v) => `{{${v}}}`).join(", ")}.` : `Invalid placeholder near "${e.variable ?? ""}". Use names like {{contact_name}}.`);
      throw e;
    }
    const { workspaceId, userId } = wctx(c);
    try {
      return await withContext(db, wctx(c), async (tx) => {
        const [last] = await tx.select({ v: sql<number>`coalesce(max(${schema.aiPrompts.version}), 0)::int` }).from(schema.aiPrompts).where(and(eq(schema.aiPrompts.workspaceId, workspaceId), eq(schema.aiPrompts.key, key)));
        const version = (last?.v ?? 0) + 1;
        await tx.update(schema.aiPrompts).set({ active: false }).where(and(eq(schema.aiPrompts.workspaceId, workspaceId), eq(schema.aiPrompts.key, key), eq(schema.aiPrompts.active, true)));
        await tx.insert(schema.aiPrompts).values({ workspaceId, key, version, template: b.data.template, active: true, createdBy: userId });
        await writeAudit(tx, { ...actor(c), workspaceId, action: "ai.prompt.published", entityType: "ai_prompt", summary: { key, version } });
        return c.json(await promptDto(tx, workspaceId, key));
      });
    } catch (e) {
      if (uniqueViolation(e)) return fail(c, 409, "busy", "Someone else just changed this prompt. Reload and try again.");
      throw e;
    }
  });

  r.post("/ai/prompts/:key/activate", async (c) => {
    if (!manage(c)) return forbidden(c);
    const key = c.req.param("key");
    if (!promptDef(key)) return fail(c, 404, "not_found");
    const b = await body(c, ActivateAiPromptBody);
    if (!b.ok) return b.res;
    const { workspaceId } = wctx(c);
    return withContext(db, wctx(c), async (tx) => {
      if (b.data.version > 0) {
        const [v] = await tx.select({ id: schema.aiPrompts.id }).from(schema.aiPrompts).where(and(eq(schema.aiPrompts.workspaceId, workspaceId), eq(schema.aiPrompts.key, key), eq(schema.aiPrompts.version, b.data.version)));
        if (!v) return fail(c, 404, "not_found");
      }
      await tx.update(schema.aiPrompts).set({ active: false }).where(and(eq(schema.aiPrompts.workspaceId, workspaceId), eq(schema.aiPrompts.key, key), eq(schema.aiPrompts.active, true)));
      if (b.data.version > 0) await tx.update(schema.aiPrompts).set({ active: true }).where(and(eq(schema.aiPrompts.workspaceId, workspaceId), eq(schema.aiPrompts.key, key), eq(schema.aiPrompts.version, b.data.version)));
      await writeAudit(tx, { ...actor(c), workspaceId, action: "ai.prompt.activated", entityType: "ai_prompt", summary: { key, version: b.data.version } });
      return c.json(await promptDto(tx, workspaceId, key));
    });
  });

  const budgetOf = async (c: SC): Promise<AiBudgetDto> => {
    const [row] = await withContext(db, wctx(c), (tx) => tx.select().from(schema.aiBudgets).where(eq(schema.aiBudgets.workspaceId, c.get("workspaceId"))));
    return { monthlyCapMicro: row?.monthlyCapMicro ?? null, hardStop: row?.hardStop ?? true };
  };
  r.get("/ai/budget", async (c) => (manage(c) ? c.json(await budgetOf(c)) : forbidden(c)));
  r.put("/ai/budget", async (c) => {
    if (!manage(c)) return forbidden(c);
    const b = await body(c, SetAiBudgetBody);
    if (!b.ok) return b.res;
    const { workspaceId, userId } = wctx(c);
    await withContext(db, wctx(c), async (tx) => {
      await tx.insert(schema.aiBudgets).values({ workspaceId, monthlyCapMicro: b.data.monthlyCapMicro, hardStop: b.data.hardStop, updatedBy: userId })
        .onConflictDoUpdate({ target: schema.aiBudgets.workspaceId, set: { monthlyCapMicro: b.data.monthlyCapMicro, hardStop: b.data.hardStop, updatedBy: userId, updatedAt: new Date() } });
      await writeAudit(tx, { ...actor(c), workspaceId, action: "ai.budget.updated", entityType: "ai_budget", summary: { monthlyCapMicro: b.data.monthlyCapMicro, hardStop: b.data.hardStop } });
    });
    return c.json(await budgetOf(c));
  });

  // ---- Jobs: one pinned model per job. Reads: ai.use (like status and capabilities); changes: ai.configure. ----
  const jobCfgs = async (tx: Tx, workspaceId: string): Promise<JobCfg[]> =>
    (await tx.select().from(schema.aiProviderConfigs).where(and(eq(schema.aiProviderConfigs.workspaceId, workspaceId), eq(schema.aiProviderConfigs.enabled, true))).orderBy(desc(schema.aiProviderConfigs.isDefault), asc(schema.aiProviderConfigs.id)))
      .map((x) => ({ provider: x.provider, defaultModel: x.defaultModel, prices: (x.modelPrices ?? {}) as PriceOverrides, isDefault: x.isDefault }));
  const jobDtos = async (tx: Tx, workspaceId: string, only?: AiJobKey): Promise<AiJobModelDto[]> => {
    const cfgs = await jobCfgs(tx, workspaceId);
    const pins = await tx.select().from(schema.aiJobModels).where(eq(schema.aiJobModels.workspaceId, workspaceId));
    return (Object.keys(AI_JOBS) as AiJobKey[]).filter((j) => !only || j === only).map((j) => { const p = pins.find((x) => x.job === j); return resolveJob(cfgs, j, p ? { provider: p.provider, model: p.model } : null); });
  };
  r.get("/ai/jobs", async (c) => {
    if (!can(c.get("role"), "ai.use", {})) return forbidden(c);
    return c.json({ items: await withContext(db, wctx(c), (tx) => jobDtos(tx, c.get("workspaceId"))) });
  });
  r.put("/ai/jobs/:job", async (c) => {
    if (!manage(c)) return forbidden(c);
    const job = AiJobSchema.safeParse(c.req.param("job"));
    if (!job.success) return fail(c, 404, "not_found");
    const b = await body(c, SetAiJobModelBody);
    if (!b.ok) return b.res;
    const { workspaceId, userId } = wctx(c);
    return withContext(db, wctx(c), async (tx) => {
      const cfg = (await jobCfgs(tx, workspaceId)).find((x) => x.provider === b.data.provider);
      const problem = pinProblem(cfg, b.data.provider, b.data.model, [AI_JOBS[job.data].needs] as Capability[]);
      if (problem) return fail(c, 422, "model_cannot_do_job", problem.replace(", so the pinned model is not used.", ".").replace(" any more", ""));
      await tx.insert(schema.aiJobModels).values({ workspaceId, job: job.data, provider: b.data.provider, model: b.data.model, updatedBy: userId })
        .onConflictDoUpdate({ target: [schema.aiJobModels.workspaceId, schema.aiJobModels.job], set: { provider: b.data.provider, model: b.data.model, updatedBy: userId, updatedAt: new Date() } });
      await writeAudit(tx, { ...actor(c), workspaceId, action: "ai.job_model_set", entityType: "ai_job_model", summary: { job: job.data, provider: b.data.provider, model: b.data.model } });
      return c.json((await jobDtos(tx, workspaceId, job.data))[0]!);
    });
  });
  r.delete("/ai/jobs/:job", async (c) => {
    if (!manage(c)) return forbidden(c);
    const job = AiJobSchema.safeParse(c.req.param("job"));
    if (!job.success) return fail(c, 404, "not_found");
    const { workspaceId } = wctx(c);
    return withContext(db, wctx(c), async (tx) => {
      const gone = await tx.delete(schema.aiJobModels).where(and(eq(schema.aiJobModels.workspaceId, workspaceId), eq(schema.aiJobModels.job, job.data))).returning({ model: schema.aiJobModels.model });
      if (gone.length) await writeAudit(tx, { ...actor(c), workspaceId, action: "ai.job_model_cleared", entityType: "ai_job_model", summary: { job: job.data, model: gone[0]!.model } });
      return c.json((await jobDtos(tx, workspaceId, job.data))[0]!);
    });
  });

  r.get("/ai/usage", async (c) => {
    if (!manage(c)) return forbidden(c);
    const q = query(c, AiUsageQuery);
    if (!q.ok) return q.res;
    const days = q.data.days ?? 30;
    const { workspaceId } = wctx(c);
    const out = await withContext(db, wctx(c), async (tx): Promise<AiUsageDto> => {
      const m = rowsOf(await tx.execute(sql`
        SELECT to_char(date_trunc('month', now() AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS start,
               coalesce(sum(cost_micro), 0)::text AS used, coalesce(sum(input_tokens), 0)::text AS tin, coalesce(sum(output_tokens), 0)::text AS tout,
               count(*)::int AS runs, (count(*) FILTER (WHERE status = 'blocked_budget'))::int AS blocked
        FROM ai_runs WHERE workspace_id = ${workspaceId} AND created_at >= date_trunc('month', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'`))[0]!;
      const [bud] = await tx.select().from(schema.aiBudgets).where(eq(schema.aiBudgets.workspaceId, workspaceId));
      const d = rowsOf(await tx.execute(sql`
        SELECT to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day, capability, count(*)::int AS runs, (count(*) FILTER (WHERE status = 'error'))::int AS errors,
               (count(*) FILTER (WHERE status = 'blocked_budget'))::int AS blocked, coalesce(sum(input_tokens), 0)::text AS tin, coalesce(sum(output_tokens), 0)::text AS tout, coalesce(sum(cost_micro), 0)::text AS cost
        FROM ai_runs WHERE workspace_id = ${workspaceId} AND created_at >= now() - make_interval(days => ${days})
        GROUP BY 1, 2 ORDER BY 1 DESC, 2`));
      const used = Number(m.used);
      const cap = bud?.monthlyCapMicro ?? null;
      const hardStop = bud?.hardStop ?? true;
      return {
        month: { start: m.start as string, usedMicro: used, inputTokens: Number(m.tin), outputTokens: Number(m.tout), runs: m.runs as number, blockedRuns: m.blocked as number, capMicro: cap, hardStop, blocked: hardStop && cap !== null && used >= cap },
        byDay: d.map((x) => ({ day: x.day as string, capability: x.capability as string, runs: x.runs as number, errors: x.errors as number, blocked: x.blocked as number, inputTokens: Number(x.tin), outputTokens: Number(x.tout), costMicro: Number(x.cost) })),
      };
    });
    return c.json(out);
  });

  r.get("/ai/status", async (c) => {
    if (!can(c.get("role"), "ai.use", {})) return forbidden(c);
    const [cfg] = await withContext(db, wctx(c), (tx) => tx.select().from(schema.aiProviderConfigs).where(and(eq(schema.aiProviderConfigs.workspaceId, c.get("workspaceId")), eq(schema.aiProviderConfigs.isDefault, true), eq(schema.aiProviderConfigs.enabled, true))).orderBy(asc(schema.aiProviderConfigs.id)).limit(1));
    const out: AiStatusDto = { ready: !!deps.ai && !!cfg?.defaultModel && !!providerDef(cfg.provider), provider: cfg?.provider ?? null, model: cfg?.defaultModel ?? null, mock: cfg ? providerDef(cfg.provider)?.mock ?? false : false };
    return c.json(out);
  });

  /**
   * Shared by suggest-reply and its stream: permission, id, configured server, rate limit (ONE counter for both, so streaming is no way around the limit), then the conversation context.
   * The transcript is sent to the provider and then dropped: it is never stored or logged. Returns the run input, or the failure response.
   */
  const suggestInput = async (c: SC) => {
    if (!can(c.get("role"), "ai.use", {})) return { res: forbidden(c) };
    const id = c.req.param("conversationId") ?? "";
    if (!isUuid(id)) return { res: fail(c, 404, "not_found") };
    if (!deps.ai) return { res: fail(c, 503, "ai_not_configured", "AI is not configured on this server.") };
    if (!suggestions.allow(`${c.get("workspaceId")}:${c.get("userId")}`)) { c.header("Retry-After", "60"); return { res: fail(c, 429, "rate_limited", "Too many suggestions. Try again in a minute.") }; }
    const { workspaceId, userId } = wctx(c);
    const ctx = await withContext(db, wctx(c), async (tx) => {
      const conv = rowsOf(await tx.execute(sql`
        SELECT ct.name AS contact_name, a.platform FROM conversations c
        JOIN integration_accounts a ON a.workspace_id = c.workspace_id AND a.id = c.integration_account_id
        JOIN contacts ct ON ct.workspace_id = c.workspace_id AND ct.id = c.contact_id
        WHERE c.workspace_id = ${workspaceId} AND c.id = ${id}`))[0];
      if (!conv) return null;
      const msgs = rowsOf(await tx.execute(sql`SELECT direction, body FROM messages WHERE workspace_id = ${workspaceId} AND conversation_id = ${id} AND body IS NOT NULL AND body <> '' ORDER BY seq DESC LIMIT ${MESSAGES_CONTEXT}`));
      return { name: conv.contact_name as string, platform: conv.platform as string, msgs: msgs.reverse().map((m) => ({ out: m.direction === "out", body: m.body as string })) };
    });
    if (!ctx) return { res: fail(c, 404, "not_found") };
    if (!ctx.msgs.some((m) => !m.out)) return { res: fail(c, 422, "no_customer_message", "There is no customer message to reply to yet.") };
    // Newest messages win the character budget; each message is clipped.
    let left = CONTEXT_CHARS;
    const lines: string[] = [];
    for (const m of [...ctx.msgs].reverse()) {
      const line = `${m.out ? "Agent" : "Customer"}: ${m.body.slice(0, MESSAGE_CHARS)}`;
      if (left - line.length < 0) break;
      left -= line.length;
      lines.unshift(line);
    }
    const input: RunInput = {
      workspaceId, userId, capability: "reply_suggestion", promptKey: REPLY_SUGGESTION_KEY, vars: { contact_name: ctx.name.slice(0, 80), channel: ctx.platform },
      input: `Conversation (oldest first):\n<<<\n${lines.join("\n")}\n>>>`, entity: { type: "conversation", id }, maxOutputTokens: 400,
    };
    return { input };
  };
  /** One mapping of run failures to HTTP status, error code and message, used by the JSON route (as the response) and the stream route (as the `error` event). */
  const suggestFailure = (code: string): { status: 402 | 409 | 422 | 429 | 502; code: string; message: string } => {
    switch (code) {
      case "not_configured": return { status: 409, code: "ai_not_configured", message: "No AI provider is set up for this workspace. An owner or admin can add one in Settings, AI." };
      case "budget_exceeded": return { status: 409, code: "budget_exceeded", message: "The monthly AI budget is used up. An owner or admin can raise it in Settings, AI." };
      case "rate_limit": return { status: 429, code: "ai_busy", message: "The AI provider is busy. Try again in a moment." };
      case "payment_required": return { status: 402, code: "payment_required", message: MEDIA_FAILURES.payment_required.message };
      case "blocked": return { status: 422, code: "blocked", message: MEDIA_FAILURES.blocked.message };
      case "auth": case "key_unavailable": return { status: 502, code: "ai_key_rejected", message: "The AI provider key was rejected or cannot be read. An owner or admin should check it in Settings, AI." };
      default: return { status: 502, code: "ai_unavailable", message: "The suggestion could not be generated. Write your reply by hand or try again." };
    }
  };

  /** Draft only. This route creates no message and calls no send path: the person edits the text and sends it through the normal composer. */
  r.post("/conversations/:conversationId/ai/suggest-reply", async (c) => {
    const s = await suggestInput(c);
    if (!s.input) return s.res;
    const res = await runAi(deps.ai!, s.input);
    if (res.ok) {
      const out: SuggestReplyResult = { draft: res.text.trim(), provider: res.provider, model: res.model, mock: res.mock, runId: res.runId };
      return c.json(out);
    }
    const f = suggestFailure(res.code);
    return fail(c, f.status, f.code, f.message);
  });

  /**
   * Same draft as suggest-reply, as Server-Sent Events: `event: delta` {text}, then `usage`, then `done`; a failure is one `event: error` {code, message, status}. Always HTTP 200 once past the shared checks
   * (the budget hard stop is applied before the provider is contacted and arrives as an `error` event). `: keepalive` comments every 15 s. Headers stop proxies from buffering or transforming the stream.
   * The request's abort (client gone, Stop pressed) aborts the upstream call and the run is logged as client_aborted. Draft only, like the JSON route.
   */
  r.post("/conversations/:conversationId/ai/suggest-reply/stream", async (c) => {
    const s = await suggestInput(c);
    if (!s.input) return s.res;
    const input = s.input;
    const res = streamSSE(c, async (stream) => {
      const ac = new AbortController();
      const stop = () => ac.abort();
      stream.onAbort(stop);
      c.req.raw.signal.addEventListener("abort", stop, { once: true });
      const ka = setInterval(() => { stream.write(": keepalive\n\n").catch(stop); }, deps.streamKeepaliveMs ?? 15_000);
      try {
        for await (const ev of runAiStream(deps.ai!, input, ac.signal)) {
          if (ac.signal.aborted) break;
          if (ev.type === "delta") await stream.writeSSE({ event: "delta", data: JSON.stringify({ text: ev.text }) });
          else if (ev.type === "done") {
            await stream.writeSSE({ event: "usage", data: JSON.stringify(ev.usage) });
            await stream.writeSSE({ event: "done", data: JSON.stringify({ provider: ev.provider, model: ev.model, mock: ev.mock, runId: ev.runId, finishReason: ev.finishReason }) });
          } else if (ev.code !== "client_aborted") {
            const f = suggestFailure(ev.code);
            await stream.writeSSE({ event: "error", data: JSON.stringify({ code: f.code, message: f.message, status: f.status }) });
          }
        }
      } catch {
        stop(); // the client closed the connection mid-write
      } finally {
        clearInterval(ka);
        c.req.raw.signal.removeEventListener("abort", stop);
      }
    });
    res.headers.set("Cache-Control", "no-cache, no-transform");
    res.headers.set("X-Accel-Buffering", "no");
    return res;
  });

  // ---- Multimodal (slice 1): describe / ask / extract / transcribe, and the capability matrix that drives the UI. ----
  const MB = 1024 * 1024;
  const respond = (c: SC, out: MediaOutcome) => {
    if (out.ok) {
      const res: MediaResult = { text: out.text, provider: out.provider, model: out.model, mock: out.mock, runId: out.runId, usage: out.usage };
      return c.json(res);
    }
    const f = MEDIA_FAILURES[out.code];
    if (out.code === "rate_limited") c.header("Retry-After", "60");
    return fail(c, f.status, out.code === "not_configured" ? "capability_not_configured" : out.code, f.message);
  };
  /** Shared gate: size cap on the stream, ai.use, a configured server, then the typed body. */
  const mediaRoute = <S extends z.ZodType>(path: string, maxBody: number, schema: S, run: (ms: MediaService, who: { workspaceId: string; userId: string }, b: z.output<S>) => Promise<MediaOutcome>) =>
    r.post(path, bodyLimit({ maxSize: maxBody, onError: (c) => fail(c as SC, 413, "media_too_large", MEDIA_FAILURES.media_too_large.message) }), async (c) => {
      if (!can(c.get("role"), "ai.use", {})) return forbidden(c);
      if (!deps.media) return fail(c, 503, "ai_not_configured", "AI is not configured on this server.");
      const b = await body(c, schema);
      if (!b.ok) return b.res;
      return respond(c, await run(deps.media, wctx(c), b.data));
    });
  const file = (b: { mime: string; contentBase64: string }) => ({ mime: b.mime, bytes: new Uint8Array(Buffer.from(b.contentBase64, "base64")) });
  mediaRoute("/ai/media/describe", 8 * MB, MediaDescribeBody, (ms, who, b) => ms.describeImage(who, file(b)));
  mediaRoute("/ai/media/ask", 8 * MB, MediaAskBody, (ms, who, b) => ms.askAboutImage(who, file(b), b.question));
  mediaRoute("/ai/media/extract", 15 * MB, MediaExtractBody, (ms, who, b) => ms.extractDocumentText(who, file(b)));
  mediaRoute("/ai/media/transcribe", 28 * MB, MediaTranscribeBody, (ms, who, b) => ms.transcribeAudio(who, file(b), b.language));

  r.get("/ai/capabilities", async (c) => {
    if (!can(c.get("role"), "ai.use", {})) return forbidden(c);
    const rows = await withContext(db, wctx(c), (tx) => tx.select().from(schema.aiProviderConfigs).where(and(eq(schema.aiProviderConfigs.workspaceId, c.get("workspaceId")), eq(schema.aiProviderConfigs.enabled, true))).orderBy(desc(schema.aiProviderConfigs.isDefault), asc(schema.aiProviderConfigs.id)));
    const providers = rows.flatMap((cfg) => {
      const def = providerDef(cfg.provider);
      if (!def) return [];
      return [{
        provider: cfg.provider, label: def.label, mock: def.mock, unverified: !def.mock, isDefault: cfg.isDefault, defaultModel: cfg.defaultModel,
        models: modelsFor(cfg.provider, (cfg.modelPrices ?? {}) as PriceOverrides).map((m) => ({ id: m.id, label: m.label, capabilities: [...m.capabilities], transcriptionMicroPerMinute: m.transcriptionMicroPerMinute ?? null })),
      }];
    });
    const has = (cap: string) => providers.some((p) => p.models.some((m) => (m.capabilities as string[]).includes(cap)));
    const out: AiCapabilities = { providers, available: { vision: has("vision"), ocr: has("document") || has("vision"), transcription: has("transcription") } };
    return c.json(out);
  });

  return r;
}
