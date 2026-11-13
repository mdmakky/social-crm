import { describe, expect, it } from "vitest";
import { semantic } from "../src/tokens.ts";

const lin = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const lum = (hex: string) => {
  const n = parseInt(hex.slice(1), 16);
  return 0.2126 * lin(((n >> 16) & 255) / 255) + 0.7152 * lin(((n >> 8) & 255) / 255) + 0.0722 * lin((n & 255) / 255);
};
const ratio = (a: string, b: string) => {
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
};

type T = (typeof semantic)["light"];
// [foreground, background, minimum ratio]: text 4.5, large/UI 3
const PAIRS: [keyof T, keyof T, number][] = [
  ["fg", "bg-surface", 4.5], ["fg", "bg-canvas", 4.5], ["fg", "bg-hover", 4.5], ["fg", "bg-selected", 4.5],
  ["fg-muted", "bg-surface", 4.5], ["fg-muted", "bg-canvas", 4.5], ["fg-muted", "bg-hover", 4.5],
  ["fg-subtle", "bg-surface", 4.5], ["fg-subtle", "bg-canvas", 4.5],
  ["on-accent", "accent", 4.5], ["on-accent", "accent-hover", 4.5],
  ["accent-fg", "bg-surface", 4.5], ["accent-fg", "accent-subtle", 4.5], ["accent-fg", "bg-canvas", 4.5],
  ["success-fg", "success-bg", 4.5], ["warning-fg", "warning-bg", 4.5], ["danger-fg", "danger-bg", 4.5],
  ["danger", "bg-surface", 4.5],
  ["focus", "bg-surface", 3], ["focus", "bg-canvas", 3], ["line-strong", "bg-surface", 1.4],
];

for (const theme of ["light", "dark"] as const) {
  describe(`${theme} theme contrast (WCAG 2.2 AA)`, () => {
    for (const [fg, bg, min] of PAIRS) {
      it(`${fg} on ${bg} >= ${min}:1`, () => {
        const t = semantic[theme] as T;
        expect(ratio(t[fg], t[bg])).toBeGreaterThanOrEqual(min);
      });
    }
  });
}
