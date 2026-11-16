import { normalizeText } from "./text.ts";

/** Elements whose content is never page text. Removed with everything inside (up to the first closing tag; nesting is not tracked). */
const SKIP = new Set(["script", "style", "noscript", "template", "svg", "iframe", "nav", "footer", "aside", "form", "select", "button", "canvas", "object", "embed"]);
const BLOCK = new Set(["p", "div", "br", "li", "tr", "section", "article", "main", "ul", "ol", "table", "pre", "blockquote", "hr", "dl", "dt", "dd", "figure", "figcaption", "details", "summary", "address"]);
const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "–", mdash: "—", hellip: "…", copy: "©", laquo: "«", raquo: "»" };

const decode = (s: string) =>
  s.replace(/&(#x[0-9a-f]{1,6}|#[0-9]{1,7}|[a-z]{2,8});/gi, (m, e: string) => {
    if (e[0] === "#") {
      const cp = e[1]!.toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return cp > 0 && cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff) ? String.fromCodePoint(cp) : "";
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });

/**
 * Readable text from an HTML document: headings become "# Title" lines, block elements become line breaks, list items become "- item".
 * One linear pass (no backtracking regexes), so hostile pages cannot stall it. Not a validating parser: attribute values containing ">" end a tag early,
 * which only loses a few characters of text.
 */
export function htmlToText(html: string): { title: string | null; text: string } {
  let out = "";
  let title: string | null = null;
  const findClose = (name: string, from: number) => { const re = new RegExp(`</${name}`, "gi"); re.lastIndex = from; return re.exec(html)?.index ?? -1; };
  const n = html.length;
  let i = 0;
  while (i < n) {
    const lt = html.indexOf("<", i);
    if (lt === -1) { out += html.slice(i); break; }
    out += html.slice(i, lt);
    if (html.startsWith("<!--", lt)) { const e = html.indexOf("-->", lt + 4); i = e === -1 ? n : e + 3; continue; }
    const m = /^<(\/?)([a-z][a-z0-9-]*)/i.exec(html.slice(lt, lt + 40));
    if (!m) { // "<!doctype", "<?xml", or a literal "<"
      if (html[lt + 1] === "!" || html[lt + 1] === "?") { const e = html.indexOf(">", lt); i = e === -1 ? n : e + 1; } else { out += "<"; i = lt + 1; }
      continue;
    }
    const closing = m[1] === "/";
    const name = m[2]!.toLowerCase();
    const end = html.indexOf(">", lt);
    if (end === -1) break; // unterminated tag: drop the rest
    i = end + 1;
    if (name === "title" && !closing) { // the title is returned separately, not as page text
      const c = findClose("title", i);
      if (title === null) title = normalizeText(decode(html.slice(i, c === -1 ? Math.min(n, i + 300) : c))).slice(0, 200) || null;
      i = c === -1 ? n : (html.indexOf(">", c) + 1 || n);
      continue;
    }
    if (!closing && SKIP.has(name)) {
      if (html[end - 1] === "/") continue;
      const c = findClose(name, i);
      if (c === -1) break;
      const ce = html.indexOf(">", c);
      i = ce === -1 ? n : ce + 1;
      continue;
    }
    if (/^h[1-6]$/.test(name)) out += closing ? "\n\n" : `\n\n${"#".repeat(Number(name[1]))} `;
    else if (name === "li") out += closing ? "" : "\n- ";
    else if (BLOCK.has(name)) out += "\n";
    else if (name === "td" || name === "th") out += " ";
  }
  return { title, text: normalizeText(decode(out)) };
}
