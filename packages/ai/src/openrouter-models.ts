import { z } from "zod";
import type { Capability } from "./types.ts";

/** One model from the OpenRouter public list, trimmed to what the workspace needs. Prices are integer micro-USD per 1M tokens. */
export type BrowseModel = {
  id: string; name: string; contextLength: number | null; inputMicroPer1M: number; outputMicroPer1M: number;
  capabilities: Capability[]; supports: { tools: boolean; structuredOutput: boolean };
};

const MAX_MICRO = 1_000_000_000_000_000;
export const MAX_BROWSE_MODELS = 600;

/**
 * USD per token as a decimal string ("0.000003") to micro-USD per 1M tokens, with exact decimal-string arithmetic (value x 10^12), rounded UP.
 * Only plain non-negative decimals are accepted: signs, exponents, NaN, empty and sentinel values give null (the model is refused).
 */
export function pricePerTokenToMicroPer1M(raw: unknown): number | null {
  if (typeof raw !== "string" || !/^\d{1,12}(\.\d{1,30})?$/.test(raw)) return null;
  const [whole, frac = ""] = raw.split(".");
  const kept = frac.slice(0, 12).padEnd(12, "0");
  let v = BigInt(whole! + kept);
  if (/[1-9]/.test(frac.slice(12))) v += 1n;
  return v <= BigInt(MAX_MICRO) ? Number(v) : null;
}

const Item = z.object({
  id: z.string().min(1).max(100),
  name: z.string().max(200).optional(),
  context_length: z.number().nullish(),
  pricing: z.object({ prompt: z.unknown(), completion: z.unknown() }).passthrough(),
  architecture: z.object({ input_modalities: z.array(z.string()).nullish() }).passthrough().nullish(),
  supported_parameters: z.array(z.string()).nullish(),
}).passthrough();
const Reply = z.object({ data: z.array(z.unknown()) });

/**
 * Strict parse of GET /api/v1/models. A malformed document throws; a malformed or unsafe ITEM is skipped (missing, sentinel, negative or non-numeric price; router aliases `openrouter/...`).
 * Capabilities: text always; vision only when architecture.input_modalities lists "image" (absent = text only, UNVERIFIED field); tools and structuredOutput from supported_parameters.
 */
export function parseOpenRouterModels(json: unknown): BrowseModel[] {
  const doc = Reply.parse(json);
  const out: BrowseModel[] = [];
  for (const raw of doc.data) {
    const p = Item.safeParse(raw);
    if (!p.success) continue;
    const m = p.data;
    // `:batch` variants are answered only by OpenRouter's batch API; chat/completions refuses them with a 404, so they can never work here.
    if (m.id.startsWith("openrouter/") || m.id.endsWith(":batch") || !/^[\w.:~@+-]+(\/[\w.:~@+-]+)+$/.test(m.id)) continue;
    const input = pricePerTokenToMicroPer1M(m.pricing.prompt);
    const output = pricePerTokenToMicroPer1M(m.pricing.completion);
    if (input === null || output === null) continue;
    const params = new Set(m.supported_parameters ?? []);
    const ctx = typeof m.context_length === "number" && Number.isSafeInteger(m.context_length) && m.context_length > 0 ? m.context_length : null;
    out.push({
      id: m.id, name: (m.name ?? m.id).slice(0, 200), contextLength: ctx, inputMicroPer1M: input, outputMicroPer1M: output,
      capabilities: m.architecture?.input_modalities?.includes("image") ? ["text", "vision"] : ["text"],
      supports: { tools: params.has("tools"), structuredOutput: params.has("structured_outputs") },
    });
    if (out.length >= MAX_BROWSE_MODELS) break;
  }
  return out;
}
