/** Knowledge base limits. Shared by the API and the UI copy; numbers are documented in docs/architecture/ai-automation-architecture.md. */
export const KB_LIMITS = {
  maxSources: 200,
  /** Text kept per source (after normalising). About 1250 chunks of 800 characters, under maxChunksPerSource. */
  maxCharsPerSource: 1_000_000,
  maxChunksPerSource: 2000,
  /** Source text per workspace. Stored text plus chunks plus the search index is roughly 4x this on disk. */
  maxCharsPerWorkspace: 10_000_000,
  /** Raw upload or fetched page, in bytes. */
  maxFileBytes: 2 * 1024 * 1024,
} as const;

/** Stable, user-safe failure. `code` is also what the API returns and what is stored on a failed source (never any content). */
export class KnowledgeError extends Error {
  constructor(readonly code: KnowledgeErrorCode, message: string) {
    super(message);
    this.name = "KnowledgeError";
  }
}
export type KnowledgeErrorCode =
  | "unsupported_type" | "empty_content" | "too_large" | "too_many_chunks" | "invalid_encoding"
  | "unsupported_media" | "capability_not_configured" | "budget_exceeded" | "ai_unavailable" | "rate_limited"
  | "url_invalid" | "url_blocked" | "fetch_failed" | "fetch_timeout" | "fetch_status" | "too_many_redirects" | "unsupported_content_type";

/**
 * Turns extracted text into one clean form: well-formed Unicode (NFC), \n line ends, no control characters or NUL,
 * runs of spaces collapsed, at most one blank line in a row, trimmed.
 */
export function normalizeText(input: string): string {
  return input
    .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "\uFFFD") // lone surrogates cannot be stored in UTF-8
    .normalize("NFC")
    .replace(/\r\n?|\u2028|\u2029/g, "\n")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u200B\uFEFF]/g, "")
    .replace(/[^\S\n]+/g, " ")
    .split("\n").map((l) => l.trim()).join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Rough token count for budgeting: Latin text is about 4 characters per token, other scripts about 1 per character. Not a billing figure. */
export function estimateTokens(s: string): number {
  let ascii = 0;
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) < 128) ascii++;
  return Math.ceil(ascii / 4 + (s.length - ascii));
}
