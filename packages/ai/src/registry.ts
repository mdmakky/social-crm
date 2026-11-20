import type { AiProvider } from "./types.ts";
import { createAnthropic } from "./providers/anthropic.ts";
import { createGemini } from "./providers/gemini.ts";
import { createMockProvider } from "./providers/mock.ts";
import { createOpenAiCompatible } from "./providers/openai.ts";

/** `referer` and `title` become OpenRouter's optional HTTP-Referer and X-OpenRouter-Title attribution headers. */
export type ProviderOptions = { fetch?: typeof fetch; timeoutMs?: number; baseUrl?: string; referer?: string; title?: string };
/** Fixed: a workspace can never point the OpenRouter provider elsewhere (customBaseUrl is false). */
export const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
export type ProviderDef = {
  id: string;
  label: string;
  /** Mock providers need no key and never use the network; the UI labels them. */
  mock: boolean;
  /** Whether a workspace may point this provider at its own base URL (OpenAI-compatible servers). */
  customBaseUrl: boolean;
  /** Server environment variable that supplies a key when the workspace stored none (an operator-wide key). Only providers that name one accept it. */
  envKey?: string;
  create(o?: ProviderOptions): AiProvider;
};

/** Adding a provider = one adapter file + one line here (and its models in catalog.ts). */
export const PROVIDERS: Readonly<Record<string, ProviderDef>> = {
  mock: { id: "mock", label: "Mock (offline)", mock: true, customBaseUrl: false, create: () => createMockProvider() },
  anthropic: { id: "anthropic", label: "Anthropic", mock: false, customBaseUrl: false, create: (o) => createAnthropic({ ...o, baseUrl: undefined }) },
  openai: { id: "openai", label: "OpenAI-compatible", mock: false, customBaseUrl: true, create: (o) => createOpenAiCompatible(o) },
  /** Speech to text only (no chat), so it never becomes the default provider for replies or agents. */
  gemini: { id: "gemini", label: "Google Gemini (voice to text)", mock: false, customBaseUrl: false, envKey: "GEMINI_API_KEY", create: (o) => createGemini({ fetch: o?.fetch, timeoutMs: o?.timeoutMs }) },
  openrouter: {
    id: "openrouter", label: "OpenRouter", mock: false, customBaseUrl: false,
    create: (o) => createOpenAiCompatible({ fetch: o?.fetch, timeoutMs: o?.timeoutMs, baseUrl: OPENROUTER_BASE_URL, id: "openrouter", gateway: true, extraHeaders: { ...(o?.referer ? { "HTTP-Referer": o.referer } : {}), ...(o?.title ? { "X-OpenRouter-Title": o.title } : {}) } }),
  },
};

export const PROVIDER_IDS = Object.keys(PROVIDERS) as [string, ...string[]];
export const providerDef = (id: string): ProviderDef | null => (Object.hasOwn(PROVIDERS, id) ? PROVIDERS[id]! : null);
export function getProvider(id: string, o?: ProviderOptions): AiProvider {
  const d = providerDef(id);
  if (!d) throw new Error(`unknown ai provider: ${id}`);
  return d.create(o);
}
