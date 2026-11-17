import { z } from "zod";
import { endpoint } from "./endpoint.ts";

const W = "/v1/workspaces/:workspaceId";
const Uuid = z.string().uuid();

/** Messenger fields requested when a Page is connected (docs/integrations/meta-api-verification-2026-11.md C4). Instagram fields cannot be set through the API. */
export const MESSENGER_WEBHOOK_FIELDS = ["messages", "message_echoes", "messaging_postbacks", "message_reads", "message_deliveries"] as const;
export const InboxPlatform = z.enum(["messenger", "instagram", "whatsapp", "telegram", "email", "web_chat"]);
export const IntegrationStatus = z.enum(["connected", "reauth_required", "disabled"]);
export const SubscriptionState = z.enum(["subscribed", "failed", "dashboard_required"]);

export const IntegrationAccountDto = z.object({
  id: Uuid,
  platform: InboxPlatform,
  externalAccountId: z.string(),
  displayName: z.string().nullable(),
  status: IntegrationStatus,
  /** "facebook": connected through a Facebook Page. "unified": connected directly with Instagram (Unified Login, no Page). */
  authMethod: z.enum(["facebook", "unified"]),
  tokenExpiresAt: z.string().nullable(),
  lastTokenCheckAt: z.string().nullable(),
  connectedAt: z.string(),
});
export type IntegrationAccountDto = z.infer<typeof IntegrationAccountDto>;

/** `configured` is false until the Meta app settings and the encryption key are present on the server; connect endpoints then answer 503. */
export const MetaIntegrationState = z.object({ configured: z.boolean(), mock: z.boolean(), instagramUnifiedConfigured: z.boolean(), accounts: z.array(IntegrationAccountDto) });
export type MetaIntegrationState = z.infer<typeof MetaIntegrationState>;

export const MetaConnectStart = z.object({ authUrl: z.string().url() });
export type MetaConnectStart = z.infer<typeof MetaConnectStart>;

export const MetaPendingPage = z.object({ pageId: z.string(), name: z.string(), instagramAccountId: z.string().nullable(), instagram: z.object({ username: z.string().nullable(), name: z.string().nullable(), pictureUrl: z.string().nullable() }).nullable(), instagramConnected: z.boolean(), connected: z.boolean(), eligible: z.boolean(), ineligibleReason: z.string().nullable() });
export const MetaPendingList = z.object({ pages: z.array(MetaPendingPage), expiresAt: z.string() });
export type MetaPendingList = z.infer<typeof MetaPendingList>;

export const ConnectMetaBody = z.object({ pageId: z.string().regex(/^[1-9][0-9]{0,99}$/), connectInstagram: z.boolean().default(false) });
export type ConnectMetaBody = z.infer<typeof ConnectMetaBody>;

export const ConnectedAccount = z.object({ account: IntegrationAccountDto, subscription: SubscriptionState, reconnected: z.boolean() });
export const ConnectMetaResult = z.object({ accounts: z.array(ConnectedAccount) });
export type ConnectMetaResult = z.infer<typeof ConnectMetaResult>;

/** WhatsApp manual connection (system-user token). The token is sent over TLS, used once to read the WABA's numbers or to connect one, and stored only sealed. It is never returned. */
const WaId = z.string().regex(/^[1-9][0-9]{0,99}$/);
export const WhatsAppLookupBody = z.object({ wabaId: WaId, accessToken: z.string().min(20).max(2000).regex(/^\S+$/) });
export type WhatsAppLookupBody = z.infer<typeof WhatsAppLookupBody>;
export const WhatsAppNumberDto = z.object({ phoneNumberId: z.string(), displayPhoneNumber: z.string(), verifiedName: z.string().nullable(), connected: z.boolean(), /** held by another workspace (or reserved there after a disconnect): it cannot be connected here, /connect refuses it with 409 account_unavailable. Advisory only. */ unavailable: z.boolean().default(false) });
export const WhatsAppLookupResult = z.object({ numbers: z.array(WhatsAppNumberDto) });
export type WhatsAppLookupResult = z.infer<typeof WhatsAppLookupResult>;
export const ConnectWhatsAppBody = WhatsAppLookupBody.extend({ phoneNumberId: WaId });
export type ConnectWhatsAppBody = z.infer<typeof ConnectWhatsAppBody>;
export const ConnectWhatsAppResult = z.object({ account: IntegrationAccountDto, subscription: SubscriptionState, reconnected: z.boolean(), /** earlier webhook events for this number (stored while it was not connected) that were queued for processing */ replayedEvents: z.number().int().min(0) });
export type ConnectWhatsAppResult = z.infer<typeof ConnectWhatsAppResult>;

