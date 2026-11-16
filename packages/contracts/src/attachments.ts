import { z } from "zod";
import { endpoint } from "./endpoint.ts";
import { KnowledgeSourceDto } from "./knowledge.ts";
import { MediaAskBody, MediaResult } from "./ai-media.ts";

const W = "/v1/workspaces/:workspaceId/conversations/:conversationId";
const Uuid = z.string().uuid();

export const AttachmentKind = z.enum(["image", "audio", "video", "document"]);
export type AttachmentKind = z.infer<typeof AttachmentKind>;
export const AttachmentStatus = z.enum(["pending", "ready", "failed", "deleted", "missing"]);
export type AttachmentStatus = z.infer<typeof AttachmentStatus>;

/** Default size caps per kind (an env var can change them on the server; `GET .../attachments` returns the effective ones). Mirrors @crm/ai ATTACHMENT_LIMITS; an API test keeps them equal. */
export const ATTACHMENT_LIMITS = { image: 5 * 1024 * 1024, audio: 20 * 1024 * 1024, video: 25 * 1024 * 1024, document: 10 * 1024 * 1024 } as const;
export const ATTACHMENT_ACCEPT = ".png,.jpg,.jpeg,.gif,.webp,.pdf,.mp3,.wav,.m4a,.ogg,.webm,.mp4,.mov,.docx,.xlsx,.pptx,.txt,.csv";

/** Metadata only. The file itself is served by `.../content`; the storage key and any channel link never leave the server. `errorCode` is a stable code, never content. */
export const AttachmentDto = z.object({
  id: Uuid, conversationId: Uuid, messageId: Uuid.nullable(),
  direction: z.enum(["inbound", "outbound"]), source: z.enum(["channel_download", "user_upload"]),
  kind: AttachmentKind, status: AttachmentStatus, mime: z.string().nullable(), filename: z.string().nullable(), sizeBytes: z.number().int().nullable(),
  errorCode: z.string().nullable(), createdAt: z.string(), createdBy: z.string().nullable(),
});
export type AttachmentDto = z.infer<typeof AttachmentDto>;
export const AttachmentList = z.object({
  items: z.array(AttachmentDto),
  /** False when the server has no blob store: files cannot be kept, uploads answer `storage_not_configured`, received media stays pending. */
  storageConfigured: z.boolean(),
  limits: z.object({ image: z.number().int(), audio: z.number().int(), video: z.number().int(), document: z.number().int() }),
});
export type AttachmentList = z.infer<typeof AttachmentList>;

/** One file as base64 JSON (the same pattern as the knowledge and AI media routes). The server decides what the bytes are; a mismatching `mime` is refused. */
export const UploadAttachmentBody = z.object({
  filename: z.string().trim().min(1, "Choose a file.").max(255),
  mime: z.string().trim().min(3).max(100),
  contentBase64: z.string().min(1, "Choose a file.").max(Math.ceil((ATTACHMENT_LIMITS.video * 4) / 3) + 8, "The file is too large.").regex(/^[A-Za-z0-9+/]*={0,2}$/, "The file is not valid base64."),
});
export type UploadAttachmentBody = z.infer<typeof UploadAttachmentBody>;
export const AttachmentAskBody = MediaAskBody.pick({ question: true });
export const AttachmentTranscribeBody = z.object({ language: z.string().trim().regex(/^[a-z]{2}$/, "Use a two-letter language code, for example en.").optional() });
export const AddAttachmentToKnowledgeBody = z.object({ attachmentId: Uuid, title: z.string().trim().min(1).max(200).optional() });

export const attachmentEndpoints = {
  listAttachments: endpoint({ method: "GET", path: `${W}/attachments`, response: AttachmentList }),
  uploadAttachment: endpoint({ method: "POST", path: `${W}/attachments`, body: UploadAttachmentBody, response: AttachmentDto }),
  getAttachment: endpoint({ method: "GET", path: `${W}/attachments/:attachmentId`, response: AttachmentDto }),
  /** The bytes, streamed through the API after the access check. Not a JSON endpoint: the web app points <img>/<audio>/<video>/<a> at this URL. */
  getAttachmentContent: endpoint({ method: "GET", path: `${W}/attachments/:attachmentId/content`, response: z.string(), responseType: "text" }),
  deleteAttachment: endpoint({ method: "DELETE", path: `${W}/attachments/:attachmentId`, response: z.undefined() }),
  retryAttachment: endpoint({ method: "POST", path: `${W}/attachments/:attachmentId/retry`, response: AttachmentDto }),
  describeAttachment: endpoint({ method: "POST", path: `${W}/attachments/:attachmentId/ai/describe`, response: MediaResult }),
  askAttachment: endpoint({ method: "POST", path: `${W}/attachments/:attachmentId/ai/ask`, body: AttachmentAskBody, response: MediaResult }),
  extractAttachment: endpoint({ method: "POST", path: `${W}/attachments/:attachmentId/ai/extract`, response: MediaResult }),
  transcribeAttachment: endpoint({ method: "POST", path: `${W}/attachments/:attachmentId/ai/transcribe`, body: AttachmentTranscribeBody, response: MediaResult }),
  addAttachmentToKnowledge: endpoint({ method: "POST", path: "/v1/workspaces/:workspaceId/knowledge/sources/from-attachment", body: AddAttachmentToKnowledgeBody, response: KnowledgeSourceDto }),
} as const;
