const EMOJI_START = /^[\p{Extended_Pictographic}\p{Regional_Indicator}]/u;
const graphemes = typeof Intl !== "undefined" && "Segmenter" in Intl ? new Intl.Segmenter(undefined, { granularity: "grapheme" }) : null;

/**
 * The first character of a word for an avatar. A plain letter is one code point, as before (indexing with [0] would return half of an emoji: a lone surrogate, drawn as a replacement
 * character). An emoji is kept whole with its skin tone, variation selector, ZWJ sequence or flag pair.
 */
function firstChar(word: string): string {
  const cp = Array.from(word)[0] ?? "";
  if (!EMOJI_START.test(cp)) return cp;
  return graphemes?.segment(word)[Symbol.iterator]().next().value?.segment ?? cp;
}

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  return (firstChar(parts[0]!) + (parts.length > 1 ? firstChar(parts[parts.length - 1]!) : "")).toUpperCase();
}
