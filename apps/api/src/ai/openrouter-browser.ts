import { createMockProvider, parseOpenRouterModels, OPENROUTER_BASE_URL, type AiProvider, type BrowseModel } from "@crm/ai";

export type ModelList = { items: BrowseModel[]; syncedAt: string };
export type ModelBrowser = {
  /** Cached list, or a fresh fetch. Throws when the service cannot be reached or answers with something unreadable. Never called inside a database transaction. */
  list(): Promise<ModelList>;
  /** What is cached right now (no network), or null. Used to confirm capabilities on save. */
  peek(): ModelList | null;
  mock: boolean;
};

/**
 * The public OpenRouter model list (GET /api/v1/models), fetched with NO API key and a timeout, parsed strictly and cached in-process.
 * UNVERIFIED: the endpoint is documented as public; if it ever needs a key, fetching fails and the browser reports it (no fallback to a workspace key is built).
 * `fetch` is injectable so tests and the mock environment never touch the network. ponytail: cache is per process; share it (or the database) before running several API instances.
 */
export function createModelBrowser(o: { fetch?: typeof fetch; ttlMs?: number; timeoutMs?: number; now?: () => number; mock?: boolean } = {}): ModelBrowser {
  const now = o.now ?? Date.now;
  const ttl = o.ttlMs ?? 10 * 60_000;
  let cache: { at: number; list: ModelList } | null = null;
  let inflight: Promise<ModelList> | null = null;
  const fresh = () => (cache && now() - cache.at < ttl ? cache.list : null);
  async function load(): Promise<ModelList> {
    const res = await (o.fetch ?? fetch)(`${OPENROUTER_BASE_URL}/models`, { method: "GET", headers: { accept: "application/json" }, signal: AbortSignal.timeout(o.timeoutMs ?? 10_000) });
    if (!res.ok) throw new Error(`openrouter models: ${res.status}`);
    const items = parseOpenRouterModels(await res.json());
    const list = { items, syncedAt: new Date(now()).toISOString() };
    cache = { at: now(), list };
    return list;
  }
  return {
    mock: !!o.mock,
    peek: () => fresh(),
    async list() {
      const hit = fresh();
      if (hit) return hit;
      inflight ??= load().finally(() => { inflight = null; });
      return inflight;
    },
  };
}

/** Deterministic list in the documented OpenRouter shape, for OPENROUTER_MOCK=1 and tests. Never the real network. */
export const MOCK_OPENROUTER_MODELS = {
  data: [
    { id: "mockvendor/alpha-chat", name: "Mock Alpha Chat", context_length: 128000, pricing: { prompt: "0.000003", completion: "0.000015" }, architecture: { input_modalities: ["text", "image"] }, supported_parameters: ["tools", "tool_choice", "structured_outputs", "response_format"] },
    { id: "mockvendor/beta-mini", name: "Mock Beta Mini", context_length: 32000, pricing: { prompt: "0.0000001", completion: "0.0000004" }, architecture: { input_modalities: ["text"] }, supported_parameters: ["tools"] },
    { id: "mockvendor/gamma-text", name: "Mock Gamma Text", context_length: 8000, pricing: { prompt: "0.000001", completion: "0.000002" }, supported_parameters: [] },
    { id: "openrouter/auto", name: "Auto Router", context_length: 2000000, pricing: { prompt: "-1", completion: "-1" } },
    { id: "mockvendor/broken-price", name: "Broken price", pricing: { prompt: "NaN", completion: "0.000001" } },
  ],
};
/** OPENROUTER_MOCK=1 only: the mock provider under the `openrouter` id, with labelled output, a routed model and a reported cost. Offline, deterministic. */
export function mockOpenRouterProvider(): AiProvider {
  const base = createMockProvider();
  return {
    ...base, id: "openrouter",
    async generate(req) {
      const g = await base.generate(req);
      return { ...g, text: g.text.replace("[MOCK DRAFT]", "[MOCK OPENROUTER DRAFT]"), usage: { ...g.usage, reportedCostMicro: 1 }, routedModel: req.model };
    },
  };
}
export const mockModelsFetch =(async () => new Response(JSON.stringify(MOCK_OPENROUTER_MODELS), { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
