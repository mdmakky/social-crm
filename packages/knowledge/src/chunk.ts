import { estimateTokens } from "./text.ts";

export type Chunk = { position: number; content: string; tokenEstimate: number };
export type ChunkOptions = { target?: number; overlap?: number; max?: number };
export const CHUNK_DEFAULTS = { target: 800, overlap: 100, max: 1200 } as const;

const TERMINATORS = new Set([".", "!", "?", "…", "।", "॥", "。", "！", "？"]); // . ! ? … । ॥ 。 ！ ？
const CJK_TERMINATORS = new Set(["。", "！", "？"]); // no space follows these, so they end a sentence on their own
const CLOSERS = new Set(['"', "'", ")", "]", "”", "’", "」", "』"]);

/** Splits one paragraph after sentence-ending punctuation (Latin, Bangla/Devanagari danda, CJK). Pieces keep their trailing whitespace so joining them restores the paragraph. */
function sentences(p: string): string[] {
  const out: string[] = [];
  let start = 0;
  for (let i = 0; i < p.length; i++) {
    if (!TERMINATORS.has(p[i]!)) continue;
    let j = i + 1;
    while (j < p.length && (TERMINATORS.has(p[j]!) || CLOSERS.has(p[j]!))) j++;
    if (j < p.length && !/\s/.test(p[j]!) && !CJK_TERMINATORS.has(p[i]!)) { i = j - 1; continue; } // "3.14", "e.g.x": not a sentence end
    while (j < p.length && /\s/.test(p[j]!)) j++;
    out.push(p.slice(start, j));
    start = j; i = j - 1;
  }
  if (start < p.length) out.push(p.slice(start));
  return out;
}

/** Cuts a piece longer than `size` at a space near the end when there is one, else at a code point boundary. */
function hardSplit(s: string, size: number): string[] {
  const out: string[] = [];
  let rest = s;
  while (rest.length > size) {
    let cut = rest.lastIndexOf(" ", size);
    if (cut < size * 0.6) cut = size;
    else cut += 1;
    if (cut < rest.length && /[\uDC00-\uDFFF]/.test(rest[cut]!)) cut -= 1; // never split a surrogate pair
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  if (rest) out.push(rest);
  return out;
}

/** The last ~`size` characters of a chunk, starting at a word boundary, used to open the next chunk. */
function tail(s: string, size: number): string {
  if (size <= 0 || s.length <= size) return size <= 0 ? "" : s;
  let from = s.length - size;
  const sp = s.indexOf(" ", from);
  if (sp !== -1 && sp < s.length - 1) from = sp + 1;
  else if (/[\uDC00-\uDFFF]/.test(s[from]!)) from += 1;
  return s.slice(from).trimStart();
}

/**
 * Deterministic chunker for normalised text (see normalizeText): same input and options, same chunks, same positions.
 * Paragraphs are kept together up to `target` characters; longer ones are cut at sentence ends, then at spaces, then anywhere.
 * Each chunk after the first starts with up to `overlap` characters of the previous one so an answer that straddles a boundary is still found.
 * No chunk is longer than `max` (target + overlap must fit).
 */
export function chunkText(text: string, opts: ChunkOptions = {}): Chunk[] {
  const { target, overlap, max } = { ...CHUNK_DEFAULTS, ...opts };
  if (overlap >= target || target + overlap > max) throw new RangeError("chunk options: overlap < target and target + overlap <= max");
  const units: string[] = [];
  for (const para of text.split(/\n{2,}/)) {
    const p = para.trim();
    if (!p) continue;
    const pieces = p.length <= target ? [p] : sentences(p).flatMap((s) => (s.length <= target ? [s] : hardSplit(s, target)));
    pieces.forEach((s, i) => units.push(i === pieces.length - 1 ? s.trimEnd() + "\n\n" : s));
  }
  const cores: string[] = [];
  let cur = "";
  for (const u of units) {
    if (cur && cur.length + u.length > target) { cores.push(cur.trimEnd()); cur = ""; }
    cur += u;
  }
  if (cur.trim()) cores.push(cur.trimEnd());
  return cores.map((core, position) => {
    const content = position === 0 ? core : (tail(cores[position - 1]!, overlap) + "\n" + core).trim();
    return { position, content, tokenEstimate: estimateTokens(content) };
  });
}
