import { z } from "zod";
import { endpoint } from "./endpoint.ts";
import { AiCapability } from "./ai-media.ts";

const W = "/v1/workspaces/:workspaceId";

/** Money is integer micro-units (1 000 000 = 1 currency unit). Never a float. */
const Micro = z.number().int().min(0).max(1_000_000_000_000_000);
const Supports = z.object({ tools: z.boolean(), structuredOutput: z.boolean() });
/**
 * A stored model price. The optional fields only matter for OpenRouter (models added from the browser): the server intersects them with the model list it fetched itself and drops
 * what it cannot confirm, so an added model without confirmed capabilities is text only.
 */
const Price = z.object({
  inputMicroPer1M: Micro, outputMicroPer1M: Micro,
  capabilities: z.array(AiCapability).max(4).optional(), contextLength: z.number().int().min(0).max(100_000_000).optional(), supports: Supports.optional(),
});

export const AiModelDto = z.object({
  id: z.string(), label: z.string(), inputMicroPer1M: Micro, outputMicroPer1M: Micro,
  capabilities: z.array(AiCapability).optional(), contextLength: z.number().int().optional(), supports: Supports.optional(),
});
export type AiModelDto = z.infer<typeof AiModelDto>;

/** One provider as the workspace sees it: the registry entry plus this workspace's config. The API key is never part of any response; only its last four characters. */
export const AiProviderDto = z.object({
  id: z.string(), label: z.string(), mock: z.boolean(), customBaseUrl: z.boolean(), models: z.array(AiModelDto),
  configured: z.boolean(), enabled: z.boolean(), isDefault: z.boolean(), defaultModel: z.string().nullable(), keyLast4: z.string().nullable(), baseUrl: z.string().nullable(),
  modelPrices: z.record(z.string(), Price),
  /** When the last REAL call through this provider succeeded (a workspace run that ended ok). Null = never proven. */
  lastOkAt: z.string().nullable(),
});
export type AiProviderDto = z.infer<typeof AiProviderDto>;
export const AiProviderList = z.object({ items: z.array(AiProviderDto) });

/** The key is write-only: sent here, sealed on the server, never returned. Omit it to keep the stored one. The mock provider takes none. */
export const SetAiProviderBody = z.object({
  apiKey: z.string().min(8).max(500).regex(/^\S+$/, "Paste the whole key, with no spaces.").optional(),
  baseUrl: z.string().url().max(300).startsWith("https://", "The URL must start with https://").nullable().optional(),
  defaultModel: z.string().trim().min(1).max(100).optional(),
  enabled: z.boolean().optional(),
  isDefault: z.boolean().optional(),
  /** At most 50 entries here; every provider except OpenRouter is held to 20 by the route. */
  modelPrices: z.record(z.string().trim().min(1).max(100), Price).refine((o) => Object.keys(o).length <= 50, "At most 50 models").optional(),
});
export type SetAiProviderBody = z.infer<typeof SetAiProviderBody>;

export const AiProviderTestResult = z.object({ ok: z.literal(true), model: z.string(), latencyMs: z.number().int(), mock: z.boolean() });
export type AiProviderTestResult = z.infer<typeof AiProviderTestResult>;

/** OpenRouter model browser (read only). `syncedAt` = when the server fetched the list; `unverified` is always true: the list shape is documented, never recorded against the live service. */
export const OpenRouterModelDto = z.object({
  id: z.string(), name: z.string(), contextLength: z.number().int().nullable(), inputMicroPer1M: Micro, outputMicroPer1M: Micro,
  capabilities: z.array(AiCapability), supports: Supports,
});
export type OpenRouterModelDto = z.infer<typeof OpenRouterModelDto>;
export const OpenRouterModelList = z.object({ items: z.array(OpenRouterModelDto), syncedAt: z.string(), mock: z.boolean(), unverified: z.boolean() });
export type OpenRouterModelList = z.infer<typeof OpenRouterModelList>;

export const AiPromptVersion = z.object({ version: z.number().int(), template: z.string(), active: z.boolean(), createdAt: z.string(), createdBy: z.string().nullable() });
export const AiPromptDto = z.object({
  key: z.string(), label: z.string(), variables: z.array(z.string()), defaultTemplate: z.string(),
  /** 0 = the built-in default is in use. */
  activeVersion: z.number().int(), versions: z.array(AiPromptVersion),
});
export type AiPromptDto = z.infer<typeof AiPromptDto>;
export const AiPromptList = z.object({ items: z.array(AiPromptDto) });
export const SetAiPromptBody = z.object({ template: z.string().trim().min(1, "Write the prompt first").max(4000) });
export const ActivateAiPromptBody = z.object({ version: z.number().int().min(0) });

export const AiBudgetDto = z.object({ monthlyCapMicro: Micro.nullable(), hardStop: z.boolean() });
export type AiBudgetDto = z.infer<typeof AiBudgetDto>;
export const SetAiBudgetBody = AiBudgetDto;

