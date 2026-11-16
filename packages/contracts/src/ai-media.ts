import { z } from "zod";
import { endpoint } from "./endpoint.ts";

const W = "/v1/workspaces/:workspaceId";

/** Mirrors @crm/ai MEDIA_LIMITS (contracts has no dependency on that package; an API test keeps them equal). */
export const MEDIA_LIMITS = { image: 5 * 1024 * 1024, audio: 20 * 1024 * 1024, document: 10 * 1024 * 1024 } as const;
const Mime = z.string().trim().min(3).max(100);
// One generous cap for every route (the audio cap): the per-kind size rule is applied after decoding and answers 413 media_too_large; each route also caps the request stream.
const Base64 = z.string().min(1, "Choose a file.").max(Math.ceil((MEDIA_LIMITS.audio * 4) / 3) + 8, "The file is too large.").regex(/^[A-Za-z0-9+/]*={0,2}$/, "The file is not valid base64.");

export const AiCapability = z.enum(["text", "vision", "transcription", "document"]);
export type AiCapability = z.infer<typeof AiCapability>;

/** Image, as base64. The server decides what the bytes really are (magic bytes) and refuses a mismatching mime. Images up to 5 MB: png, jpeg, webp, gif. */
export const MediaDescribeBody = z.object({ mime: Mime, contentBase64: Base64 });
export type MediaDescribeBody = z.infer<typeof MediaDescribeBody>;
export const MediaAskBody = MediaDescribeBody.extend({ question: z.string().trim().min(1, "Ask a question about the image.").max(1000, "Use at most 1000 characters.") });
export type MediaAskBody = z.infer<typeof MediaAskBody>;
/** PDF (up to 10 MB) or image (up to 5 MB). */
export const MediaExtractBody = z.object({ mime: Mime, contentBase64: Base64 });
export type MediaExtractBody = z.infer<typeof MediaExtractBody>;
/** Audio up to 20 MB: mp3, wav, m4a, ogg, webm. `language` is an ISO-639-1 hint such as "en". */
export const MediaTranscribeBody = z.object({ mime: Mime, contentBase64: Base64, language: z.string().trim().regex(/^[a-z]{2}$/, "Use a two-letter language code, for example en.").optional() });
export type MediaTranscribeBody = z.infer<typeof MediaTranscribeBody>;

/** The result text is returned to the caller and nothing else keeps it: the run log stores only sizes and a hash. */
export const MediaResult = z.object({
  text: z.string(), provider: z.string(), model: z.string(), mock: z.boolean(), runId: z.string(),
  usage: z.object({ inputTokens: z.number().int(), outputTokens: z.number().int(), costMicro: z.number().int() }),
});
export type MediaResult = z.infer<typeof MediaResult>;

/** Per configured, enabled provider: what each model can do. `unverified` is true for every real provider (adapters are only tested against a fake fetch); the mock provider is labelled `mock`. */
export const AiCapabilityModel = z.object({ id: z.string(), label: z.string(), capabilities: z.array(AiCapability), transcriptionMicroPerMinute: z.number().int().nullable() });
export const AiCapabilityProvider = z.object({ provider: z.string(), label: z.string(), mock: z.boolean(), unverified: z.boolean(), isDefault: z.boolean(), defaultModel: z.string().nullable(), models: z.array(AiCapabilityModel) });
export const AiCapabilities = z.object({
  providers: z.array(AiCapabilityProvider),
  /** What the workspace can do right now. `ocr` = PDF or image text extraction (a `document` or `vision` model). */
  available: z.object({ vision: z.boolean(), ocr: z.boolean(), transcription: z.boolean() }),
});
export type AiCapabilities = z.infer<typeof AiCapabilities>;

export const aiMediaEndpoints = {
  getAiCapabilities: endpoint({ method: "GET", path: `${W}/ai/capabilities`, response: AiCapabilities }),
  describeMedia: endpoint({ method: "POST", path: `${W}/ai/media/describe`, body: MediaDescribeBody, response: MediaResult }),
  askMedia: endpoint({ method: "POST", path: `${W}/ai/media/ask`, body: MediaAskBody, response: MediaResult }),
  extractMedia: endpoint({ method: "POST", path: `${W}/ai/media/extract`, body: MediaExtractBody, response: MediaResult }),
  transcribeMedia: endpoint({ method: "POST", path: `${W}/ai/media/transcribe`, body: MediaTranscribeBody, response: MediaResult }),
} as const;
