import type { AiProvider } from "./types.ts";
import { createAnthropic } from "./providers/anthropic.ts";
import { createMockProvider } from "./providers/mock.ts";
import { createOpenAiCompatible } from "./providers/openai.ts";

export type ProviderOptions = { fetch?: typeof fetch; timeoutMs?: number; baseUrl?: string };
export type ProviderDef = {
  id: string;
  label: string;
  /** Mock providers need no key and never use the network; the UI labels them. */
  mock: boolean;
  /** Whether a workspace may point this provider at its own base URL (OpenAI-compatible servers). */
  customBaseUrl: boolean;
  create(o?: ProviderOptions): AiProvider;
};

/** Adding a provider = one adapter file + one line here (and its models in catalog.ts). */
export const PROVIDERS: Readonly<Record<string, ProviderDef>> = {
  mock: { id: "mock", label: "Mock (offline)", mock: true, customBaseUrl: false, create: () => createMockProvider() },
  anthropic: { id: "anthropic", label: "Anthropic", mock: false, customBaseUrl: false, create: (o) => createAnthropic({ ...o, baseUrl: undefined }) },
  openai: { id: "openai", label: "OpenAI-compatible", mock: false, customBaseUrl: true, create: (o) => createOpenAiCompatible(o) },
};

export const PROVIDER_IDS = Object.keys(PROVIDERS) as [string, ...string[]];
export const providerDef = (id: string): ProviderDef | null => (Object.hasOwn(PROVIDERS, id) ? PROVIDERS[id]! : null);
export function getProvider(id: string, o?: ProviderOptions): AiProvider {
  const d = providerDef(id);
  if (!d) throw new Error(`unknown ai provider: ${id}`);
  return d.create(o);
}
