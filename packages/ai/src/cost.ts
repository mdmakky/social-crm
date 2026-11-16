/** Money is integer micro-units (1 000 000 = 1 currency unit). Prices are micro-units per 1 million tokens. No floats anywhere. */
export type ModelPrice = { inputMicroPer1M: number; outputMicroPer1M: number };

/** Cost of one call in micro-units, rounded UP to a whole micro-unit so many tiny calls can never under-count. */
/** Per-minute pricing (transcription): integer micro-units per minute, the call rounded UP to a whole micro-unit like token costs. */
export function perMinuteCostMicro(microPerMinute: number, seconds: number): number {
  for (const n of [microPerMinute, seconds]) if (!Number.isSafeInteger(n) || n < 0) throw new RangeError("cost inputs must be non-negative integers");
  return Number((BigInt(microPerMinute) * BigInt(seconds) + 59n) / 60n);
}

export function costMicro(price: ModelPrice, usage: { inputTokens: number; outputTokens: number }): number {
  for (const n of [price.inputMicroPer1M, price.outputMicroPer1M, usage.inputTokens, usage.outputTokens]) {
    if (!Number.isSafeInteger(n) || n < 0) throw new RangeError("cost inputs must be non-negative integers");
  }
  const total = BigInt(price.inputMicroPer1M) * BigInt(usage.inputTokens) + BigInt(price.outputMicroPer1M) * BigInt(usage.outputTokens);
  const out = (total + 999_999n) / 1_000_000n;
  if (out > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError("cost overflow");
  return Number(out);
}
