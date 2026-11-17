-- Telegram support-inbox channel v1 (MOCK ONLY so far, see docs/integrations/telegram.md). One side table keeps what only a Telegram bot account has.
-- The webhook is routed by an unguessable path id and authenticated by a per-account secret_token (Telegram sends it as X-Telegram-Bot-Api-Secret-Token); only the SHA-256 of that secret is stored.
CREATE TABLE "telegram_accounts" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"integration_account_id" uuid NOT NULL,
	"bot_id" text NOT NULL,
	"bot_username" text,
	"webhook_path_id" text NOT NULL,
	"secret_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "telegram_accounts_account" UNIQUE("integration_account_id"),
	CONSTRAINT "telegram_accounts_path" UNIQUE("webhook_path_id"),
	CONSTRAINT "telegram_accounts_ws_id" UNIQUE("workspace_id","id"),
	CONSTRAINT "telegram_accounts_bot" CHECK ("bot_id" ~ '^[1-9][0-9]{0,19}$'),
	CONSTRAINT "telegram_accounts_username" CHECK ("bot_username" IS NULL OR char_length("bot_username") <= 64),
	CONSTRAINT "telegram_accounts_path_fmt" CHECK ("webhook_path_id" ~ '^[A-Za-z0-9_-]{20,64}$'),
	CONSTRAINT "telegram_accounts_secret_fmt" CHECK ("secret_hash" ~ '^[0-9a-f]{64}$')
);--> statement-breakpoint
ALTER TABLE "telegram_accounts" ADD CONSTRAINT "telegram_accounts_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "telegram_accounts" ADD CONSTRAINT "telegram_accounts_account_fk" FOREIGN KEY ("workspace_id","integration_account_id") REFERENCES "public"."integration_accounts"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE telegram_accounts ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE telegram_accounts FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON telegram_accounts FROM crm_app;--> statement-breakpoint
-- Members never see the path id or the secret hash.
GRANT SELECT (id, workspace_id, integration_account_id, bot_id, bot_username, created_at, updated_at) ON telegram_accounts TO crm_app;--> statement-breakpoint
GRANT SELECT, INSERT ON telegram_accounts TO crm_worker;--> statement-breakpoint
GRANT UPDATE (bot_username, webhook_path_id, secret_hash, updated_at) ON telegram_accounts TO crm_worker;--> statement-breakpoint
CREATE POLICY tg_select ON telegram_accounts FOR SELECT TO crm_app USING (workspace_id = (SELECT app_workspace_id()) AND (SELECT app_has_role(array['owner','admin','agent','viewer'])));--> statement-breakpoint
CREATE POLICY tg_worker_select ON telegram_accounts FOR SELECT TO crm_worker USING (workspace_id = (SELECT app_workspace_id()));--> statement-breakpoint
CREATE POLICY tg_worker_insert ON telegram_accounts FOR INSERT TO crm_worker WITH CHECK (workspace_id = (SELECT app_workspace_id()));--> statement-breakpoint
CREATE POLICY tg_worker_update ON telegram_accounts FOR UPDATE TO crm_worker USING (workspace_id = (SELECT app_workspace_id())) WITH CHECK (workspace_id = (SELECT app_workspace_id()));--> statement-breakpoint
-- The public webhook route runs as crm_ingest (no table access): it asks this definer function for the secret hash of one path id and nothing else (runs as the table owner crm_migrator, which FORCE RLS still binds).
CREATE POLICY tg_def_select ON telegram_accounts FOR SELECT TO crm_migrator USING (true);--> statement-breakpoint
CREATE FUNCTION telegram_ingest_lookup(p_path text) RETURNS TABLE (bot_id text, secret_hash text) LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT t.bot_id, t.secret_hash FROM telegram_accounts t WHERE t.webhook_path_id = p_path
$$;--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION telegram_ingest_lookup(text) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION telegram_ingest_lookup(text) TO crm_ingest;--> statement-breakpoint
-- The side row can only describe a Telegram integration account, and its identity never changes.
CREATE FUNCTION telegram_accounts_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NOT EXISTS (SELECT 1 FROM integration_accounts a WHERE a.id = NEW.integration_account_id AND a.workspace_id = NEW.workspace_id AND a.platform = 'telegram' AND a.external_account_id = NEW.bot_id) THEN
      RAISE EXCEPTION 'a telegram account row must belong to a telegram integration account of the same workspace and bot';
    END IF;
  ELSIF NEW.id <> OLD.id OR NEW.workspace_id <> OLD.workspace_id OR NEW.integration_account_id <> OLD.integration_account_id OR NEW.bot_id <> OLD.bot_id THEN
    RAISE EXCEPTION 'a telegram account row cannot change its identity';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER telegram_accounts_guard_trg BEFORE INSERT OR UPDATE ON telegram_accounts FOR EACH ROW EXECUTE FUNCTION telegram_accounts_guard();--> statement-breakpoint
-- Dedupe on (account, update): Telegram retries a failed delivery with the same bytes, and update_id is inside them, so an identical body is the same update. Ingest uses ON CONFLICT DO NOTHING.
CREATE UNIQUE INDEX "webhook_events_telegram_dedupe" ON "webhook_events" ("account_ref","body_sha256") WHERE "platform" = 'telegram' AND "account_ref" IS NOT NULL AND "body_sha256" IS NOT NULL;--> statement-breakpoint
-- A person who blocked the bot cannot be written to: set by my_chat_member, cleared by unblocking or by any new message from them.
ALTER TABLE "conversations" ADD COLUMN "contact_unreachable_at" timestamp with time zone;--> statement-breakpoint
GRANT SELECT (contact_unreachable_at) ON conversations TO crm_app;--> statement-breakpoint
GRANT UPDATE (contact_unreachable_at) ON conversations TO crm_worker;
