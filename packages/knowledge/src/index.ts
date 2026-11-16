import { chunkText, type Chunk } from "./chunk.ts";
import { KB_LIMITS, KnowledgeError, normalizeText } from "./text.ts";

export * from "./text.ts";
export * from "./chunk.ts";
export * from "./html.ts";
export * from "./extract.ts";
export * from "./ssrf.ts";

/** Normalised text to chunks, enforcing the per-source limits. */
export function prepareSource(rawText: string): { text: string; chunks: Chunk[] } {
  const text = normalizeText(rawText);
  if (!text) throw new KnowledgeError("empty_content", "There is no text to add.");
  if (text.length > KB_LIMITS.maxCharsPerSource) throw new KnowledgeError("too_large", `The text is longer than ${KB_LIMITS.maxCharsPerSource.toLocaleString("en-US")} characters.`);
  const chunks = chunkText(text);
  if (chunks.length > KB_LIMITS.maxChunksPerSource) throw new KnowledgeError("too_many_chunks", "The text is too long to index.");
  return { text, chunks };
}
