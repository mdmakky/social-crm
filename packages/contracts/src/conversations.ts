import { z } from "zod";
import { endpoint } from "./endpoint.ts";

const W = "/v1/workspaces/:workspaceId";
const Uuid = z.string().uuid();

export const ConversationStatus = z.enum(["open", "pending", "resolved"]);
export const DeliveryState = z.enum(["received", "pending", "sending", "sent", "failed", "unknown"]);
/** Whether the 24 hour reply window (counted from the last inbound message) is open. UNVERIFIED rule details: see docs/integrations/meta-api-verification-2026-11.md. */
export const ReplyWindow = z.enum(["open", "closed", "none"]);

export const ConversationItem = z.object({
  id: Uuid,
  platform: z.enum(["messenger", "instagram"]),
  accountName: z.string().nullable(),
  contact: z.object({ id: Uuid, name: z.string(), avatarUrl: z.string().url().nullable() }),
  status: ConversationStatus,
  assignee: z.object({ userId: z.string(), name: z.string() }).nullable(),
  lastMessageAt: z.string().nullable(),
  /** First 120 characters of the latest message body, null for attachment-only messages. Message bodies are personal data: never logged. */
  preview: z.string().nullable(),
  previewDirection: z.enum(["in", "out"]).nullable(),
  /** Derived per user from conversation_reads (inbound messages after this user's cursor). */
  unreadCount: z.number().int().min(0),
  replyWindow: ReplyWindow,
  version: z.number().int(),
});
export type ConversationItem = z.infer<typeof ConversationItem>;

export const ConversationListQuery = z.object({
  status: ConversationStatus.optional(),
  /** "me", "unassigned", or a user id. */
  assignee: z.string().max(100).optional(),
  unread: z.enum(["1"]).optional(),
  q: z.string().trim().max(100).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  cursor: z.string().max(200).optional(),
});
export type ConversationListQuery = z.input<typeof ConversationListQuery>;
export const ConversationList = z.object({ items: z.array(ConversationItem), nextCursor: z.string().nullable(), totalUnread: z.number().int().min(0) });
export type ConversationList = z.infer<typeof ConversationList>;

/** A phone or email of a contact with where it came from. `verified` is false for anything read out of a conversation. Values are personal data: never logged. */
export const ContactMethodDto = z.object({
  id: Uuid,
  kind: z.enum(["phone", "email"]),
  value: z.string(),
  source: z.enum(["messenger", "instagram", "manual", "import", "other"]),
  confidence: z.number().min(0).max(1),
  verified: z.boolean(),
  isPrimary: z.boolean(),
  extractedAt: z.string(),
  /** Set when a person corrected a detected value. */
  correctedAt: z.string().nullable(),
});
export type ContactMethodDto = z.infer<typeof ContactMethodDto>;

export const ConversationDetail = ConversationItem.extend({
  lastInboundAt: z.string().nullable(),
  contactDeliveredAt: z.string().nullable(),
  contactReadAt: z.string().nullable(),
  lastSeq: z.number().int().min(0),
  lastReadSeq: z.number().int().min(0),
  contactSummary: z.object({ id: Uuid, name: z.string(), avatarUrl: z.string().url().nullable(), email: z.string().nullable(), phone: z.string().nullable(), methods: z.array(ContactMethodDto) }),
});
export type ConversationDetail = z.infer<typeof ConversationDetail>;

export const MessageDto = z.object({
  id: Uuid,
  seq: z.number().int(),
  direction: z.enum(["in", "out"]),
  senderKind: z.enum(["contact", "user", "external", "system"]),
  senderName: z.string().nullable(),
  body: z.string().nullable(),
  attachments: z.array(z.object({ type: z.string(), url: z.string().nullable() })),
  deliveryState: DeliveryState,
  failureCode: z.string().nullable(),
  occurredAt: z.string(),
});
export type MessageDto = z.infer<typeof MessageDto>;

export const MessageListQuery = z.object({ before: z.coerce.number().int().min(1).optional(), limit: z.coerce.number().int().min(1).max(100).optional() });
/** Newest page first by default; `items` are returned in ascending seq so the client can render them directly. `hasMore` means older messages exist. */
export const MessageList = z.object({ items: z.array(MessageDto), hasMore: z.boolean() });
export type MessageList = z.infer<typeof MessageList>;

export const MarkReadBody = z.object({ upToSeq: z.number().int().min(0) });
export const MarkReadResult = z.object({ lastReadSeq: z.number().int().min(0), unreadCount: z.number().int().min(0) });

export const UpdateConversationBody = z
  .object({ status: ConversationStatus.optional(), assigneeUserId: z.string().nullable().optional(), expectedVersion: z.number().int() })
  .refine((v) => v.status !== undefined || v.assigneeUserId !== undefined, { message: "Nothing to change" });
export type UpdateConversationBody = z.infer<typeof UpdateConversationBody>;

export const conversationEndpoints = {
  listConversations: endpoint({ method: "GET", path: `${W}/conversations`, query: ConversationListQuery, response: ConversationList }),
  getConversation: endpoint({ method: "GET", path: `${W}/conversations/:conversationId`, response: ConversationDetail }),
  listConversationMessages: endpoint({ method: "GET", path: `${W}/conversations/:conversationId/messages`, query: MessageListQuery, response: MessageList }),
  markConversationRead: endpoint({ method: "POST", path: `${W}/conversations/:conversationId/read`, body: MarkReadBody, response: MarkReadResult }),
  updateConversation: endpoint({ method: "PATCH", path: `${W}/conversations/:conversationId`, body: UpdateConversationBody, response: ConversationDetail }),
} as const;
