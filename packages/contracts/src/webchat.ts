import { z } from "zod";
import { endpoint } from "./endpoint.ts";

const W = "/v1/workspaces/:workspaceId";
const Uuid = z.string().uuid();

/** Limits shared by the widget, the public API and the tests. */
export const WEB_CHAT_LIMITS = { messageChars: 2000, bodyBytes: 4096, origins: 20, textChars: 300, nameChars: 80 } as const;

/** One origin: scheme + host (+ port), nothing else. "https://example.com", "http://localhost:3000". Normalised to lower case without a trailing slash. */
export const OriginString = z.string().trim().max(200).transform((s) => s.replace(/\/+$/, "").toLowerCase()).pipe(
  z.string().regex(/^https?:\/\/[a-z0-9]([a-z0-9.-]*[a-z0-9])?(:[0-9]{1,5})?$/, "Use an address like https://example.com (no path)"),
);
const HexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/, "Use a color like #2563eb");
const OptText = z.string().trim().max(WEB_CHAT_LIMITS.textChars).transform((s) => (s === "" ? null : s)).nullable();

export const ChatWidgetDto = z.object({
  id: Uuid, name: z.string(), publicKey: z.string(), allowedOrigins: z.array(z.string()), enabled: z.boolean(),
  greeting: z.string().nullable(), offlineMessage: z.string().nullable(), color: z.string(), prechatForm: z.boolean(), createdAt: z.string(), updatedAt: z.string(),
});
export type ChatWidgetDto = z.infer<typeof ChatWidgetDto>;

export const CreateChatWidgetBody = z.object({
  name: z.string().trim().min(1).max(WEB_CHAT_LIMITS.nameChars),
  allowedOrigins: z.array(OriginString).max(WEB_CHAT_LIMITS.origins).default([]),
  color: HexColor.default("#2563eb"),
  greeting: OptText.default(null),
  offlineMessage: OptText.default(null),
  prechatForm: z.boolean().default(false),
});
export type CreateChatWidgetBody = z.infer<typeof CreateChatWidgetBody>;
export const UpdateChatWidgetBody = z.object({
  name: z.string().trim().min(1).max(WEB_CHAT_LIMITS.nameChars), allowedOrigins: z.array(OriginString).max(WEB_CHAT_LIMITS.origins), enabled: z.boolean(),
  color: HexColor, greeting: OptText, offlineMessage: OptText, prechatForm: z.boolean(),
}).partial();
export type UpdateChatWidgetBody = z.infer<typeof UpdateChatWidgetBody>;

export const webChatEndpoints = {
  listChatWidgets: endpoint({ method: "GET", path: `${W}/web-chat/widgets`, response: z.object({ items: z.array(ChatWidgetDto) }) }),
  createChatWidget: endpoint({ method: "POST", path: `${W}/web-chat/widgets`, body: CreateChatWidgetBody, response: ChatWidgetDto }),
  updateChatWidget: endpoint({ method: "PATCH", path: `${W}/web-chat/widgets/:widgetId`, body: UpdateChatWidgetBody, response: ChatWidgetDto }),
  /** Owner-only: a 10 minute grant that lets our own web app show this widget on a sample page (decision D270). Refused for a switched-off widget. */
  createChatWidgetPreview: endpoint({ method: "POST", path: `${W}/web-chat/widgets/:widgetId/preview`, response: z.object({ grant: z.string(), expiresAt: z.string() }) }),
  rotateChatWidgetKey: endpoint({ method: "POST", path: `${W}/web-chat/widgets/:widgetId/rotate-key`, response: ChatWidgetDto }),
};

// ---- Public (visitor) API. No cookie, no workspace in the URL: the widget key is the only handle. ----
export const WidgetPublicConfig = z.object({
  name: z.string(), color: z.string(), greeting: z.string().nullable(), offlineMessage: z.string().nullable(), prechatForm: z.boolean(), enabled: z.boolean(),
});
export type WidgetPublicConfig = z.infer<typeof WidgetPublicConfig>;
export const WidgetSessionResponse = z.object({ token: z.string(), expiresAt: z.string() });
export const WidgetMessage = z.object({ seq: z.number().int(), from: z.enum(["visitor", "agent"]), body: z.string().nullable(), at: z.string() });
export type WidgetMessage = z.infer<typeof WidgetMessage>;
export const WidgetMessagesResponse = z.object({ items: z.array(WidgetMessage) });
/** `website` is a honeypot: real visitors never see it. `clientId` makes a retry after a network error safe (same id, same message). */
export const WidgetSendBody = z.object({ body: z.string().trim().min(1).max(WEB_CHAT_LIMITS.messageChars), website: z.string().max(200).optional(), clientId: z.string().uuid().optional() });
export const WidgetContactBody = z.object({ name: z.string().trim().max(100).optional(), email: z.string().trim().max(254).email().optional() }).refine((v) => v.name || v.email, "Enter a name or an email");
