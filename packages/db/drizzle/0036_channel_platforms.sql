-- Channel platforms foundation: "telegram", "email" and "web_chat" become legal platform/source values. No channel behaviour here; each channel branch adds its own connect, webhook and send.
ALTER TABLE "integration_accounts" DROP CONSTRAINT "integration_accounts_platform";--> statement-breakpoint
ALTER TABLE "integration_accounts" ADD CONSTRAINT "integration_accounts_platform" CHECK ("platform" IN ('messenger','instagram','whatsapp','telegram','email','web_chat'));--> statement-breakpoint
ALTER TABLE "webhook_events" DROP CONSTRAINT "webhook_events_platform";--> statement-breakpoint
ALTER TABLE "webhook_events" ADD CONSTRAINT "webhook_events_platform" CHECK ("platform" IN ('messenger','instagram','whatsapp','telegram','email','web_chat'));--> statement-breakpoint
ALTER TABLE "contact_methods" DROP CONSTRAINT "contact_methods_source";--> statement-breakpoint
ALTER TABLE "contact_methods" ADD CONSTRAINT "contact_methods_source" CHECK ("source" IN ('messenger','instagram','whatsapp','telegram','email','web_chat','manual','import','other'));--> statement-breakpoint
-- The worker creates the contact and the detected methods of a sender on the new channels the same way it does for Meta. RLS stays forced.
DROP POLICY contacts_worker_insert ON contacts;--> statement-breakpoint
CREATE POLICY contacts_worker_insert ON contacts FOR INSERT TO crm_worker WITH CHECK (workspace_id = (SELECT app_workspace_id()) AND source IN ('messenger','instagram','whatsapp','telegram','email','web_chat'));--> statement-breakpoint
DROP POLICY cm_worker_insert ON contact_methods;--> statement-breakpoint
CREATE POLICY cm_worker_insert ON contact_methods FOR INSERT TO crm_worker WITH CHECK (workspace_id = (SELECT app_workspace_id()) AND source IN ('messenger','instagram','whatsapp','telegram','email','web_chat') AND verified = false);--> statement-breakpoint
CREATE OR REPLACE FUNCTION contacts_worker_name_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF current_user = 'crm_worker' THEN
    IF NEW.name IS DISTINCT FROM OLD.name AND NOT (OLD.source IN ('messenger','instagram','whatsapp','telegram','email','web_chat') AND OLD.name ~ '^(Messenger|Instagram|WhatsApp|Telegram|Email|Web chat) user [0-9]{1,4}$') THEN
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
END $$;
