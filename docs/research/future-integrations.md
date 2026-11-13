# Future Integrations Research: TikTok, WhatsApp, LinkedIn

Retrieval date: 2026-11-13. Purpose: inform the platform-adapter abstraction of the Social CRM.

Evidence grading used throughout:

- **Official**: read directly from the platform's own documentation during this research.
- **Third-party**: reported by an integrator vendor (Chatwoot, respond.io and similar). Treat as likely but re-check against official docs.
- **Unverified**: not confirmed from any source retrieved. Do not build on it without checking.

Several official TikTok and LinkedIn pages did not return usable text to the research tooling (see "Gaps" at the end). Anything depending on them is marked accordingly.

## 1. TikTok

### 1.1 Login Kit

- Capability: OAuth for TikTok users. Scopes are granted per user, and users may approve a subset of requested scopes. Example scopes: `user.info.basic`, `video.list`. Official: https://developers.tiktok.com/doc/login-kit-manage-user-access-tokens
- Auth model: authorization code flow, refreshable access tokens, tokens must be stored server-side. Token lifetimes are not stated on that page (unverified there). A third-party source reports Business Messaging access tokens last about 24 hours and refresh tokens about 30 days (third-party, https://developers.chatwoot.com/self-hosted/configuration/features/integrations/tiktok).
- Individual use: a developer account can be registered personally (unverified for approval odds on gated products). Login Kit is for consumer identity and creator data, not business inbox access.

### 1.2 Content Posting / Display API

- Official guidance on audits: clients that have not passed TikTok's audit can use Direct Post only in private mode, with at most 5 users posting per 24 hours, and every posting account must be private at post time. After audit, those limits lift, but roughly 15 posts per day per creator account still applies. Official: https://developers.tiktok.com/doc/content-sharing-guidelines
- Relevance to a CRM: low. Publishing and video listing are not inbox features. Treat as an optional "content" capability, not part of the messaging core.
- Display API specifics (video list fields, rate limits): unverified, not retrieved.

### 1.3 TikTok Lead Generation (Instant Form) and CRM integration

- TikTok's help center lists four connection types: direct integrations, third-party integrations (Zapier, LeadsBridge, Albato named), a custom API with webhooks, and website builder plugins. The webhook route is described as real-time. Source: TikTok Ads help search results, https://ads.tiktok.com/help/article?aid=10001704 (article body not fully retrieved; partial).
- Setup is through TikTok Ads Manager (Tools, Leads Center, Connect CRM). Requires an Ads Manager account with admin access and an existing Instant Form. Whether an ad account is feasible for a solo individual (billing, business entity) is unverified.
- Adapter implication: leads arrive as form submissions, not conversations. They are a distinct "lead" event type, mapped to contacts with field mappings, with no reply channel.
- Webhook payload schema and signature scheme: unverified.

### 1.4 Business Messaging API (DMs)

All of this section is third-party unless stated. The official TikTok page was not retrieved.

- Gating: requires special permission. You apply with use case, data handling and organization details; review is reported at a few days. Only TikTok Business Accounts work, not personal accounts. Sources: https://developers.chatwoot.com/self-hosted/configuration/features/integrations/tiktok, https://respond.io/help/tiktok/tiktok-overview
- Region: unavailable for accounts registered in the EEA, Switzerland and the UK (both sources).
- Window: replies must be sent within 48 hours of the contact's message. Maximum 10 consecutive business messages per 48-hour window, reset by a new contact message. Businesses cannot initiate conversations. API rate limit reported at 10 queries per second (respond.io).
- Content: text up to 6,000 characters, JPG/PNG images up to 3 MB, TikTok posts inbound/echo only. Video and voice cannot be sent. Media sending is reported unavailable in a long list of countries including the US and UK (respond.io), so attachments are region-dependent.
- Webhooks: public HTTPS callback, signature checked with the app secret, clock skew tolerance about 5 seconds (Chatwoot).
- The respond.io page labels the channel Open Beta. Expect change.
- Individual without a company: unverified. Application asks for organization details, so assume a registered business is expected.

### 1.5 Events API

- Server-side conversion events sent to a pixel, authenticated with an access token generated in Ads Manager (pixel settings). Deduplicate with the browser pixel via a shared `event_id`. Test event code available. Source: third-party guides in search results (e.g. https://stape.io/helpdesk/documentation/how-to-set-up-tiktok-events-api); official reference at business-api.tiktok.com was not retrieved. Marked unverified for schema details.
- Relevance: outbound marketing attribution, not messaging. Optional "conversion reporting" capability.

### 1.6 Eligibility summary

EEA, Switzerland and UK are excluded from DM API. Media is limited by country. Business account required. Treat everything as region-flagged per connected account.

## 2. WhatsApp Business Platform (Cloud API)

### 2.1 Onboarding as a solo developer

- Official getting-started flow: create a Meta app with a business portfolio, pick or add a "From" test number in API Setup, send the `hello_world` template to your own number. The temporary token expires quickly. For development, create a system user in Business Settings and generate a permanent token with `business_management`, `whatsapp_business_messaging` and `whatsapp_business_management`. Source: https://developers.facebook.com/docs/whatsapp/cloud-api/get-started
- This path requires a Meta developer account and a business portfolio but, per the page, does not require business verification to start. The page does not describe recipient limits for test numbers (unverified here; Meta historically limits test recipients to a small verified list, unverified in this retrieval).
- Going to production with your own number: business verification is one scaling path. Messaging limits are per business portfolio: new portfolios start at 250 unique users per 24 hours (outside service windows). Verifying the business is one path to 2,000. Higher tiers need automatic scaling (quality, use at least half of the current limit within 7 days). Source: https://developers.facebook.com/docs/whatsapp/messaging-limits
- Individual without a company: possible to test and run at the 250 tier. Whether a sole proprietor can pass business verification depends on Meta's document rules, which were not retrieved (unverified).

### 2.2 Embedded Signup and Tech Provider

- Embedded Signup lets your customers connect their own WhatsApp accounts inside your product. Official: https://developers.facebook.com/docs/whatsapp/embedded-signup/overview
  - Needs App Review with advanced access for `whatsapp_business_management` and `whatsapp_business_messaging`. Without it you cannot onboard customers.
  - Tech Providers use business tokens, and onboarded customers must add a payment method.
  - Completing business verification, App Review and Access Verification raises the cap from 10 to 200 newly onboarded customers per rolling 7 days.
  - Accounts created via the developer app cannot be onboarded through the flow.
- For a single-tenant CRM used by the owner, Embedded Signup is not needed. It becomes necessary only if the CRM serves multiple client businesses (multi-tenant).

### 2.3 Customer service window and templates

- A 24-hour window opens when a user messages or calls the business and resets on each user message. Free-form messages are allowed only inside it. Outside it, approved template messages are required. Official: https://developers.facebook.com/docs/whatsapp/pricing
- Click-to-WhatsApp ad entry opens a free entry point window of up to 7 days.
- Template categories: marketing, utility, authentication. Template approval rules and quality-rating details were not retrieved (the template page has moved to "Template fundamentals"; unverified here).

### 2.4 Pricing model

Per official pricing page (https://developers.facebook.com/docs/whatsapp/pricing):

- Per-message pricing replaced conversation-based pricing on 2025-07-01. Charged per delivered template message by category and recipient country. User-to-business messages are free.
- Service (non-template) replies in the window: first 1,000 per number per month free, charges beyond that start 2026-10-01 (this date has now passed relative to today). Utility templates inside an open service window became charged from 2026-10-01 (previously free since 2025-07-01).
- Meta Business Agent AI messages added 2026-07-01, billed per token ($2.00 per million tokens, roughly 4 to 5 cents per message per the page).
- A payment method had to be added by 2026-09-30 or service messages stop delivering once charging begins.
- Rate cards and currency localization (INR, BRL) changed on dated schedules. Do not hard-code prices. The adapter should record category and billable flag from webhooks and treat cost as data.

### 2.5 Webhooks and auth

- Webhook object `whatsapp_business_account`, field `messages`, carrying inbound messages and delivery/read status. Official: get-started page above.
- Auth: system user permanent token or business token (Tech Provider). Webhook signature verification details: unverified in this retrieval.

### 2.6 Adapter-relevant differences

Phone-number identity, template-required outbound outside window, delivered/read statuses, billable messages, per-portfolio throughput tiers.

## 3. LinkedIn

### 3.1 Marketing Developer Platform

- Access is by tiers: Development Tier and Standard Tier. Standard requires an upgrade request with a screencast demonstrating each use case. Source: Microsoft Learn LinkedIn docs (retrieved via the fetch tool in summarized form; page excerpts only), https://learn.microsoft.com/en-us/linkedin/marketing/community-management/community-management-overview
- Whether an individual without a company can obtain Standard Tier: unverified. Community Management docs refer to "approved use cases" and an application review. The text of those requirements was not retrievable.

### 3.2 Lead Gen Forms (Lead Sync API)

- Separate program. Advertising API access does not grant it, and you must apply separately. Source: https://learn.microsoft.com/en-us/linkedin/marketing/lead-sync/leadsync
- Webhook model: `leadNotifications` creates webhook subscriptions to be notified of lead form responses. The doc also has a section on webhook deduplication, so treat delivery as at-least-once. Polling is also supported (leads endpoints).
- Auth: member OAuth with permission scopes. Members must accept all requested permissions (no subset). Error 401 "member doesn't have lead access permission" shows lead access depends on the authorizing member's role on the ad account.
- Individual use: requires an advertiser/ad-account context. Solo feasibility unverified.

### 3.3 Conversations / Messaging

- Official Microsoft docs describe a Messages API for members to message first-degree connections and reply to conversations, and a Compliance Events API to monitor a member's messaging activity. Search result summary, https://learn.microsoft.com/en-us/linkedin/shared/integrations/communications/messages (page not read in full).
- Access to the Compliance family is reported as a private, paid partner program (third-party, unverified officially).
- No confirmed self-service path to read or reply to a Page inbox. Treat inbound/outbound DM as **Gated** (partner only), not buildable for a solo dev.
- Third-party "unified API" vendors (Unipile and others) access LinkedIn through connected user sessions. This carries terms-of-service risk and was not verified. Not recommended.

### 3.4 Community Management API

- Covers organization page content, comments and social actions (exact endpoint list not retrieved, unverified). Development Tier first, then Standard Tier; the docs say Community Management Standard Tier is requested on an existing Advertising API app, and a separate developer application is expected. Rate limits for Development Tier were raised (specifics not retrieved).
- Webhooks for Page events: unverified.

## 4. Brief notes on X, Telegram, Gmail

Not researched in depth (out of the stated scope unless clearly relevant). Recommendation, unverified in this pass: Telegram Bot API and Gmail API are individually usable and low gating, and would be useful low-risk test targets for validating the adapter abstraction. X API access terms and pricing change frequently and were not checked. Verify before committing.

## 5. Meta Messenger and Instagram reference (existing adapters)

Included only to fill the registry. Source: https://developers.facebook.com/documentation/business-messaging/instagram-messaging/overview

- Standard 24-hour window; up to 7 days after a Click-to-Direct ad entry; Human Agent tag for human replies outside the window (separate rules).
- Permissions: `instagram_basic`, `instagram_manage_messages`, `pages_manage_metadata`, `pages_showlist`, `business_management`. Standard Access works only for app role holders; Advanced Access needs App Review.
- Apps must provide a human escalation path. Group messaging is not supported. Webhooks give only URLs for shared media. Requests-folder conversations inactive 30 days are not returned.
- Messenger details: only search snippets retrieved (24-hour window plus Human Agent). Webhook and permission specifics for Messenger are unverified here.

## 6. Differences the normalized adapter must tolerate

1. Outbound can be impossible without a prior inbound (TikTok cannot initiate; WhatsApp needs templates; Meta needs inbound within window).
2. Different reply-window lengths (24h, 48h, 7d) and different counters (TikTok 10 messages per window).
3. Region-dependent availability and content support, per connected account.
4. Leads are not conversations (TikTok, LinkedIn): a separate event kind with no reply path.
5. Tokens expire at different rates; re-authorization states need first-class representation.
6. Webhook semantics: signed vs unsigned, at-least-once duplicates (LinkedIn documents dedup), polling fallback.
7. Cost: WhatsApp messages are billable; surface a billable flag.
8. Capabilities gated by approval state that can change at runtime; capabilities must be queried per account, not per platform.
9. Beta and unstable surfaces (TikTok messaging is labeled Open Beta by one vendor).

## 7. Capability registry

Legend: S = Supported (usable once the account is set up), G = Gated (requires approval, partner status or business verification), U = Unavailable (no API known), ? = Unverified. Meta columns reflect only what was retrieved.

| Capability | Meta Messenger | Instagram | WhatsApp | TikTok | LinkedIn |
|---|---|---|---|---|---|
| Inbound DM | S (Advanced Access for non-role users: ?) | S (Advanced Access beyond roles) | S | G (approval, non-EEA/UK/CH) | G (partner only; Page inbox unverified) |
| Outbound DM | S inside window | S inside window | S inside 24h window | G, reply only within 48h, max 10 | G |
| Initiate conversation | U without inbound | U without inbound | S via template (G: limits/verification tiers) | U | G |
| Comments | ? | ? | U | ? (not retrieved) | G (Community Management API) |
| Lead forms | ? | ? | U (click-to-WhatsApp entry only) | S via Instant Form CRM/webhook (needs Ads account) | G (Lead Sync, separate application) |
| Templates | U | U | S (approval required) | U | U |
| Read receipts | ? | Partly: messages not marked Read in app until a reply is sent | S (status webhooks) | ? | ? |
| Attachments | ? | S (webhook gives URL only) | ? (not retrieved) | G/region-limited (JPG/PNG 3MB, many countries blocked) | ? |
| Webhooks | S | S | S | S (signed, third-party) | S for lead notifications; others ? |
| Human-agent / out-of-window reply | S (Human Agent tag) | S (Human Agent tag) | U (templates only) | U | ? |
| Server-side conversion events | ? | ? | ? | S (Events API, third-party) | ? |
| Individual without company | ? | S-ish for Standard Access with role (Advanced needs review) | S at test/250 tier | ? | ? (likely hard) |

## 8. Recommended adapter interface sketch

Design rule: capabilities are discovered per connected account at runtime, never assumed per platform.

```ts
export type PlatformId = 'messenger' | 'instagram' | 'whatsapp' | 'tiktok' | 'linkedin';

export type CapabilityStatus = 'supported' | 'gated' | 'unavailable' | 'unverified';

export type CapabilityKey =
  | 'inbound_dm' | 'outbound_dm' | 'initiate_conversation'
  | 'comments' | 'lead_forms' | 'templates'
  | 'read_receipts' | 'attachments' | 'webhooks'
  | 'human_agent_override' | 'conversion_events';

export interface AccountCapabilities {
  statuses: Record<CapabilityKey, CapabilityStatus>;
  reply_window?: { hours: number; max_messages?: number }; // 24, 48 or 168; TikTok caps at 10
  attachment_rules?: { mime: string[]; max_bytes: number; regions_blocked?: string[] };
  max_text_length?: number;
  billable?: boolean;            // WhatsApp
  region_restricted?: boolean;   // TikTok EEA/UK/CH
}

export type AuthState = 'ok' | 'expiring' | 'reauth_required';

export interface ConnectedAccount {
  id: string;
  platform: PlatformId;
  external_id: string;
  auth_state: AuthState;
  capabilities: AccountCapabilities;
}

export type EventKind =
  | 'message_in' | 'message_echo' | 'delivery_status'
  | 'comment_in' | 'lead_submitted' | 'auth_revoked';

export interface NormalizedEvent {
  kind: EventKind;
  platform: PlatformId;
  account_id: string;
  event_id: string;              // dedupe key; delivery is at-least-once
  occurred_at: string;           // ISO 8601
  contact_ref?: { external_id: string; handle?: string; phone?: string };
  conversation_ref?: string;
  message?: {
    text?: string;
    attachments?: { kind: 'image' | 'video' | 'audio' | 'file' | 'post'; url?: string; unsupported?: boolean }[];
  };
  status?: 'sent' | 'delivered' | 'read' | 'failed';
  billable?: { category?: string };
  lead?: { form_id: string; fields: Record<string, string> };
  raw: unknown;                  // keep original payload
}

export type SendResult =
  | { ok: true; external_message_id: string }
  | { ok: false; reason: 'window_closed' | 'template_required' | 'message_cap_reached'
        | 'unsupported_content' | 'region_blocked' | 'reauth_required' | 'rate_limited' | 'other';
      retry_after?: number };

export interface OutboundMessage {
  conversation_id: string;
  text?: string;
  attachments?: { url: string; mime: string }[];
  template?: { name: string; language: string; params: string[] };
}

export interface PlatformAdapter {
  readonly platform: PlatformId;
  getCapabilities(account: ConnectedAccount): Promise<AccountCapabilities>;
  // Pure: lets the UI show "can reply until X" or "template required" before sending.
  checkSendability(account: ConnectedAccount, conv: { last_inbound_at?: string; sent_since_inbound: number }): { allowed: boolean; reason?: string };
  send(account: ConnectedAccount, msg: OutboundMessage): Promise<SendResult>;
  verifyWebhook(headers: Record<string, string>, rawBody: string): boolean;
  parseWebhook(rawBody: string): NormalizedEvent[];
  refreshAuth?(account: ConnectedAccount): Promise<ConnectedAccount>;
  pollEvents?(account: ConnectedAccount, since: string): Promise<NormalizedEvent[]>; // fallback
}
```

Suggested build order for a solo developer: finish Meta Messenger and Instagram, then WhatsApp Cloud API (self-serve test number, single tenant, no Embedded Signup), then TikTok Lead Gen via webhook (lead events only), and defer TikTok DMs and LinkedIn messaging until approval paths are confirmed.

## 9. Gaps and caveats

- Pages that returned no usable body: TikTok Business Center help article 10009419, TikTok Business API portal doc, WhatsApp template fundamentals, WhatsApp webhook/signature reference, LinkedIn pages (only heading-level excerpts returned). Claims drawn from them are marked.
- TikTok Business Messaging details come from Chatwoot and respond.io, not TikTok.
- LinkedIn messaging gating comes mostly from search summaries and vendor blogs.
- Prices, dates and tiers change frequently. Re-verify before implementation.

## 10. Sources (retrieved 2026-11-13)

- https://developers.facebook.com/docs/whatsapp/pricing
- https://developers.facebook.com/docs/whatsapp/cloud-api/get-started
- https://developers.facebook.com/docs/whatsapp/embedded-signup/overview
- https://developers.facebook.com/docs/whatsapp/messaging-limits
- https://developers.facebook.com/documentation/business-messaging/instagram-messaging/overview
- https://developers.tiktok.com/doc/login-kit-manage-user-access-tokens
- https://developers.tiktok.com/doc/content-sharing-guidelines
- https://ads.tiktok.com/help/article?aid=10001704 (partial)
- https://developers.chatwoot.com/self-hosted/configuration/features/integrations/tiktok (third-party)
- https://respond.io/help/tiktok/tiktok-overview (third-party)
- https://stape.io/helpdesk/documentation/how-to-set-up-tiktok-events-api (third-party)
- https://learn.microsoft.com/en-us/linkedin/marketing/lead-sync/leadsync
- https://learn.microsoft.com/en-us/linkedin/marketing/community-management/community-management-overview
- https://learn.microsoft.com/en-us/linkedin/shared/integrations/communications/messages (search result only)
