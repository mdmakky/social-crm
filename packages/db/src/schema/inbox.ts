import { sql } from "drizzle-orm";
import { bigint, boolean, check, customType, foreignKey, index, integer, jsonb, pgTable, primaryKey, text, timestamp, unique, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { user } from "../auth-schema.ts";
import { contacts } from "./crm.ts";
import { leads } from "./leads.ts";
import { memberships, workspaces } from "./tenancy.ts";

const id = () => uuid("id").primaryKey().default(sql`uuidv7()`);
const workspaceId = () => uuid("workspace_id").notNull().references(() => workspaces.id);
const ts = (n: string) => timestamp(n, { withTimezone: true });
const bytea = customType<{ data: Buffer; driverData: Buffer }>({ dataType: () => "bytea" });

export const INBOX_PLATFORMS = ["messenger", "instagram", "whatsapp", "telegram", "email", "web_chat"] as const;
export const INTEGRATION_STATUSES = ["connected", "reauth_required", "disabled"] as const;
export const CONVERSATION_STATUSES = ["open", "pending", "resolved"] as const;
export const DELIVERY_STATES = ["received", "pending", "sending", "sent", "failed", "unknown"] as const;
export const WEBHOOK_STATUSES = ["received", "processed", "failed", "orphan", "rejected"] as const;

/**
 * A connected Page or Instagram professional account. (platform, external_account_id) is GLOBALLY unique (decision D-F):
 * one external account belongs to exactly one workspace, which is what makes webhook routing safe.
 */
export const integrationAccounts = pgTable(
  "integration_accounts",
  {
    id: id(),
    workspaceId: workspaceId(),
    platform: text("platform").notNull(),
    externalAccountId: text("external_account_id").notNull(),
    displayName: text("display_name"),
    status: text("status").notNull().default("connected"),
    scopes: text("scopes").array().notNull().default(sql`'{}'::text[]`),
    tokenExpiresAt: ts("token_expires_at"),
    lastTokenCheckAt: ts("last_token_check_at"),
    connectedBy: text("connected_by").references(() => user.id),
    /** Keyed hash (HMAC) of the app-scoped Meta user id of the person who authorised this account. Lets the deauthorization and data-deletion callbacks find the connections of that person without storing the raw id. */
    connectedMetaUserHash: text("connected_meta_user_hash"),
    connectedAt: ts("connected_at").notNull().defaultNow(),
    /** How the account was authorised: 'facebook' (Page token) or 'unified' (Instagram API with Unified Login: system-user token, no Page). Only Instagram accounts can use 'unified'. */
    authMethod: text("auth_method").notNull().default("facebook"),
    version: integer("version").notNull().default(1),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [
    check("integration_accounts_auth_method", sql`${t.authMethod} IN ('facebook','unified')`),
    check("integration_accounts_auth_method_platform", sql`${t.authMethod} = 'facebook' OR ${t.platform} = 'instagram'`),
    unique("integration_accounts_ws_id").on(t.workspaceId, t.id),
    unique("integration_accounts_platform_external").on(t.platform, t.externalAccountId),
    check("integration_accounts_platform", sql`${t.platform} IN ('messenger','instagram','whatsapp','telegram','email','web_chat')`),
    check("integration_accounts_status", sql`${t.status} IN ('connected','reauth_required','disabled')`),
    // Page and Instagram account ids are numeric strings (to be reconfirmed with the real app). Digits only: no whitespace, zero-padding variants or look-alike characters can create a second key for the same account.
    check("integration_accounts_external_id", sql`${t.externalAccountId} ~ '^[1-9][0-9]{0,99}$' OR (${t.platform} = 'email' AND ${t.externalAccountId} ~ '^[a-z2-7]{20}$')`),
    index("integration_accounts_meta_user_idx").on(t.connectedMetaUserHash).where(sql`${t.connectedMetaUserHash} IS NOT NULL`),
    check("integration_accounts_meta_user_hash", sql`${t.connectedMetaUserHash} IS NULL OR ${t.connectedMetaUserHash} ~ '^[0-9a-f]{64}$'`),
    check("integration_accounts_display_name", sql`${t.displayName} IS NULL OR char_length(${t.displayName}) <= 200`),
  ],
);

/**
 * Encrypted platform token. The application role can INSERT but never SELECT, UPDATE or DELETE (see migration 0018);
 * only the worker role reads it. Encryption is AES-256-GCM with an environment key in owner-only development (NOT production grade, KMS before external users).
 */
export const integrationSecrets = pgTable(
  "integration_secrets",
  {
    id: id(),
    workspaceId: workspaceId(),
    integrationAccountId: uuid("integration_account_id").notNull(),
    version: integer("version").notNull(),
    ciphertext: bytea("ciphertext").notNull(),
    nonce: bytea("nonce").notNull(),
    keyId: text("key_id").notNull(),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [
    foreignKey({ columns: [t.workspaceId, t.integrationAccountId], foreignColumns: [integrationAccounts.workspaceId, integrationAccounts.id] }),
    unique("integration_secrets_account_version").on(t.integrationAccountId, t.version),
    check("integration_secrets_version", sql`${t.version} >= 1`),
    check("integration_secrets_nonce_len", sql`octet_length(${t.nonce}) = 12`),
    check("integration_secrets_key_id", sql`char_length(${t.keyId}) BETWEEN 1 AND 64`),
    check("integration_secrets_ciphertext_len", sql`octet_length(${t.ciphertext}) BETWEEN 17 AND 4096`),
  ],
);

/** A page-scoped user id (PSID or IGSID) on one account, linked to a contact. */
export const platformIdentities = pgTable(
  "platform_identities",
  {
    id: id(),
    workspaceId: workspaceId(),
    integrationAccountId: uuid("integration_account_id").notNull(),
    externalUserId: text("external_user_id").notNull(),
    contactId: uuid("contact_id").notNull(),
    profileName: text("profile_name"),
    profileFetchedAt: ts("profile_fetched_at"),
    profilePicUrl: text("profile_pic_url"),
    profileStatus: text("profile_status"),
    profileAttempts: integer("profile_attempts").notNull().default(0),
    profileRetryAt: ts("profile_retry_at"),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [
    unique("platform_identities_ws_account_id").on(t.workspaceId, t.integrationAccountId, t.id),
    check("platform_identities_profile_status", sql`${t.profileStatus} IS NULL OR ${t.profileStatus} IN ('ok','unavailable','denied','error')`),
    check("platform_identities_profile_pic", sql`${t.profilePicUrl} IS NULL OR (${t.profilePicUrl} ~ '^https://' AND length(${t.profilePicUrl}) <= 2048)`),
    unique("platform_identities_ws_account_id_contact").on(t.workspaceId, t.integrationAccountId, t.id, t.contactId),
    unique("platform_identities_account_user").on(t.integrationAccountId, t.externalUserId),
    foreignKey({ columns: [t.workspaceId, t.integrationAccountId], foreignColumns: [integrationAccounts.workspaceId, integrationAccounts.id] }),
    foreignKey({ columns: [t.workspaceId, t.contactId], foreignColumns: [contacts.workspaceId, contacts.id] }),
    check("platform_identities_external_user", sql`${t.externalUserId} ~ '^[1-9][0-9]{0,99}$' OR (${t.externalUserId} ~ '^email(-unverified)?:[^[:space:]@<>]{1,200}@[^[:space:]@<>]{1,100}$' AND char_length(${t.externalUserId}) <= 330)`),
    index("platform_identities_contact_idx").on(t.workspaceId, t.contactId),
  ],
);

export const conversations = pgTable(
  "conversations",
  {
    id: id(),
    workspaceId: workspaceId(),
    integrationAccountId: uuid("integration_account_id").notNull(),
    identityId: uuid("identity_id").notNull(),
    contactId: uuid("contact_id").notNull(),
    status: text("status").notNull().default("open"),
    assigneeUserId: text("assignee_user_id").references(() => user.id),
    lastMessageAt: ts("last_message_at"),
    /** Start of the 24 hour reply window; set only by inbound messages. */
    lastInboundAt: ts("last_inbound_at"),
    /** Last message sequence number handed out in this conversation (assigned by a trigger under the row lock, so seq order is commit order). Unread is derived from it: see conversation_reads. */
    messageSeq: bigint("message_seq", { mode: "number" }).notNull().default(0),
    /** Watermarks reported by the platform (what the contact has delivered/read); only ever move forward. */
    contactDeliveredAt: ts("contact_delivered_at"),
    contactReadAt: ts("contact_read_at"),
    /** Telegram: set when the person blocked the bot (my_chat_member), cleared when they unblock or write again. Replies are refused while set. */
    contactUnreachableAt: ts("contact_unreachable_at"),
    leadId: uuid("lead_id"),
    version: integer("version").notNull().default(1),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [
    unique("conversations_ws_id").on(t.workspaceId, t.id),
    unique("conversations_ws_id_account").on(t.workspaceId, t.id, t.integrationAccountId),
    unique("conversations_account_identity").on(t.integrationAccountId, t.identityId),
    // the identity must belong to the same account and workspace, and the conversation's contact is always the identity's contact (a merge updates both at once)
    foreignKey({ columns: [t.workspaceId, t.integrationAccountId, t.identityId, t.contactId], foreignColumns: [platformIdentities.workspaceId, platformIdentities.integrationAccountId, platformIdentities.id, platformIdentities.contactId] }).onUpdate("cascade"),
    // an assignee must be a member of the same workspace
    foreignKey({ columns: [t.workspaceId, t.assigneeUserId], foreignColumns: [memberships.workspaceId, memberships.userId] }),
    foreignKey({ columns: [t.workspaceId, t.contactId], foreignColumns: [contacts.workspaceId, contacts.id] }),
    foreignKey({ columns: [t.workspaceId, t.leadId], foreignColumns: [leads.workspaceId, leads.id] }),
    check("conversations_status", sql`${t.status} IN ('open','pending','resolved')`),
    check("conversations_seq", sql`${t.messageSeq} >= 0`),
    index("conversations_list_idx").on(t.workspaceId, t.lastMessageAt.desc(), t.id),
    index("conversations_assignee_idx").on(t.workspaceId, t.assigneeUserId, t.status),
    index("conversations_contact_idx").on(t.workspaceId, t.contactId),
  ],
);

export const messages = pgTable(
  "messages",
  {
    id: id(),
    workspaceId: workspaceId(),
    conversationId: uuid("conversation_id").notNull(),
    integrationAccountId: uuid("integration_account_id").notNull(),
    direction: text("direction").notNull(),
    /** Platform message id (mid). Null until an outbound message is accepted. Unique per account: the inbound idempotency key. */
    externalId: text("external_id"),
    /** Outbound idempotency key chosen by the client. */
    clientMsgId: uuid("client_msg_id"),
    senderKind: text("sender_kind").notNull(),
    senderUserId: text("sender_user_id").references(() => user.id),
    body: text("body"),
    attachments: jsonb("attachments").notNull().default([]),
    deliveryState: text("delivery_state").notNull(),
    failureCode: text("failure_code"),
    /** Position in the conversation: strictly increasing in commit order (trigger). The unread cursor of every user is a seq. */
    seq: bigint("seq", { mode: "number" }).notNull().default(0),
    /** Platform time for inbound messages; creation time for outbound (set by the database for the application role). */
    occurredAt: ts("occurred_at").notNull().defaultNow(),
    /** When delivery_state last changed; the 10 minute unknown window (D-G) is measured from here. */
    stateChangedAt: ts("state_changed_at").notNull().defaultNow(),
    sentAt: ts("sent_at"),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [
    unique("messages_ws_id").on(t.workspaceId, t.id),
    foreignKey({ columns: [t.workspaceId, t.conversationId, t.integrationAccountId], foreignColumns: [conversations.workspaceId, conversations.id, conversations.integrationAccountId] }),
    uniqueIndex("messages_account_external_uq").on(t.integrationAccountId, t.externalId).where(sql`${t.externalId} IS NOT NULL`),
    uniqueIndex("messages_ws_client_msg_uq").on(t.workspaceId, t.clientMsgId).where(sql`${t.clientMsgId} IS NOT NULL`),
    check("messages_direction", sql`${t.direction} IN ('in','out')`),
    check("messages_delivery_state", sql`${t.deliveryState} IN ('received','pending','sending','sent','failed','unknown')`),
    check("messages_sender_kind", sql`${t.senderKind} IN ('contact','user','external','system')`),
    // inbound: always received, from the contact; outbound: never "received", user senders carry their user id
    // inbound: always received, from the contact, with a platform id. outbound: never "received"; a message sent from our composer has no platform id until accepted, but an echo of a message sent elsewhere must carry one (idempotency)
    check("messages_direction_shape", sql`(${t.direction} = 'in' AND ${t.deliveryState} = 'received' AND ${t.senderKind} = 'contact' AND ${t.senderUserId} IS NULL AND ${t.externalId} IS NOT NULL) OR (${t.direction} = 'out' AND ${t.deliveryState} <> 'received' AND ${t.senderKind} <> 'contact' AND (${t.senderKind} = 'user' OR ${t.externalId} IS NOT NULL))`),
    check("messages_seq", sql`${t.seq} >= 0`),
    check("messages_user_sender", sql`${t.senderKind} <> 'user' OR ${t.senderUserId} IS NOT NULL`),
    check("messages_content", sql`${t.body} IS NOT NULL OR jsonb_array_length(${t.attachments}) > 0`),
    check("messages_body_len", sql`${t.body} IS NULL OR char_length(${t.body}) <= 20000`),
    check("messages_attachments", sql`jsonb_typeof(${t.attachments}) = 'array' AND jsonb_array_length(${t.attachments}) <= 20`),
    check("messages_failure_code", sql`${t.failureCode} IS NULL OR char_length(${t.failureCode}) <= 100`),
    unique("messages_conversation_seq").on(t.workspaceId, t.conversationId, t.seq),
    index("messages_unread_idx").on(t.workspaceId, t.conversationId, t.seq).where(sql`${t.direction} = 'in'`),
    index("messages_thread_idx").on(t.workspaceId, t.conversationId, t.occurredAt.desc(), t.id),
    index("messages_pending_idx").on(t.deliveryState, t.createdAt).where(sql`${t.deliveryState} IN ('pending','sending','unknown')`),
  ],
);

export const conversationReads = pgTable(
  "conversation_reads",
  {
    workspaceId: workspaceId(),
    conversationId: uuid("conversation_id").notNull(),
    userId: text("user_id").notNull().references(() => user.id),
    /** The highest message seq this user has actually seen. Unread = inbound messages with a larger seq. Only ever moves forward and never past the conversation's last seq. */
    lastReadSeq: bigint("last_read_seq", { mode: "number" }).notNull().default(0),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.conversationId, t.userId] }),
    check("conversation_reads_seq", sql`${t.lastReadSeq} >= 0`),
    foreignKey({ columns: [t.workspaceId, t.conversationId], foreignColumns: [conversations.workspaceId, conversations.id] }),
  ],
);

/**
 * Raw webhook ingress. Written by the dedicated ingress role (INSERT only). workspace_id is NULL until the account is routed;
 * it is only ever derived from (platform, account) after the signature verified, never from the payload. Raw bodies are purged after 30 days (D-E).
 */
export const webhookEvents = pgTable(
  "webhook_events",
  {
    id: id(),
    workspaceId: uuid("workspace_id").references(() => workspaces.id),
    platform: text("platform").notNull(),
    receivedAt: ts("received_at").notNull().defaultNow(),
    signatureValid: boolean("signature_valid").notNull(),
    rawBody: bytea("raw_body"),
    bodySha256: bytea("body_sha256"),
    bodySize: integer("body_size").notNull(),
    accountRef: text("account_ref"),
    status: text("status").notNull().default("received"),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
    processedAt: ts("processed_at"),
    bodyPurgedAt: ts("body_purged_at"),
  },
  (t) => [
    check("webhook_events_platform", sql`${t.platform} IN ('messenger','instagram','whatsapp','telegram','email','web_chat')`),
    check("webhook_events_status", sql`${t.status} IN ('received','processed','failed','orphan','rejected')`),
    // an event that failed signature verification can only ever be "rejected" and never carries a body
    check("webhook_events_signature", sql`${t.signatureValid} OR (${t.status} = 'rejected' AND ${t.rawBody} IS NULL)`),
    check("webhook_events_body_present", sql`${t.rawBody} IS NOT NULL OR ${t.bodyPurgedAt} IS NOT NULL OR ${t.status} = 'rejected'`),
    check("webhook_events_body_size", sql`${t.bodySize} >= 0 AND ${t.bodySize} <= 1048576`),
    check("webhook_events_body_limit", sql`${t.rawBody} IS NULL OR octet_length(${t.rawBody}) <= 1048576`),
    check("webhook_events_sha", sql`${t.bodySha256} IS NULL OR octet_length(${t.bodySha256}) = 32`),
    check("webhook_events_last_error", sql`${t.lastError} IS NULL OR char_length(${t.lastError}) <= 100`),
    index("webhook_events_queue_idx").on(t.status, t.receivedAt).where(sql`${t.status} IN ('received','failed')`),
    index("webhook_events_purge_idx").on(t.receivedAt).where(sql`${t.rawBody} IS NOT NULL`),
    index("webhook_events_workspace_idx").on(t.workspaceId, t.receivedAt.desc()),
  ],
);

/** Append-only record of every send attempt. */
export const outboundAttempts = pgTable(
  "outbound_attempts",
  {
    id: id(),
    workspaceId: workspaceId(),
    messageId: uuid("message_id").notNull(),
    attempt: integer("attempt").notNull(),
    startedAt: ts("started_at").notNull().defaultNow(),
    finishedAt: ts("finished_at"),
    requestSummary: jsonb("request_summary").notNull().default({}),
    httpStatus: integer("http_status"),
    platformErrorCode: text("platform_error_code"),
    outcome: text("outcome"),
  },
  (t) => [
    unique("outbound_attempts_message_attempt").on(t.messageId, t.attempt),
    check("outbound_attempts_outcome", sql`${t.outcome} IS NULL OR ${t.outcome} IN ('accepted','rejected','ambiguous')`),
    check("outbound_attempts_attempt", sql`${t.attempt} >= 1`),
    foreignKey({ columns: [t.workspaceId, t.messageId], foreignColumns: [messages.workspaceId, messages.id] }),
  ],
);

/** Append-only audit of connect, reconnect, disconnect, token checks and human delivery decisions. */
export const integrationEvents = pgTable(
  "integration_events",
  {
    id: id(),
    workspaceId: workspaceId(),
    integrationAccountId: uuid("integration_account_id").notNull(),
    kind: text("kind").notNull(),
    actorUserId: text("actor_user_id").references(() => user.id),
    data: jsonb("data").notNull().default({}),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [
    foreignKey({ columns: [t.workspaceId, t.integrationAccountId], foreignColumns: [integrationAccounts.workspaceId, integrationAccounts.id] }),
    check("integration_events_kind", sql`${t.kind} IN ('connected','reconnected','disconnected','token_checked','status_changed','delivery_decision')`),
    index("integration_events_account_idx").on(t.workspaceId, t.integrationAccountId, t.createdAt.desc()),
  ],
);

/**
 * What only a WhatsApp account has, 1:1 with its integration account (platform = 'whatsapp', external_account_id = the phone number id). Written by the worker role, read by members.
 * The WABA id is not the routing key: one WABA can own several phone numbers, and webhooks are routed by the phone number id.
 */
export const whatsappAccounts = pgTable(
  "whatsapp_accounts",
  {
    id: id(),
    workspaceId: workspaceId(),
    integrationAccountId: uuid("integration_account_id").notNull(),
    wabaId: text("waba_id").notNull(),
    displayPhoneNumber: text("display_phone_number"),
    /** 'cloud_api' (a number registered with the Cloud API) or 'coexistence' (also used in the WhatsApp Business app, slice 4). */
    mode: text("mode").notNull().default("cloud_api"),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [
    unique("whatsapp_accounts_account").on(t.integrationAccountId),
    unique("whatsapp_accounts_ws_id").on(t.workspaceId, t.id),
    foreignKey({ columns: [t.workspaceId, t.integrationAccountId], foreignColumns: [integrationAccounts.workspaceId, integrationAccounts.id], name: "whatsapp_accounts_account_fk" }),
    index("whatsapp_accounts_waba_idx").on(t.wabaId),
    check("whatsapp_accounts_waba", sql`${t.wabaId} ~ '^[1-9][0-9]{0,99}$'`),
    check("whatsapp_accounts_display", sql`${t.displayPhoneNumber} IS NULL OR char_length(${t.displayPhoneNumber}) <= 40`),
    check("whatsapp_accounts_mode", sql`${t.mode} IN ('cloud_api','coexistence')`),
  ],
);

/**
 * What only a Telegram bot account has, 1:1 with its integration account (platform = 'telegram', external_account_id = the bot id from getMe). Written by the worker role.
 * `webhookPathId` (unguessable, in the webhook URL) and `secretHash` (SHA-256 of the secret_token Telegram echoes in a header) are never granted to the application role.
 */
export const telegramAccounts = pgTable(
  "telegram_accounts",
  {
    id: id(),
    workspaceId: workspaceId(),
    integrationAccountId: uuid("integration_account_id").notNull(),
    botId: text("bot_id").notNull(),
    botUsername: text("bot_username"),
    webhookPathId: text("webhook_path_id").notNull(),
    secretHash: text("secret_hash").notNull(),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [
    unique("telegram_accounts_account").on(t.integrationAccountId),
    unique("telegram_accounts_path").on(t.webhookPathId),
    unique("telegram_accounts_ws_id").on(t.workspaceId, t.id),
    foreignKey({ columns: [t.workspaceId, t.integrationAccountId], foreignColumns: [integrationAccounts.workspaceId, integrationAccounts.id], name: "telegram_accounts_account_fk" }),
    check("telegram_accounts_bot", sql`${t.botId} ~ '^[1-9][0-9]{0,19}$'`),
    check("telegram_accounts_username", sql`${t.botUsername} IS NULL OR char_length(${t.botUsername}) <= 64`),
    check("telegram_accounts_path_fmt", sql`${t.webhookPathId} ~ '^[A-Za-z0-9_-]{20,64}$'`),
    check("telegram_accounts_secret_fmt", sql`${t.secretHash} ~ '^[0-9a-f]{64}$'`),
  ],
);

/** Email channel side row of an integration account (migration 0039). inbound_token is also the account's external id: the only thing that routes an inbound email to a workspace. */
export const emailAccounts = pgTable(
  "email_accounts",
  {
    id: id(),
    workspaceId: workspaceId(),
    integrationAccountId: uuid("integration_account_id").notNull(),
    inboundToken: text("inbound_token").notNull(),
    fromAddress: text("from_address").notNull(),
    displayName: text("display_name").notNull(),
    provider: text("provider").notNull(),
    verifiedDomainStatus: text("verified_domain_status").notNull().default("unchecked"),
    lastCheckedAt: ts("last_checked_at"),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [
    unique("email_accounts_account").on(t.integrationAccountId),
    unique("email_accounts_token").on(t.inboundToken),
    unique("email_accounts_ws_id").on(t.workspaceId, t.id),
    foreignKey({ columns: [t.workspaceId, t.integrationAccountId], foreignColumns: [integrationAccounts.workspaceId, integrationAccounts.id], name: "email_accounts_account_fk" }),
    check("email_accounts_token_shape", sql`${t.inboundToken} ~ '^[a-z2-7]{20}$'`),
    check("email_accounts_provider", sql`${t.provider} IN ('mock','mailgun')`),
    check("email_accounts_domain_status", sql`${t.verifiedDomainStatus} IN ('unchecked','pending','verified','failed')`),
  ],
);

/** Opaque per-conversation token used in the Reply-To address (support+<account token>-<conv token>@domain). */
export const emailThreads = pgTable(
  "email_threads",
  {
    id: id(),
    workspaceId: workspaceId(),
    conversationId: uuid("conversation_id").notNull(),
    convToken: text("conv_token").notNull(),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [
    unique("email_threads_conversation").on(t.conversationId),
    unique("email_threads_token").on(t.convToken),
    foreignKey({ columns: [t.workspaceId, t.conversationId], foreignColumns: [conversations.workspaceId, conversations.id], name: "email_threads_conversation_fk" }),
    check("email_threads_token_shape", sql`${t.convToken} ~ '^[a-z2-7]{16}$'`),
  ],
);

/** RFC 5322 headers of one email message (in or out). header_message_id is the idempotency and threading key, unique per account. Plain text only: no HTML is ever stored. */
export const emailMessageMeta = pgTable(
  "email_message_meta",
  {
    id: id(),
    workspaceId: workspaceId(),
    integrationAccountId: uuid("integration_account_id").notNull(),
    messageId: uuid("message_id").notNull(),
    headerMessageId: text("header_message_id").notNull(),
    inReplyTo: text("in_reply_to"),
    references: text("references").array().notNull().default(sql`'{}'::text[]`),
    subject: text("subject"),
    fromAddress: text("from_address"),
    toAddress: text("to_address"),
    unverifiedSender: boolean("unverified_sender").notNull().default(false),
    attachmentsSkipped: jsonb("attachments_skipped").notNull().default([]),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [
    unique("email_message_meta_message").on(t.messageId),
    unique("email_message_meta_header_uq").on(t.integrationAccountId, t.headerMessageId),
    foreignKey({ columns: [t.workspaceId, t.integrationAccountId], foreignColumns: [integrationAccounts.workspaceId, integrationAccounts.id], name: "email_message_meta_account_fk" }),
    foreignKey({ columns: [t.workspaceId, t.messageId], foreignColumns: [messages.workspaceId, messages.id], name: "email_message_meta_message_fk" }),
  ],
);
