-- Messenger sender profile enrichment (name, picture). The worker records the outcome per platform identity so a contact is fetched once, not on every message.
ALTER TABLE "platform_identities" ADD COLUMN "profile_pic_url" text;--> statement-breakpoint
ALTER TABLE "platform_identities" ADD COLUMN "profile_status" text;--> statement-breakpoint
ALTER TABLE "platform_identities" ADD COLUMN "profile_attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "platform_identities" ADD COLUMN "profile_retry_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "platform_identities" ADD CONSTRAINT "platform_identities_profile_status" CHECK ("platform_identities"."profile_status" IS NULL OR "platform_identities"."profile_status" IN ('ok','unavailable','denied','error'));--> statement-breakpoint
ALTER TABLE "platform_identities" ADD CONSTRAINT "platform_identities_profile_pic" CHECK ("platform_identities"."profile_pic_url" IS NULL OR ("platform_identities"."profile_pic_url" ~ '^https://' AND length("platform_identities"."profile_pic_url") <= 2048));--> statement-breakpoint
GRANT UPDATE (profile_pic_url, profile_status, profile_attempts, profile_retry_at) ON platform_identities TO crm_worker;--> statement-breakpoint
-- The worker may rename a contact only while it still carries the placeholder it created itself; it can never overwrite a name a person typed.
GRANT SELECT (source, version) ON contacts TO crm_worker;--> statement-breakpoint
GRANT UPDATE (name, version, updated_at) ON contacts TO crm_worker;--> statement-breakpoint
CREATE FUNCTION contacts_worker_name_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF current_user = 'crm_worker' AND NEW.name IS DISTINCT FROM OLD.name
     AND NOT (OLD.source IN ('messenger','instagram') AND OLD.name ~ '^(Messenger|Instagram) user [0-9]{1,4}$') THEN
    RAISE EXCEPTION 'the inbox worker may only replace a placeholder contact name';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER contacts_worker_name_guard_trg BEFORE UPDATE ON contacts FOR EACH ROW EXECUTE FUNCTION contacts_worker_name_guard();
