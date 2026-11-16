/** Money is integer micro-units (1 000 000 = 1 currency unit), the same as the API. Strings in, strings out: no floats. */
export function formatMicro(micro: number): string {
  const s = String(Math.abs(micro)).padStart(7, "0");
  const frac = s.slice(-6).replace(/0+$/, "").padEnd(2, "0");
  return `${micro < 0 ? "-" : ""}${s.slice(0, -6)}.${frac}`;
}

/** "12.5" -> 12_500_000. Null when it is not a plain non-negative decimal with at most 6 decimals. */
export function parseMicro(text: string): number | null {
  const m = /^(\d{1,9})(?:\.(\d{1,6}))?$/.exec(text.trim());
  return m ? Number(m[1]) * 1_000_000 + Number((m[2] ?? "").padEnd(6, "0")) : null;
}
