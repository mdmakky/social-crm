-- WhatsApp Cloud API foundation (slice 1): the platform is accepted by the inbox tables and one side table keeps what only WhatsApp has (WABA id, display number, mode).
-- Nothing connects a WhatsApp account yet (slice 2); events for an unknown phone number id are stored as orphans and can be replayed once an account exists.
ALTER TABLE "integration_accounts" DROP CONSTRAINT "integration_accounts_platform";--> statement-breakpoint
ALTER TABLE "integration_accounts" ADD CONSTRAINT "integration_accounts_platform" CHECK ("platform" IN ('messenger','instagram','whatsapp'));--> statement-breakpoint
ALTER TABLE "webhook_events" DROP CONSTRAINT "webhook_events_platform";--> statement-breakpoint
ALTER TABLE "webhook_events" ADD CONSTRAINT "webhook_events_platform" CHECK ("platform" IN ('messenger','instagram','whatsapp'));--> statement-breakpoint
ALTER TABLE "contact_methods" DROP CONSTRAINT "contact_methods_source";--> statement-breakpoint
ALTER TABLE "contact_methods" ADD CONSTRAINT "contact_methods_source" CHECK ("source" IN ('messenger','instagram','whatsapp','manual','import','other'));--> statement-breakpoint
-- The worker creates the contact and the detected phone/email of a WhatsApp sender the same way it does for the other channels.
DROP POLICY contacts_worker_insert ON contacts;--> statement-breakpoint
CREATE POLICY contacts_worker_insert ON contacts FOR INSERT TO crm_worker WITH CHECK (workspace_id = (SELECT app_workspace_id()) AND source IN ('messenger','instagram','whatsapp'));--> statement-breakpoint
DROP POLICY cm_worker_insert ON contact_methods;--> statement-breakpoint
CREATE POLICY cm_worker_insert ON contact_methods FOR INSERT TO crm_worker WITH CHECK (workspace_id = (SELECT app_workspace_id()) AND source IN ('messenger','instagram','whatsapp') AND verified = false);--> statement-breakpoint
CREATE OR REPLACE FUNCTION contacts_worker_name_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF current_user = 'crm_worker' THEN
    IF NEW.name IS DISTINCT FROM OLD.name AND NOT (OLD.source IN ('messenger','instagram','whatsapp') AND OLD.name ~ '^(Messenger|Instagram|WhatsApp) user [0-9]{1,4}$') THEN
      RAISE EXCEPTION 'the inbox worker may only replace a placeholder contact name';
    END IF;
    IF (NEW.phone IS DISTINCT FROM OLD.phone OR NEW.phone_normalized IS DISTINCT FROM OLD.phone_normalized) AND (OLD.phone IS NOT NULL OR OLD.phone_normalized IS NOT NULL) THEN
      RAISE EXCEPTION 'the inbox worker may only fill an empty phone';
    END IF;
    IF (NEW.email IS DISTINCT FROM OLD.email OR NEW.email_normalized IS DISTINCT FROM OLD.email_normalized) AND (OLD.email IS NOT NULL OR OLD.email_normalized IS NOT NULL) THEN
      RAISE EXCEPTION 'the inbox worker may only fill an empty email';
    END IF;
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TABLE "whatsapp_accounts" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"integration_account_id" uuid NOT NULL,
	"waba_id" text NOT NULL,
	"display_phone_number" text,
	"mode" text DEFAULT 'cloud_api' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "whatsapp_accounts_account" UNIQUE("integration_account_id"),
	CONSTRAINT "whatsapp_accounts_ws_id" UNIQUE("workspace_id","id"),
	CONSTRAINT "whatsapp_accounts_waba" CHECK ("waba_id" ~ '^[1-9][0-9]{0,99}$'),
	CONSTRAINT "whatsapp_accounts_display" CHECK ("display_phone_number" IS NULL OR char_length("display_phone_number") <= 40),
	CONSTRAINT "whatsapp_accounts_mode" CHECK ("mode" IN ('cloud_api','coexistence'))
);--> statement-breakpoint
ALTER TABLE "whatsapp_accounts" ADD CONSTRAINT "whatsapp_accounts_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "whatsapp_accounts" ADD CONSTRAINT "whatsapp_accounts_account_fk" FOREIGN KEY ("workspace_id","integration_account_id") REFERENCES "public"."integration_accounts"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "whatsapp_accounts_waba_idx" ON "whatsapp_accounts" USING btree ("waba_id");--> statement-breakpoint
ALTER TABLE whatsapp_accounts ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE whatsapp_accounts FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON whatsapp_accounts FROM crm_app;--> statement-breakpoint
GRANT SELECT ON whatsapp_accounts TO crm_app;--> statement-breakpoint
GRANT SELECT, INSERT ON whatsapp_accounts TO crm_worker;--> statement-breakpoint
GRANT UPDATE (display_phone_number, updated_at) ON whatsapp_accounts TO crm_worker;--> statement-breakpoint
CREATE POLICY wa_select ON whatsapp_accounts FOR SELECT TO crm_app USING (workspace_id = (SELECT app_workspace_id()) AND (SELECT app_has_role(array['owner','admin','agent','viewer'])));--> statement-breakpoint
CREATE POLICY wa_worker_select ON whatsapp_accounts FOR SELECT TO crm_worker USING (workspace_id = (SELECT app_workspace_id()));--> statement-breakpoint
CREATE POLICY wa_worker_insert ON whatsapp_accounts FOR INSERT TO crm_worker WITH CHECK (workspace_id = (SELECT app_workspace_id()));--> statement-breakpoint
CREATE POLICY wa_worker_update ON whatsapp_accounts FOR UPDATE TO crm_worker USING (workspace_id = (SELECT app_workspace_id())) WITH CHECK (workspace_id = (SELECT app_workspace_id()));--> statement-breakpoint
-- The side row can only describe a WhatsApp integration account, and its identity never changes.
CREATE FUNCTION whatsapp_accounts_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NOT EXISTS (SELECT 1 FROM integration_accounts a WHERE a.id = NEW.integration_account_id AND a.workspace_id = NEW.workspace_id AND a.platform = 'whatsapp') THEN
      RAISE EXCEPTION 'a whatsapp account row must belong to a whatsapp integration account of the same workspace';
    END IF;
  ELSIF NEW.id <> OLD.id OR NEW.workspace_id <> OLD.workspace_id OR NEW.integration_account_id <> OLD.integration_account_id OR NEW.waba_id <> OLD.waba_id OR NEW.mode <> OLD.mode THEN
    RAISE EXCEPTION 'a whatsapp account row cannot change its identity';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER whatsapp_accounts_guard_trg BEFORE INSERT OR UPDATE ON whatsapp_accounts FOR EACH ROW EXECUTE FUNCTION whatsapp_accounts_guard();
