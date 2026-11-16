import type { ModelPrice } from "./cost.ts";
import type { Capability } from "./types.ts";

/** `capabilities` and `transcriptionMicroPerMinute` (integer micro-units per minute of audio) are catalog data, UNVERIFIED like the prices. */
export type ModelInfo = ModelPrice & { provider: string; id: string; label: string; capabilities: readonly Capability[]; transcriptionMicroPerMinute?: number; contextLength?: number; supports?: { tools: boolean; structuredOutput: boolean } };

/**
 * What a workspace stores per model id. Prices are always read from it. `capabilities`, `contextLength` and `supports` are honoured only for model ids ADDED by the workspace (not catalog ones),
 * and the API only stores them for OpenRouter, after intersecting with the model list it fetched itself. Absent capabilities = text only.
 */
export type StoredModel = ModelPrice & { capabilities?: Capability[]; contextLength?: number; supports?: { tools: boolean; structuredOutput: boolean } };
export const CAPABILITIES: readonly Capability[] = ["text", "vision", "transcription", "document"];

/**
 * Default model list and indicative prices (micro-USD per 1M tokens). UNVERIFIED: written from memory, not checked against the vendors' price pages.
 * Capability flags (text, vision, document, transcription) are UNVERIFIED too: from memory, never confirmed against a live service.
 * They are data, not logic: a workspace overrides any price (or adds a model id) in its provider config, and that override always wins. A model id added that way is text-only.
 */
export const DEFAULT_CATALOG: readonly ModelInfo[] = [
  { provider: "mock", id: "mock-1", label: "Mock model (no cost)", inputMicroPer1M: 0, outputMicroPer1M: 0, capabilities: ["text", "vision", "transcription", "document"], supports: { tools: true, structuredOutput: true } },
  { provider: "anthropic", id: "claude-sonnet-4-5", label: "Claude Sonnet 4.5", inputMicroPer1M: 3_000_000, outputMicroPer1M: 15_000_000, capabilities: ["text", "vision", "document"] },
  { provider: "anthropic", id: "claude-haiku-4-5", label: "Claude Haiku 4.5", inputMicroPer1M: 1_000_000, outputMicroPer1M: 5_000_000, capabilities: ["text", "vision", "document"] },
  { provider: "openai", id: "gpt-4o", label: "GPT-4o", inputMicroPer1M: 2_500_000, outputMicroPer1M: 10_000_000, capabilities: ["text", "vision"] },
  { provider: "openai", id: "gpt-4o-mini", label: "GPT-4o mini", inputMicroPer1M: 150_000, outputMicroPer1M: 600_000, capabilities: ["text", "vision"] },
  { provider: "openai", id: "whisper-1", label: "Whisper (speech to text)", inputMicroPer1M: 0, outputMicroPer1M: 0, capabilities: ["transcription"], transcriptionMicroPerMinute: 6_000 },
];

export type PriceOverrides = Record<string, StoredModel>;

export function modelsFor(provider: string, overrides: PriceOverrides = {}): ModelInfo[] {
  const base = DEFAULT_CATALOG.filter((m) => m.provider === provider).map((m) => { const o = overrides[m.id]; return o ? { ...m, inputMicroPer1M: o.inputMicroPer1M, outputMicroPer1M: o.outputMicroPer1M } : m; });
  const extra = Object.entries(overrides).filter(([id]) => !base.some((m) => m.id === id)).map(([id, p]): ModelInfo => ({
    provider, id, label: id, inputMicroPer1M: p.inputMicroPer1M, outputMicroPer1M: p.outputMicroPer1M,
    capabilities: ["text", ...(p.capabilities ?? []).filter((c, i, a) => c !== "text" && CAPABILITIES.includes(c) && a.indexOf(c) === i)],
    ...(p.contextLength ? { contextLength: p.contextLength } : {}), ...(p.supports ? { supports: p.supports } : {}),
  }));
  return [...base, ...extra];
}

/** Price for a model, or null when neither the catalog nor the workspace knows it (such a model cannot be chosen: a hard stop needs a price). */
export const priceOf = (provider: string, model: string, overrides: PriceOverrides = {}): ModelInfo | null => modelsFor(provider, overrides).find((m) => m.id === model) ?? null;

/** Does this provider+model claim the capability. Unknown models support nothing. */
export const supports = (provider: string, model: string, capability: Capability, overrides: PriceOverrides = {}): boolean => priceOf(provider, model, overrides)?.capabilities.includes(capability) ?? false;

/** Model for the first wanted capability: the workspace default if it qualifies, else the first catalog model that does. `via` is the capability that matched. */
export function pickModel(provider: string, defaultModel: string | null, needs: readonly Capability[], overrides: PriceOverrides = {}): { model: ModelInfo; via: Capability } | null {
  const all = modelsFor(provider, overrides);
  for (const via of needs) {
    const m = all.find((x) => x.id === defaultModel && x.capabilities.includes(via)) ?? all.find((x) => x.capabilities.includes(via));
    if (m) return { model: m, via };
  }
  return null;
}

/**
 * Capability gates for native tool calling and structured output. Read ONLY from the stored flags (OpenRouter `supported_parameters`, confirmed by the server when the model was enabled).
 * Catalog models of other providers carry no flags, so they are false: the JSON-in-text protocol and prompt-based JSON stay in use for them. Unknown model => false.
 */
export const supportsTools = (provider: string, model: string, overrides: PriceOverrides = {}): boolean => priceOf(provider, model, overrides)?.supports?.tools === true;
export const supportsStructuredOutput = (provider: string, model: string, overrides: PriceOverrides = {}): boolean => priceOf(provider, model, overrides)?.supports?.structuredOutput === true;
