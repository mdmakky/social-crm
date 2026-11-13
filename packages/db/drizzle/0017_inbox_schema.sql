CREATE TABLE "conversation_reads" (
	"workspace_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"last_read_seq" bigint DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "conversation_reads_conversation_id_user_id_pk" PRIMARY KEY("conversation_id","user_id"),
	CONSTRAINT "conversation_reads_seq" CHECK ("conversation_reads"."last_read_seq" >= 0)
);
--> statement-breakpoint
CREATE TABLE "conversations" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"integration_account_id" uuid NOT NULL,
	"identity_id" uuid NOT NULL,
	"contact_id" uuid NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"assignee_user_id" text,
	"last_message_at" timestamp with time zone,
	"last_inbound_at" timestamp with time zone,
	"message_seq" bigint DEFAULT 0 NOT NULL,
	"contact_delivered_at" timestamp with time zone,
	"contact_read_at" timestamp with time zone,
	"lead_id" uuid,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "conversations_ws_id" UNIQUE("workspace_id","id"),
	CONSTRAINT "conversations_ws_id_account" UNIQUE("workspace_id","id","integration_account_id"),
	CONSTRAINT "conversations_account_identity" UNIQUE("integration_account_id","identity_id"),
	CONSTRAINT "conversations_status" CHECK ("conversations"."status" IN ('open','pending','resolved')),
	CONSTRAINT "conversations_seq" CHECK ("conversations"."message_seq" >= 0)
);
--> statement-breakpoint
CREATE TABLE "integration_accounts" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"platform" text NOT NULL,
	"external_account_id" text NOT NULL,
	"display_name" text,
	"status" text DEFAULT 'connected' NOT NULL,
	"scopes" text[] DEFAULT '{}'::text[] NOT NULL,
	"token_expires_at" timestamp with time zone,
	"last_token_check_at" timestamp with time zone,
	"connected_by" text,
	"connected_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "integration_accounts_ws_id" UNIQUE("workspace_id","id"),
	CONSTRAINT "integration_accounts_platform_external" UNIQUE("platform","external_account_id"),
	CONSTRAINT "integration_accounts_platform" CHECK ("integration_accounts"."platform" IN ('messenger','instagram')),
	CONSTRAINT "integration_accounts_status" CHECK ("integration_accounts"."status" IN ('connected','reauth_required','disabled')),
	CONSTRAINT "integration_accounts_external_id" CHECK ("integration_accounts"."external_account_id" ~ '^[1-9][0-9]{0,99}$'),
	CONSTRAINT "integration_accounts_display_name" CHECK ("integration_accounts"."display_name" IS NULL OR char_length("integration_accounts"."display_name") <= 200)
);
--> statement-breakpoint
CREATE TABLE "integration_events" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"integration_account_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"actor_user_id" text,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "integration_events_kind" CHECK ("integration_events"."kind" IN ('connected','reconnected','disconnected','token_checked','status_changed','delivery_decision'))
);
--> statement-breakpoint
CREATE TABLE "integration_secrets" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"integration_account_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"ciphertext" "bytea" NOT NULL,
	"nonce" "bytea" NOT NULL,
	"key_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "integration_secrets_account_version" UNIQUE("integration_account_id","version"),
	CONSTRAINT "integration_secrets_version" CHECK ("integration_secrets"."version" >= 1),
	CONSTRAINT "integration_secrets_nonce_len" CHECK (octet_length("integration_secrets"."nonce") = 12),
	CONSTRAINT "integration_secrets_key_id" CHECK (char_length("integration_secrets"."key_id") BETWEEN 1 AND 64),
	CONSTRAINT "integration_secrets_ciphertext_len" CHECK (octet_length("integration_secrets"."ciphertext") BETWEEN 17 AND 4096)
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"integration_account_id" uuid NOT NULL,
	"direction" text NOT NULL,
	"external_id" text,
	"client_msg_id" uuid,
	"sender_kind" text NOT NULL,
	"sender_user_id" text,
	"body" text,
	"attachments" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"delivery_state" text NOT NULL,
	"failure_code" text,
	"seq" bigint DEFAULT 0 NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"state_changed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "messages_ws_id" UNIQUE("workspace_id","id"),
	CONSTRAINT "messages_conversation_seq" UNIQUE("workspace_id","conversation_id","seq"),
	CONSTRAINT "messages_direction" CHECK ("messages"."direction" IN ('in','out')),
	CONSTRAINT "messages_delivery_state" CHECK ("messages"."delivery_state" IN ('received','pending','sending','sent','failed','unknown')),
	CONSTRAINT "messages_sender_kind" CHECK ("messages"."sender_kind" IN ('contact','user','external','system')),
	CONSTRAINT "messages_direction_shape" CHECK (("messages"."direction" = 'in' AND "messages"."delivery_state" = 'received' AND "messages"."sender_kind" = 'contact' AND "messages"."sender_user_id" IS NULL AND "messages"."external_id" IS NOT NULL) OR ("messages"."direction" = 'out' AND "messages"."delivery_state" <> 'received' AND "messages"."sender_kind" <> 'contact' AND ("messages"."sender_kind" = 'user' OR "messages"."external_id" IS NOT NULL))),
	CONSTRAINT "messages_seq" CHECK ("messages"."seq" >= 0),
	CONSTRAINT "messages_user_sender" CHECK ("messages"."sender_kind" <> 'user' OR "messages"."sender_user_id" IS NOT NULL),
	CONSTRAINT "messages_content" CHECK ("messages"."body" IS NOT NULL OR jsonb_array_length("messages"."attachments") > 0),
	CONSTRAINT "messages_body_len" CHECK ("messages"."body" IS NULL OR char_length("messages"."body") <= 20000),
	CONSTRAINT "messages_attachments" CHECK (jsonb_typeof("messages"."attachments") = 'array' AND jsonb_array_length("messages"."attachments") <= 20),
	CONSTRAINT "messages_failure_code" CHECK ("messages"."failure_code" IS NULL OR char_length("messages"."failure_code") <= 100)
);
--> statement-breakpoint
CREATE TABLE "outbound_attempts" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"message_id" uuid NOT NULL,
	"attempt" integer NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"request_summary" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"http_status" integer,
	"platform_error_code" text,
	"outcome" text,
	CONSTRAINT "outbound_attempts_message_attempt" UNIQUE("message_id","attempt"),
	CONSTRAINT "outbound_attempts_outcome" CHECK ("outbound_attempts"."outcome" IS NULL OR "outbound_attempts"."outcome" IN ('accepted','rejected','ambiguous')),
	CONSTRAINT "outbound_attempts_attempt" CHECK ("outbound_attempts"."attempt" >= 1)
);
--> statement-breakpoint
CREATE TABLE "platform_identities" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"integration_account_id" uuid NOT NULL,
	"external_user_id" text NOT NULL,
	"contact_id" uuid NOT NULL,
	"profile_name" text,
	"profile_fetched_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "platform_identities_ws_account_id" UNIQUE("workspace_id","integration_account_id","id"),
	CONSTRAINT "platform_identities_ws_account_id_contact" UNIQUE("workspace_id","integration_account_id","id","contact_id"),
	CONSTRAINT "platform_identities_account_user" UNIQUE("integration_account_id","external_user_id"),
	CONSTRAINT "platform_identities_external_user" CHECK ("platform_identities"."external_user_id" ~ '^[1-9][0-9]{0,99}$')
);
--> statement-breakpoint
CREATE TABLE "webhook_events" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"workspace_id" uuid,
	"platform" text NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"signature_valid" boolean NOT NULL,
	"raw_body" "bytea",
	"body_sha256" "bytea",
	"body_size" integer NOT NULL,
	"account_ref" text,
	"status" text DEFAULT 'received' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"processed_at" timestamp with time zone,
	"body_purged_at" timestamp with time zone,
	CONSTRAINT "webhook_events_platform" CHECK ("webhook_events"."platform" IN ('messenger','instagram')),
	CONSTRAINT "webhook_events_status" CHECK ("webhook_events"."status" IN ('received','processed','failed','orphan','rejected')),
	CONSTRAINT "webhook_events_signature" CHECK ("webhook_events"."signature_valid" OR ("webhook_events"."status" = 'rejected' AND "webhook_events"."raw_body" IS NULL)),
	CONSTRAINT "webhook_events_body_present" CHECK ("webhook_events"."raw_body" IS NOT NULL OR "webhook_events"."body_purged_at" IS NOT NULL OR "webhook_events"."status" = 'rejected'),
	CONSTRAINT "webhook_events_body_size" CHECK ("webhook_events"."body_size" >= 0 AND "webhook_events"."body_size" <= 1048576),
	CONSTRAINT "webhook_events_body_limit" CHECK ("webhook_events"."raw_body" IS NULL OR octet_length("webhook_events"."raw_body") <= 1048576),
	CONSTRAINT "webhook_events_sha" CHECK ("webhook_events"."body_sha256" IS NULL OR octet_length("webhook_events"."body_sha256") = 32),
	CONSTRAINT "webhook_events_last_error" CHECK ("webhook_events"."last_error" IS NULL OR char_length("webhook_events"."last_error") <= 100)
);
--> statement-breakpoint
ALTER TABLE "conversation_reads" ADD CONSTRAINT "conversation_reads_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_reads" ADD CONSTRAINT "conversation_reads_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_reads" ADD CONSTRAINT "conversation_reads_workspace_id_conversation_id_conversations_workspace_id_id_fk" FOREIGN KEY ("workspace_id","conversation_id") REFERENCES "public"."conversations"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_assignee_user_id_user_id_fk" FOREIGN KEY ("assignee_user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_workspace_id_integration_account_id_identity_id_contact_id_platform_identities_workspace_id_integration_account_id_id_contact_id_fk" FOREIGN KEY ("workspace_id","integration_account_id","identity_id","contact_id") REFERENCES "public"."platform_identities"("workspace_id","integration_account_id","id","contact_id") ON DELETE no action ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_workspace_id_assignee_user_id_memberships_workspace_id_user_id_fk" FOREIGN KEY ("workspace_id","assignee_user_id") REFERENCES "public"."memberships"("workspace_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_workspace_id_contact_id_contacts_workspace_id_id_fk" FOREIGN KEY ("workspace_id","contact_id") REFERENCES "public"."contacts"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_workspace_id_lead_id_leads_workspace_id_id_fk" FOREIGN KEY ("workspace_id","lead_id") REFERENCES "public"."leads"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_accounts" ADD CONSTRAINT "integration_accounts_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_accounts" ADD CONSTRAINT "integration_accounts_connected_by_user_id_fk" FOREIGN KEY ("connected_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_events" ADD CONSTRAINT "integration_events_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_events" ADD CONSTRAINT "integration_events_actor_user_id_user_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_events" ADD CONSTRAINT "integration_events_workspace_id_integration_account_id_integration_accounts_workspace_id_id_fk" FOREIGN KEY ("workspace_id","integration_account_id") REFERENCES "public"."integration_accounts"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_secrets" ADD CONSTRAINT "integration_secrets_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_secrets" ADD CONSTRAINT "integration_secrets_workspace_id_integration_account_id_integration_accounts_workspace_id_id_fk" FOREIGN KEY ("workspace_id","integration_account_id") REFERENCES "public"."integration_accounts"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_sender_user_id_user_id_fk" FOREIGN KEY ("sender_user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_workspace_id_conversation_id_integration_account_id_conversations_workspace_id_id_integration_account_id_fk" FOREIGN KEY ("workspace_id","conversation_id","integration_account_id") REFERENCES "public"."conversations"("workspace_id","id","integration_account_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbound_attempts" ADD CONSTRAINT "outbound_attempts_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbound_attempts" ADD CONSTRAINT "outbound_attempts_workspace_id_message_id_messages_workspace_id_id_fk" FOREIGN KEY ("workspace_id","message_id") REFERENCES "public"."messages"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform_identities" ADD CONSTRAINT "platform_identities_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform_identities" ADD CONSTRAINT "platform_identities_workspace_id_integration_account_id_integration_accounts_workspace_id_id_fk" FOREIGN KEY ("workspace_id","integration_account_id") REFERENCES "public"."integration_accounts"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform_identities" ADD CONSTRAINT "platform_identities_workspace_id_contact_id_contacts_workspace_id_id_fk" FOREIGN KEY ("workspace_id","contact_id") REFERENCES "public"."contacts"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_events" ADD CONSTRAINT "webhook_events_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "conversations_list_idx" ON "conversations" USING btree ("workspace_id","last_message_at" DESC NULLS LAST,"id");--> statement-breakpoint
CREATE INDEX "conversations_assignee_idx" ON "conversations" USING btree ("workspace_id","assignee_user_id","status");--> statement-breakpoint
CREATE INDEX "conversations_contact_idx" ON "conversations" USING btree ("workspace_id","contact_id");--> statement-breakpoint
CREATE INDEX "integration_events_account_idx" ON "integration_events" USING btree ("workspace_id","integration_account_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "messages_account_external_uq" ON "messages" USING btree ("integration_account_id","external_id") WHERE "messages"."external_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "messages_ws_client_msg_uq" ON "messages" USING btree ("workspace_id","client_msg_id") WHERE "messages"."client_msg_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "messages_unread_idx" ON "messages" USING btree ("workspace_id","conversation_id","seq") WHERE "messages"."direction" = 'in';--> statement-breakpoint
CREATE INDEX "messages_thread_idx" ON "messages" USING btree ("workspace_id","conversation_id","occurred_at" DESC NULLS LAST,"id");--> statement-breakpoint
CREATE INDEX "messages_pending_idx" ON "messages" USING btree ("delivery_state","created_at") WHERE "messages"."delivery_state" IN ('pending','sending','unknown');--> statement-breakpoint
CREATE INDEX "platform_identities_contact_idx" ON "platform_identities" USING btree ("workspace_id","contact_id");--> statement-breakpoint
CREATE INDEX "webhook_events_queue_idx" ON "webhook_events" USING btree ("status","received_at") WHERE "webhook_events"."status" IN ('received','failed');--> statement-breakpoint
CREATE INDEX "webhook_events_purge_idx" ON "webhook_events" USING btree ("received_at") WHERE "webhook_events"."raw_body" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "webhook_events_workspace_idx" ON "webhook_events" USING btree ("workspace_id","received_at" DESC NULLS LAST);