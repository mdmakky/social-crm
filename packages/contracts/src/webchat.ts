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
const optText = (max: number) => z.string().trim().max(max).transform((s) => (s === "" ? null : s)).nullable();
const OptText = optText(WEB_CHAT_LIMITS.textChars);
/** Widget appearance limits (migration 0041). The greeting headline is the existing `greeting` column, the title is `name`. */
export const WIDGET_APPEARANCE_LIMITS = { greeting: 90, subtitle: 60, quickReplies: 3, quickReplyChars: 30, awayText: 160, avatarUrl: 500, pageUrl: 300 } as const;
export const DEFAULT_SUBTITLE = "We reply here";
/** Optional picture: an https address only (the widget page loads it with no referrer). Empty means "use the initial letter". */
export const AvatarUrl = z.string().trim().max(WIDGET_APPEARANCE_LIMITS.avatarUrl).transform((s) => (s === "" ? null : s)).pipe(
  z.string().refine((s) => { try { const u = new URL(s); return u.protocol === "https:" && !u.username && !u.password && /^https:\/\/[^\s]+$/.test(s); } catch { return false; } }, "Use a picture address that starts with https://").nullable(),
);
const Subtitle = z.string().trim().min(1, "Write a short line, like: We reply here").max(WIDGET_APPEARANCE_LIMITS.subtitle);
const Position = z.enum(["left", "right"]);
const Language = z.enum(["en", "bn"]);
/** 0 to 3 quick questions, text only. */
const QuickReplies = z.array(z.string().trim().min(1, "A quick reply cannot be empty").max(WIDGET_APPEARANCE_LIMITS.quickReplyChars)).max(WIDGET_APPEARANCE_LIMITS.quickReplies);
const Greeting = optText(WIDGET_APPEARANCE_LIMITS.greeting);
const AwayText = optText(WIDGET_APPEARANCE_LIMITS.awayText);

/**
 * The page a visitor is on, reduced to origin + path. The query string and fragment are dropped on purpose: they can carry tokens, emails or order ids that agents (and our database) have no business with.
 * Used by the API on whatever the widget sends, so a widget that forgot to strip still cannot store them. Returns null for anything that is not http(s) or is too long.
 */
export function cleanPageUrl(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length > 2000) return null;
  try {
    const u = new URL(raw);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    const out = `${u.origin}${u.pathname}`;
    return out.length <= WIDGET_APPEARANCE_LIMITS.pageUrl ? out : null;
  } catch { return null; }
}

export const ChatWidgetDto = z.object({
  id: Uuid, name: z.string(), publicKey: z.string(), allowedOrigins: z.array(z.string()), enabled: z.boolean(),
  greeting: z.string().nullable(), offlineMessage: z.string().nullable(), color: z.string(), prechatForm: z.boolean(), createdAt: z.string(), updatedAt: z.string(),
  avatarUrl: z.string().nullable(), subtitle: z.string(), position: Position, quickReplies: z.array(z.string()), awayMode: z.boolean(), awayText: z.string().nullable(), defaultLanguage: Language,
});
export type ChatWidgetDto = z.infer<typeof ChatWidgetDto>;

export const CreateChatWidgetBody = z.object({
  name: z.string().trim().min(1).max(WEB_CHAT_LIMITS.nameChars),
  allowedOrigins: z.array(OriginString).max(WEB_CHAT_LIMITS.origins).default([]),
  color: HexColor.default("#2563eb"),
  greeting: Greeting.default(null),
  offlineMessage: OptText.default(null),
  prechatForm: z.boolean().default(false),
  avatarUrl: AvatarUrl.default(null), subtitle: Subtitle.default(DEFAULT_SUBTITLE), position: Position.default("right"), quickReplies: QuickReplies.default([]),
  awayMode: z.boolean().default(false), awayText: AwayText.default(null), defaultLanguage: Language.default("en"),
});
export type CreateChatWidgetBody = z.infer<typeof CreateChatWidgetBody>;
export const UpdateChatWidgetBody = z.object({
  name: z.string().trim().min(1).max(WEB_CHAT_LIMITS.nameChars), allowedOrigins: z.array(OriginString).max(WEB_CHAT_LIMITS.origins), enabled: z.boolean(),
  color: HexColor, greeting: Greeting, offlineMessage: OptText, prechatForm: z.boolean(),
  avatarUrl: AvatarUrl, subtitle: Subtitle, position: Position, quickReplies: QuickReplies, awayMode: z.boolean(), awayText: AwayText, defaultLanguage: Language,
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
/** Only what the widget needs to draw itself. No workspace id, no allowed sites, no widget id. */
export const WidgetPublicConfig = z.object({
  name: z.string(), color: z.string(), greeting: z.string().nullable(), offlineMessage: z.string().nullable(), prechatForm: z.boolean(), enabled: z.boolean(),
  avatarUrl: z.string().nullable(), subtitle: z.string(), position: Position, quickReplies: z.array(z.string()), awayMode: z.boolean(), awayText: z.string().nullable(), defaultLanguage: Language,
});
export type WidgetPublicConfig = z.infer<typeof WidgetPublicConfig>;
export const WidgetSessionResponse = z.object({ token: z.string(), expiresAt: z.string() });
export const WidgetMessage = z.object({ seq: z.number().int(), from: z.enum(["visitor", "agent"]), body: z.string().nullable(), at: z.string() });
export type WidgetMessage = z.infer<typeof WidgetMessage>;
export const WidgetMessagesResponse = z.object({ items: z.array(WidgetMessage) });
/** `website` is a honeypot: real visitors never see it. `clientId` makes a retry after a network error safe (same id, same message). */
export const WidgetSendBody = z.object({ body: z.string().trim().min(1).max(WEB_CHAT_LIMITS.messageChars), website: z.string().max(200).optional(), clientId: z.string().uuid().optional(), pageUrl: z.string().max(2000).optional() });
export const WidgetContactBody = z.object({ name: z.string().trim().max(100).optional(), email: z.string().trim().max(254).email().optional() }).refine((v) => v.name || v.email, "Enter a name or an email");
