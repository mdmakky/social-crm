-- Email as a support inbox channel (MOCK first, no live provider verified). The workspace's support address carries an unguessable token (integration_accounts.external_account_id = email_accounts.inbound_token);
-- the worker resolves a workspace ONLY from that token in the verified recipient address. Conversations stay one per (account, sender identity); header data lives in email_message_meta, never widening messages.
ALTER TABLE "integration_accounts" DROP CONSTRAINT "integration_accounts_external_id";--> statement-breakpoint
ALTER TABLE "integration_accounts" ADD CONSTRAINT "integration_accounts_external_id" CHECK ("external_account_id" ~ '^[1-9][0-9]{0,99}$' OR ("platform" = 'email' AND "external_account_id" ~ '^[a-z2-7]{20}$'));--> statement-breakpoint
ALTER TABLE "platform_identities" DROP CONSTRAINT "platform_identities_external_user";--> statement-breakpoint
-- email:<address> is a sender whose SPF/DKIM verdict passed; email-unverified:<address> is the separate identity for senders that did not pass, so a forged From never lands in the real customer's conversation.
ALTER TABLE "platform_identities" ADD CONSTRAINT "platform_identities_external_user" CHECK ("external_user_id" ~ '^[1-9][0-9]{0,99}$' OR ("external_user_id" ~ '^email(-unverified)?:[^[:space:]@<>]{1,200}@[^[:space:]@<>]{1,100}$' AND char_length("external_user_id") <= 330));--> statement-breakpoint
ALTER TABLE "contact_methods" ADD COLUMN "undeliverable_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "contact_methods" ADD COLUMN "undeliverable_reason" text;--> statement-breakpoint
ALTER TABLE "contact_methods" ADD CONSTRAINT "contact_methods_undeliverable_reason" CHECK ("undeliverable_reason" IS NULL OR char_length("undeliverable_reason") <= 100);--> statement-breakpoint
GRANT UPDATE (undeliverable_at, undeliverable_reason) ON contact_methods TO crm_worker;--> statement-breakpoint
CREATE POLICY cm_worker_update ON contact_methods FOR UPDATE TO crm_worker USING (workspace_id = (SELECT app_workspace_id())) WITH CHECK (workspace_id = (SELECT app_workspace_id()));--> statement-breakpoint
CREATE TABLE "email_accounts" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"integration_account_id" uuid NOT NULL,
	"inbound_token" text NOT NULL,
	"from_address" text NOT NULL,
	"display_name" text NOT NULL,
	"provider" text NOT NULL,
	"verified_domain_status" text DEFAULT 'unchecked' NOT NULL,
	"last_checked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "email_accounts_account" UNIQUE("integration_account_id"),
	CONSTRAINT "email_accounts_token" UNIQUE("inbound_token"),
	CONSTRAINT "email_accounts_ws_id" UNIQUE("workspace_id","id"),
	CONSTRAINT "email_accounts_token_shape" CHECK ("inbound_token" ~ '^[a-z2-7]{20}$'),
	CONSTRAINT "email_accounts_from" CHECK ("from_address" = lower("from_address") AND "from_address" ~ '^[^[:space:]@<>]{1,64}@[^[:space:]@<>]{1,190}$'),
	CONSTRAINT "email_accounts_name" CHECK (char_length("display_name") BETWEEN 1 AND 200),
	CONSTRAINT "email_accounts_provider" CHECK ("provider" IN ('mock','mailgun')),
	CONSTRAINT "email_accounts_domain_status" CHECK ("verified_domain_status" IN ('unchecked','pending','verified','failed'))
);--> statement-breakpoint
ALTER TABLE "email_accounts" ADD CONSTRAINT "email_accounts_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_accounts" ADD CONSTRAINT "email_accounts_account_fk" FOREIGN KEY ("workspace_id","integration_account_id") REFERENCES "public"."integration_accounts"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE TABLE "email_threads" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"conv_token" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "email_threads_conversation" UNIQUE("conversation_id"),
	CONSTRAINT "email_threads_token" UNIQUE("conv_token"),
	CONSTRAINT "email_threads_token_shape" CHECK ("conv_token" ~ '^[a-z2-7]{16}$')
);--> statement-breakpoint
ALTER TABLE "email_threads" ADD CONSTRAINT "email_threads_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_threads" ADD CONSTRAINT "email_threads_conversation_fk" FOREIGN KEY ("workspace_id","conversation_id") REFERENCES "public"."conversations"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE TABLE "email_message_meta" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"integration_account_id" uuid NOT NULL,
	"message_id" uuid NOT NULL,
	"header_message_id" text NOT NULL,
	"in_reply_to" text,
	"references" text[] DEFAULT '{}'::text[] NOT NULL,
	"subject" text,
	"from_address" text,
	"to_address" text,
	"unverified_sender" boolean DEFAULT false NOT NULL,
	"attachments_skipped" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "email_message_meta_message" UNIQUE("message_id"),
	CONSTRAINT "email_message_meta_header_uq" UNIQUE("integration_account_id","header_message_id"),
	CONSTRAINT "email_message_meta_lens" CHECK (char_length("header_message_id") BETWEEN 1 AND 998 AND ("in_reply_to" IS NULL OR char_length("in_reply_to") <= 998) AND ("subject" IS NULL OR char_length("subject") <= 998) AND ("from_address" IS NULL OR char_length("from_address") <= 320) AND ("to_address" IS NULL OR char_length("to_address") <= 320)),
	CONSTRAINT "email_message_meta_refs" CHECK (cardinality("references") <= 50),
	CONSTRAINT "email_message_meta_skipped" CHECK (jsonb_typeof("attachments_skipped") = 'array' AND jsonb_array_length("attachments_skipped") <= 20)
);--> statement-breakpoint
ALTER TABLE "email_message_meta" ADD CONSTRAINT "email_message_meta_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_message_meta" ADD CONSTRAINT "email_message_meta_account_fk" FOREIGN KEY ("workspace_id","integration_account_id") REFERENCES "public"."integration_accounts"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_message_meta" ADD CONSTRAINT "email_message_meta_message_fk" FOREIGN KEY ("workspace_id","message_id") REFERENCES "public"."messages"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE email_accounts ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE email_accounts FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE email_threads ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE email_threads FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE email_message_meta ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE email_message_meta FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON email_accounts, email_threads, email_message_meta FROM crm_app;--> statement-breakpoint
GRANT SELECT ON email_accounts, email_threads, email_message_meta TO crm_app;--> statement-breakpoint
GRANT SELECT, INSERT ON email_accounts, email_threads, email_message_meta TO crm_worker;--> statement-breakpoint
GRANT UPDATE (verified_domain_status, last_checked_at, display_name, updated_at) ON email_accounts TO crm_worker;--> statement-breakpoint
CREATE POLICY ea_select ON email_accounts FOR SELECT TO crm_app USING (workspace_id = (SELECT app_workspace_id()) AND (SELECT app_has_role(array['owner','admin','agent','viewer'])));--> statement-breakpoint
CREATE POLICY ea_worker_select ON email_accounts FOR SELECT TO crm_worker USING (workspace_id = (SELECT app_workspace_id()));--> statement-breakpoint
CREATE POLICY ea_worker_insert ON email_accounts FOR INSERT TO crm_worker WITH CHECK (workspace_id = (SELECT app_workspace_id()));--> statement-breakpoint
CREATE POLICY ea_worker_update ON email_accounts FOR UPDATE TO crm_worker USING (workspace_id = (SELECT app_workspace_id())) WITH CHECK (workspace_id = (SELECT app_workspace_id()));--> statement-breakpoint
CREATE POLICY et_select ON email_threads FOR SELECT TO crm_app USING (workspace_id = (SELECT app_workspace_id()) AND (SELECT app_has_role(array['owner','admin','agent','viewer'])));--> statement-breakpoint
CREATE POLICY et_worker_select ON email_threads FOR SELECT TO crm_worker USING (workspace_id = (SELECT app_workspace_id()));--> statement-breakpoint
CREATE POLICY et_worker_insert ON email_threads FOR INSERT TO crm_worker WITH CHECK (workspace_id = (SELECT app_workspace_id()));--> statement-breakpoint
CREATE POLICY em_select ON email_message_meta FOR SELECT TO crm_app USING (workspace_id = (SELECT app_workspace_id()) AND (SELECT app_has_role(array['owner','admin','agent','viewer'])));--> statement-breakpoint
CREATE POLICY em_worker_select ON email_message_meta FOR SELECT TO crm_worker USING (workspace_id = (SELECT app_workspace_id()));--> statement-breakpoint
CREATE POLICY em_worker_insert ON email_message_meta FOR INSERT TO crm_worker WITH CHECK (workspace_id = (SELECT app_workspace_id()));--> statement-breakpoint
-- An email account row can only describe an email integration account of the same workspace whose external id is its inbound token; identity never changes.
CREATE FUNCTION email_accounts_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NOT EXISTS (SELECT 1 FROM integration_accounts a WHERE a.id = NEW.integration_account_id AND a.workspace_id = NEW.workspace_id AND a.platform = 'email' AND a.external_account_id = NEW.inbound_token) THEN
      RAISE EXCEPTION 'an email account row must belong to an email integration account of the same workspace with the same token';
    END IF;
  ELSIF NEW.id <> OLD.id OR NEW.workspace_id <> OLD.workspace_id OR NEW.integration_account_id <> OLD.integration_account_id OR NEW.inbound_token <> OLD.inbound_token OR NEW.from_address <> OLD.from_address OR NEW.provider <> OLD.provider THEN
    RAISE EXCEPTION 'an email account row cannot change its identity';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER email_accounts_guard_trg BEFORE INSERT OR UPDATE ON email_accounts FOR EACH ROW EXECUTE FUNCTION email_accounts_guard();--> statement-breakpoint
CREATE FUNCTION email_append_only() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION '% is append-only', TG_TABLE_NAME; END $$;--> statement-breakpoint
CREATE TRIGGER email_threads_append_only BEFORE UPDATE OR DELETE ON email_threads FOR EACH ROW EXECUTE FUNCTION email_append_only();--> statement-breakpoint
CREATE TRIGGER email_message_meta_append_only BEFORE UPDATE OR DELETE ON email_message_meta FOR EACH ROW EXECUTE FUNCTION email_append_only();
