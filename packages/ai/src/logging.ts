import { createHash } from "node:crypto";
import { AiError } from "./types.ts";

/** Short stable fingerprint for dedupe and debugging without keeping the text. */
export const fingerprint = (text: string): string => createHash("sha256").update(text).digest("hex").slice(0, 16);

/** What a run row may keep about a prompt or reply: sizes and a fingerprint, never content. */
export const describeText = (text: string) => ({ chars: text.length, hash: fingerprint(text) });

const PATTERNS: [RegExp, string][] = [
  [/\b(?:sk|pk|rk)-[A-Za-z0-9_-]{8,}/g, "[key]"],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, "Bearer [key]"],
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[email]"],
  [/\+?\d[\d\s().-]{7,}\d/g, "[number]"],
];
/** Best-effort masking for the rare place text must be logged. Not a guarantee: the rule is still never to log prompts or replies. */
export function redact(text: string, max = 80): string {
  let out = text;
  for (const [re, to] of PATTERNS) out = out.replace(re, to);
  return out.length > max ? `${out.slice(0, max)}...` : out;
}

/** Log-safe view of any thrown value: class name and provider code only (never the message, which could echo input). */
export function safeError(e: unknown): { name: string; code?: string; status?: number } {
  if (e instanceof AiError) return { name: e.name, code: e.code, ...(e.status ? { status: e.status } : {}) };
  return { name: e instanceof Error ? e.name : "unknown" };
}
