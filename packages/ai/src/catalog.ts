import type { ModelPrice } from "./cost.ts";

export type ModelInfo = ModelPrice & { provider: string; id: string; label: string };

/**
 * Default model list and indicative prices (micro-USD per 1M tokens). UNVERIFIED: written from memory, not checked against the vendors' price pages.
 * They are data, not logic: a workspace overrides any price (or adds a model id) in its provider config, and that override always wins.
 */
export const DEFAULT_CATALOG: readonly ModelInfo[] = [
  { provider: "mock", id: "mock-1", label: "Mock model (no cost)", inputMicroPer1M: 0, outputMicroPer1M: 0 },
  { provider: "anthropic", id: "claude-sonnet-4-5", label: "Claude Sonnet 4.5", inputMicroPer1M: 3_000_000, outputMicroPer1M: 15_000_000 },
  { provider: "anthropic", id: "claude-haiku-4-5", label: "Claude Haiku 4.5", inputMicroPer1M: 1_000_000, outputMicroPer1M: 5_000_000 },
  { provider: "openai", id: "gpt-4o", label: "GPT-4o", inputMicroPer1M: 2_500_000, outputMicroPer1M: 10_000_000 },
  { provider: "openai", id: "gpt-4o-mini", label: "GPT-4o mini", inputMicroPer1M: 150_000, outputMicroPer1M: 600_000 },
];

export type PriceOverrides = Record<string, ModelPrice>;

export function modelsFor(provider: string, overrides: PriceOverrides = {}): ModelInfo[] {
  const base = DEFAULT_CATALOG.filter((m) => m.provider === provider).map((m) => ({ ...m, ...(overrides[m.id] ?? {}) }));
  const extra = Object.entries(overrides).filter(([id]) => !base.some((m) => m.id === id)).map(([id, p]): ModelInfo => ({ provider, id, label: id, ...p }));
  return [...base, ...extra];
}

/** Price for a model, or null when neither the catalog nor the workspace knows it (such a model cannot be chosen: a hard stop needs a price). */
export const priceOf = (provider: string, model: string, overrides: PriceOverrides = {}): ModelInfo | null => modelsFor(provider, overrides).find((m) => m.id === model) ?? null;
