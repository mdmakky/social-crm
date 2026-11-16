import { z } from "zod";
import { endpoint } from "./endpoint.ts";

const W = "/v1/workspaces/:workspaceId";
const Uuid = z.string().uuid();

/** Mirrors @crm/knowledge KB_LIMITS (contracts has no dependency on that package; an API test keeps them equal). */
export const KNOWLEDGE_LIMITS = { maxSources: 200, maxCharsPerSource: 1_000_000, maxCharsPerWorkspace: 10_000_000, maxFileBytes: 2 * 1024 * 1024 } as const;
export const KNOWLEDGE_SEARCH_MAX_QUERY = 500;

export const KnowledgeSourceType = z.enum(["text", "url", "file"]);
export const KnowledgeSourceStatus = z.enum(["pending", "ready", "failed"]);
/**
 * `failed` means the last (re)index attempt failed; chunks from the last successful index stay searchable. `error` is a stable code, never content.
 * The stored text is never part of this DTO.
 */
export const KnowledgeSourceDto = z.object({
  id: Uuid, type: KnowledgeSourceType, title: z.string(), sourceRef: z.string().nullable(), status: KnowledgeSourceStatus, error: z.string().nullable(),
  charCount: z.number().int(), chunkCount: z.number().int(), createdBy: z.string().nullable(), createdByName: z.string().nullable(), createdAt: z.string(), updatedAt: z.string(),
});
export type KnowledgeSourceDto = z.infer<typeof KnowledgeSourceDto>;
export const KnowledgeSourceList = z.object({
  items: z.array(KnowledgeSourceDto),
  usage: z.object({ sources: z.number().int(), maxSources: z.number().int(), chars: z.number().int(), maxChars: z.number().int() }),
});
export type KnowledgeSourceList = z.infer<typeof KnowledgeSourceList>;

const Title = z.string().trim().min(1, "Enter a title.").max(200, "Use at most 200 characters for the title.");
export const CreateKnowledgeTextBody = z.object({ title: Title, text: z.string().min(1, "Paste some text.").max(KNOWLEDGE_LIMITS.maxCharsPerSource, "The text is too long.") });
export type CreateKnowledgeTextBody = z.infer<typeof CreateKnowledgeTextBody>;
/** Send the file as `content` (text) or `contentBase64` (any bytes), not both. Supported: .txt, .md, .csv, .html; with an AI provider that has the capability also .pdf, images (OCR) and audio (transcription). */
export const CreateKnowledgeFileBody = z.object({
  filename: z.string().trim().min(1).max(255),
  title: Title.optional(),
  content: z.string().max(KNOWLEDGE_LIMITS.maxFileBytes).optional(),
  // Text formats are capped at maxFileBytes by the server after decoding; PDF, image and audio files (AI media extractors) may be up to the media caps (audio 20 MB).
  contentBase64: z.string().max(Math.ceil((20 * 1024 * 1024 * 4) / 3) + 8).optional(),
}).refine((b) => (b.content === undefined) !== (b.contentBase64 === undefined), "Send the file content.");
export type CreateKnowledgeFileBody = z.infer<typeof CreateKnowledgeFileBody>;
export const CreateKnowledgeUrlBody = z.object({ url: z.string().trim().min(1, "Enter a web address.").max(2048), title: Title.optional() });
export type CreateKnowledgeUrlBody = z.infer<typeof CreateKnowledgeUrlBody>;

export const KnowledgeSearchQuery = z.object({
  q: z.string().trim().min(1, "Enter something to search for.").max(KNOWLEDGE_SEARCH_MAX_QUERY),
  limit: z.coerce.number().int().min(1).max(20).optional(),
});
export const KnowledgeHit = z.object({ sourceId: Uuid, title: z.string(), sourceRef: z.string().nullable(), position: z.number().int(), snippet: z.string(), score: z.number() });
export type KnowledgeHit = z.infer<typeof KnowledgeHit>;
export const KnowledgeSearchResult = z.object({ items: z.array(KnowledgeHit) });
export type KnowledgeSearchResult = z.infer<typeof KnowledgeSearchResult>;

export const knowledgeEndpoints = {
  listKnowledgeSources: endpoint({ method: "GET", path: `${W}/knowledge/sources`, response: KnowledgeSourceList }),
  createKnowledgeText: endpoint({ method: "POST", path: `${W}/knowledge/sources/text`, body: CreateKnowledgeTextBody, response: KnowledgeSourceDto }),
  createKnowledgeFile: endpoint({ method: "POST", path: `${W}/knowledge/sources/file`, body: CreateKnowledgeFileBody, response: KnowledgeSourceDto }),
  createKnowledgeUrl: endpoint({ method: "POST", path: `${W}/knowledge/sources/url`, body: CreateKnowledgeUrlBody, response: KnowledgeSourceDto }),
  getKnowledgeSource: endpoint({ method: "GET", path: `${W}/knowledge/sources/:sourceId`, response: KnowledgeSourceDto }),
  reindexKnowledgeSource: endpoint({ method: "POST", path: `${W}/knowledge/sources/:sourceId/reindex`, response: KnowledgeSourceDto }),
  deleteKnowledgeSource: endpoint({ method: "DELETE", path: `${W}/knowledge/sources/:sourceId`, response: z.undefined() }),
  searchKnowledge: endpoint({ method: "GET", path: `${W}/knowledge/search`, query: KnowledgeSearchQuery, response: KnowledgeSearchResult }),
} as const;
