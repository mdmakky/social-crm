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
  platform: z.enum(["messenger", "instagram", "whatsapp", "telegram", "email", "web_chat"]),
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
  source: z.enum(["messenger", "instagram", "whatsapp", "telegram", "email", "web_chat", "manual", "import", "other"]),
  confidence: z.number().min(0).max(1),
  verified: z.boolean(),
  isPrimary: z.boolean(),
  extractedAt: z.string(),
  /** Set when a person corrected a detected value. */
  correctedAt: z.string().nullable(),
  /** Email only: a bounce or complaint says mail to this address is not delivered (set by the email events webhook). */
  undeliverable: z.boolean().optional(),
});
export type ContactMethodDto = z.infer<typeof ContactMethodDto>;

export const ConversationDetail = ConversationItem.extend({
  lastInboundAt: z.string().nullable(),
  contactDeliveredAt: z.string().nullable(),
  contactReadAt: z.string().nullable(),
  lastSeq: z.number().int().min(0),
  lastReadSeq: z.number().int().min(0),
  contactSummary: z.object({ id: Uuid, name: z.string(), avatarUrl: z.string().url().nullable(), email: z.string().nullable(), phone: z.string().nullable(), methods: z.array(ContactMethodDto) }),
  /** Email conversations only: where replies go and whether they can be sent. MOCK mode is labeled by the integration state, not here. */
  email: z.object({ address: z.string(), undeliverable: z.boolean(), unverifiedSender: z.boolean() }).nullable().optional(),
  /** Web chat only: the page the visitor last wrote from, origin + path (never a query string or fragment). */
  fromPage: z.string().nullable().optional(),
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
  /** Email messages only. Plain text: the web app renders body as text, never as HTML. */
  email: z.object({ subject: z.string().nullable(), fromAddress: z.string().nullable(), unverifiedSender: z.boolean(), attachmentsNotStored: z.array(z.object({ name: z.string(), size: z.number().nullable() })), attachmentCount: z.number().int().min(0) }).nullable().optional(),
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

/** Messenger text limit applied by us (Meta's own limit is not stated in the pages we could read, so this is conservative). */
export const MAX_REPLY_LENGTH = 2000;
export const SendMessageBody = z.object({
  /** Client-generated id of this attempt. The same id never sends twice: a repeat returns the stored message. */
  clientMsgId: Uuid,
  /** Text. May be empty only when a file is attached (it is then the caption). */
  body: z.string().trim().max(MAX_REPLY_LENGTH, `Messages can be at most ${MAX_REPLY_LENGTH} characters`).default(""),
  /** Ids of uploaded attachments (POST .../attachments). One per message, and only where the channel can send media (WhatsApp); other channels answer `unsupported_channel_media`. */
  attachmentIds: z.array(Uuid).max(1).optional(),
}).refine((b) => b.body.length > 0 || (b.attachmentIds?.length ?? 0) > 0, { message: "Write a message first", path: ["body"] });
export type SendMessageBody = z.infer<typeof SendMessageBody>;
export const SendMessageResult = z.object({ message: MessageDto });
export type SendMessageResult = z.infer<typeof SendMessageResult>;
/** A person's call on a message stuck in "unknown" for 10+ minutes: it did arrive ("sent") or it did not ("not_sent"). */
export const DecideDeliveryBody = z.object({ decision: z.enum(["sent", "not_sent"]) });
export type DecideDeliveryBody = z.infer<typeof DecideDeliveryBody>;

export const conversationEndpoints = {
  sendMessage: endpoint({ method: "POST", path: `${W}/conversations/:conversationId/messages`, body: SendMessageBody, response: SendMessageResult }),
  decideDelivery: endpoint({ method: "POST", path: `${W}/conversations/:conversationId/messages/:messageId/delivery`, body: DecideDeliveryBody, response: SendMessageResult }),
  listConversations: endpoint({ method: "GET", path: `${W}/conversations`, query: ConversationListQuery, response: ConversationList }),
  getConversation: endpoint({ method: "GET", path: `${W}/conversations/:conversationId`, response: ConversationDetail }),
  listConversationMessages: endpoint({ method: "GET", path: `${W}/conversations/:conversationId/messages`, query: MessageListQuery, response: MessageList }),
  markConversationRead: endpoint({ method: "POST", path: `${W}/conversations/:conversationId/read`, body: MarkReadBody, response: MarkReadResult }),
  updateConversation: endpoint({ method: "PATCH", path: `${W}/conversations/:conversationId`, body: UpdateConversationBody, response: ConversationDetail }),
} as const;