export const AiUsageQuery = z.object({ days: z.coerce.number().int().min(1).max(90).optional() });
export const AiUsageDto = z.object({
  month: z.object({ start: z.string(), usedMicro: Micro, inputTokens: z.number().int(), outputTokens: z.number().int(), runs: z.number().int(), blockedRuns: z.number().int(), capMicro: Micro.nullable(), hardStop: z.boolean(), blocked: z.boolean() }),
  byDay: z.array(z.object({ day: z.string(), capability: z.string(), runs: z.number().int(), errors: z.number().int(), blocked: z.number().int(), inputTokens: z.number().int(), outputTokens: z.number().int(), costMicro: Micro })),
});
export type AiUsageDto = z.infer<typeof AiUsageDto>;

/** For the composer: is a provider ready for this workspace. No key, no price. */
export const AiStatusDto = z.object({ ready: z.boolean(), provider: z.string().nullable(), model: z.string().nullable(), mock: z.boolean() });
export type AiStatusDto = z.infer<typeof AiStatusDto>;

/** A draft only. Nothing is sent: the person edits it and sends it through the normal composer. */
export const SuggestReplyResult = z.object({ draft: z.string(), provider: z.string(), model: z.string(), mock: z.boolean(), runId: z.string() });
export type SuggestReplyResult = z.infer<typeof SuggestReplyResult>;

/**
 * The jobs the AI does and the ability each needs. A workspace may pin one model per job; without a pin the server picks automatically
 * (text jobs: the default provider's default model; media jobs: the default model if it can, else the first enabled model that can).
 */
export const AI_JOBS = {
  reply: { label: "Reply suggestions in the inbox", needs: "text" },
  agent: { label: "Agent notes and proposed actions", needs: "text" },
  vision: { label: "Read images customers send", needs: "vision" },
  document: { label: "Read PDFs and documents for Knowledge", needs: "document" },
  transcription: { label: "Turn voice messages into text", needs: "transcription" },
} as const;
export type AiJobKey = keyof typeof AI_JOBS;
export const AiJobSchema = z.enum(Object.keys(AI_JOBS) as [AiJobKey, ...AiJobKey[]]);

/** One job as the workspace sees it. `pinned` is what a person chose; `effective` is what a call would use right now (null = nothing can do this job yet); `problem` explains a pin that no longer works. */
export const AiJobModelDto = z.object({
  job: AiJobSchema,
  pinned: z.object({ provider: z.string(), model: z.string() }).nullable(),
  effective: z.object({ provider: z.string(), model: z.string(), automatic: z.boolean() }).nullable(),
  problem: z.string().nullable(),
});
export type AiJobModelDto = z.infer<typeof AiJobModelDto>;
export const AiJobModelList = z.object({ items: z.array(AiJobModelDto) });
export const SetAiJobModelBody = z.object({ provider: z.string().trim().min(1).max(40), model: z.string().trim().min(1).max(100) });
export type SetAiJobModelBody = z.infer<typeof SetAiJobModelBody>;

export const aiEndpoints = {
  listAiProviders: endpoint({ method: "GET", path: `${W}/ai/providers`, response: AiProviderList }),
  setAiProvider: endpoint({ method: "PUT", path: `${W}/ai/providers/:provider`, body: SetAiProviderBody, response: AiProviderDto }),
  /** Sends ONE tiny real request through the provider (and its default model) and reports whether it worked. Recorded as a run, so it counts against the budget. */
  testAiProvider: endpoint({ method: "POST", path: `${W}/ai/providers/:provider/test`, response: AiProviderTestResult }),
  listOpenRouterModels: endpoint({ method: "GET", path: `${W}/ai/providers/openrouter/models`, response: OpenRouterModelList }),
  listAiPrompts: endpoint({ method: "GET", path: `${W}/ai/prompts`, response: AiPromptList }),
  setAiPrompt: endpoint({ method: "PUT", path: `${W}/ai/prompts/:key`, body: SetAiPromptBody, response: AiPromptDto }),
  activateAiPrompt: endpoint({ method: "POST", path: `${W}/ai/prompts/:key/activate`, body: ActivateAiPromptBody, response: AiPromptDto }),
  getAiBudget: endpoint({ method: "GET", path: `${W}/ai/budget`, response: AiBudgetDto }),
  setAiBudget: endpoint({ method: "PUT", path: `${W}/ai/budget`, body: SetAiBudgetBody, response: AiBudgetDto }),
  getAiUsage: endpoint({ method: "GET", path: `${W}/ai/usage`, query: AiUsageQuery, response: AiUsageDto }),
  listAiJobModels: endpoint({ method: "GET", path: `${W}/ai/jobs`, response: AiJobModelList }),
  setAiJobModel: endpoint({ method: "PUT", path: `${W}/ai/jobs/:job`, body: SetAiJobModelBody, response: AiJobModelDto }),
  clearAiJobModel: endpoint({ method: "DELETE", path: `${W}/ai/jobs/:job`, response: AiJobModelDto }),
  getAiStatus: endpoint({ method: "GET", path: `${W}/ai/status`, response: AiStatusDto }),
  suggestReply: endpoint({ method: "POST", path: `${W}/conversations/:conversationId/ai/suggest-reply`, response: SuggestReplyResult }),
  /** Server-Sent Events (text/event-stream): `delta` {text}, `usage`, `done`, or one `error` {code, message, status}. The web client reads it with fetch; the declared response is the raw text. */
  suggestReplyStream: endpoint({ method: "POST", path: `${W}/conversations/:conversationId/ai/suggest-reply/stream`, response: z.string(), responseType: "text" }),
} as const;