/** Telegram bot connection (MOCK ONLY so far). The bot token is sent over TLS, checked with getMe, stored only sealed and never returned. The format is UNVERIFIED (Telegram documents it as an opaque string), so it is not pattern-checked here; getMe is the check. */
export const ConnectTelegramBody = z.object({ botToken: z.string().min(20).max(200).regex(/^\S+$/) });
export type ConnectTelegramBody = z.infer<typeof ConnectTelegramBody>;
export const ConnectTelegramResult = z.object({ account: IntegrationAccountDto, botUsername: z.string().nullable(), webhook: z.enum(["set", "failed"]), reconnected: z.boolean(), /** earlier updates stored while the bot was not connected that were queued again */ replayedEvents: z.number().int().min(0) });
export type ConnectTelegramResult = z.infer<typeof ConnectTelegramResult>;
/** getWebhookInfo, reduced to what a person can act on. */
export const TelegramHealth = z.object({ webhookSet: z.boolean(), pendingUpdateCount: z.number().int().min(0), lastErrorAt: z.string().nullable(), lastErrorMessage: z.string().nullable() });
export type TelegramHealth = z.infer<typeof TelegramHealth>;

export const MetaAccountEvent = z.object({ id: Uuid, kind: z.string(), summary: z.string(), createdAt: z.string() });
export const MetaAccountEvents = z.object({ items: z.array(MetaAccountEvent) });
export type MetaAccountEvents = z.infer<typeof MetaAccountEvents>;
export const SubscribeResult = z.object({ subscription: SubscriptionState });
export const MetaCallbackQuery = z.object({ code: z.string().max(2000).optional(), state: z.string().max(2000).optional(), error: z.string().max(100).optional(), error_reason: z.string().max(100).optional() });

export const inboxEndpoints = {
  getMetaIntegration: endpoint({ method: "GET", path: `${W}/integrations/meta`, response: MetaIntegrationState }),
  startInstagramUnified: endpoint({ method: "POST", path: `${W}/integrations/instagram/connect/start`, response: MetaConnectStart }),
  lookupWhatsAppNumbers: endpoint({ method: "POST", path: `${W}/integrations/whatsapp/numbers`, body: WhatsAppLookupBody, response: WhatsAppLookupResult }),
  connectWhatsApp: endpoint({ method: "POST", path: `${W}/integrations/whatsapp/connect`, body: ConnectWhatsAppBody, response: ConnectWhatsAppResult }),
  connectTelegram: endpoint({ method: "POST", path: `${W}/integrations/telegram/connect`, body: ConnectTelegramBody, response: ConnectTelegramResult }),
  telegramHealth: endpoint({ method: "GET", path: `${W}/integrations/telegram/accounts/:accountId/health`, response: TelegramHealth }),
  startMetaConnect: endpoint({ method: "POST", path: `${W}/integrations/meta/connect/start`, response: MetaConnectStart }),
  listMetaPending: endpoint({ method: "GET", path: `${W}/integrations/meta/pending`, response: MetaPendingList }),
  connectMetaPage: endpoint({ method: "POST", path: `${W}/integrations/meta/connect`, body: ConnectMetaBody, response: ConnectMetaResult }),
  disconnectMetaAccount: endpoint({ method: "POST", path: `${W}/integrations/meta/accounts/:accountId/disconnect`, response: z.object({ ok: z.literal(true) }) }),
  checkMetaAccountToken: endpoint({ method: "POST", path: `${W}/integrations/meta/accounts/:accountId/check-token`, response: IntegrationAccountDto }),
  /** Last 10 connection events of one account, as plain-language summaries (never raw event data). Owner/admin only. */
  listMetaAccountEvents: endpoint({ method: "GET", path: `${W}/integrations/meta/accounts/:accountId/events`, response: MetaAccountEvents }),
  resubscribeMetaAccount: endpoint({ method: "POST", path: `${W}/integrations/meta/accounts/:accountId/resubscribe`, response: SubscribeResult }),
  /** Browser redirect target after the Meta dialog; answers with a 302 to the web app, never JSON. Declared so the drift guard knows the route. */
  metaOAuthCallback: endpoint({ method: "GET", path: "/v1/integrations/meta/callback", query: MetaCallbackQuery, response: z.undefined() }),
  /** Browser redirect target after the Instagram (Unified Login) dialog; same behaviour as the Meta callback. */
  instagramUnifiedCallback: endpoint({ method: "GET", path: "/v1/integrations/instagram/callback", query: MetaCallbackQuery, response: z.undefined() }),
} as const;
