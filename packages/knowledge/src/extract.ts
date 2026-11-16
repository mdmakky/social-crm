import { parse } from "csv-parse/sync";
import { htmlToText } from "./html.ts";
import { KB_LIMITS, KnowledgeError, normalizeText } from "./text.ts";

export type KnowledgeFile = { filename: string; bytes: Uint8Array };
export type Extracted = { text: string; title?: string | null };
/**
 * Turns one file type into plain text. Add a format by registering an extractor under its lower-case extension, for example
 * `extractors[".pdf"] = async (f) => ({ text: await pdfToText(f.bytes) })`. OCR (images), speech-to-text (audio) and PDF/DOCX are the next slices;
 * until registered, those extensions fail with `unsupported_type`. Extractors may be async and must throw KnowledgeError for bad input.
 */
export type Extractor = (file: KnowledgeFile) => Extracted | Promise<Extracted>;

function decodeUtf8(bytes: Uint8Array): string {
  try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { throw new KnowledgeError("invalid_encoding", "The file is not valid UTF-8 text. Save it as UTF-8 and try again."); }
}

/** A CSV becomes one line per row, "Header: value; Header: value", so a row reads as a fact and can be found by any of its values. */
function csvToText(src: string): string {
  const body = src; // TextDecoder has already removed a UTF-8 BOM
  const delimiter = ([",", ";", "\t"] as const).map((d) => ({ d, n: (body.slice(0, 20_000).split(/\r?\n/, 1)[0] ?? "").split(d).length })).sort((a, b) => b.n - a.n)[0]!.d;
  let rows: string[][];
  try { rows = parse(body, { delimiter, skip_empty_lines: true, relax_column_count: true, max_record_size: KB_LIMITS.maxFileBytes }) as string[][]; } catch { throw new KnowledgeError("invalid_encoding", "The CSV file could not be read."); }
  const [head = [], ...rest] = rows;
  return rest.map((r) => r.map((v, i) => (v.trim() ? `${head[i]?.trim() || `Column ${i + 1}`}: ${v.trim()}` : "")).filter(Boolean).join("; ")).filter(Boolean).join("\n\n");
}

export const extractors: Record<string, Extractor> = {
  ".txt": (f) => ({ text: decodeUtf8(f.bytes) }),
  ".md": (f) => ({ text: decodeUtf8(f.bytes) }),
  ".csv": (f) => ({ text: csvToText(decodeUtf8(f.bytes)) }),
  ".html": (f) => htmlToText(decodeUtf8(f.bytes)),
  ".htm": (f) => htmlToText(decodeUtf8(f.bytes)),
};

export const SUPPORTED_EXTENSIONS = (): string[] => Object.keys(extractors);

/**
 * Extracts and normalises the text of an uploaded file, by extension. `extra` adds or overrides extractors for this call only: the API plugs the
 * network-backed ones (PDF, image OCR, audio transcription via the AI media service) in here so this package stays free of network code.
 * An extra extractor owns the size rule for its format; the 2 MB cap below applies to the built-in text formats.
 */
export async function extractFile(file: KnowledgeFile, extra?: Record<string, Extractor>): Promise<{ text: string; title: string | null }> {
  const ext = /\.[^./\\]+$/.exec(file.filename.toLowerCase())?.[0] ?? "";
  const own = extra && Object.hasOwn(extra, ext) ? extra[ext] : undefined;
  if (!own && file.bytes.byteLength > KB_LIMITS.maxFileBytes) throw new KnowledgeError("too_large", "The file is larger than 2 MB.");
  const run = own ?? (Object.hasOwn(extractors, ext) ? extractors[ext] : undefined);
  if (!run) throw new KnowledgeError("unsupported_type", `Files of this type are not supported yet. Use ${SUPPORTED_EXTENSIONS().join(", ")}.`);
  const out = await run(file);
  const text = normalizeText(out.text);
  if (!text) throw new KnowledgeError("empty_content", "No text could be found in this file.");
  return { text, title: out.title ?? null };
}
