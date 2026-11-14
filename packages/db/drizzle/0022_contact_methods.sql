-- Channel-independent contact methods (phones, emails) with provenance. The legacy contacts.phone / contacts.email stay the human-entered primary values (backward compatible);
-- this table holds additional and extracted values, each with its source, confidence and verification state.
CREATE TABLE "contact_methods" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"contact_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"value" text NOT NULL,
	"raw_value" text,
	"source" text NOT NULL,
	"source_conversation_id" uuid,
	"source_message_id" uuid,
	"confidence" numeric(3, 2) DEFAULT 1 NOT NULL,
	"verified" boolean DEFAULT false NOT NULL,
	"verified_at" timestamp with time zone,
	"verified_by" text,
	"is_primary" boolean DEFAULT false NOT NULL,
	"extracted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "contact_methods_unique" UNIQUE("workspace_id","contact_id","kind","value"),
	CONSTRAINT "contact_methods_kind" CHECK ("contact_methods"."kind" IN ('phone','email')),
	CONSTRAINT "contact_methods_source" CHECK ("contact_methods"."source" IN ('messenger','instagram','manual','import','other')),
	CONSTRAINT "contact_methods_confidence" CHECK ("contact_methods"."confidence" >= 0 AND "contact_methods"."confidence" <= 1),
	CONSTRAINT "contact_methods_value_len" CHECK (length("contact_methods"."value") BETWEEN 3 AND 254 AND (raw_value IS NULL OR length(raw_value) <= 200))
);--> statement-breakpoint
ALTER TABLE "contact_methods" ADD CONSTRAINT "contact_methods_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_methods" ADD CONSTRAINT "contact_methods_contact_fk" FOREIGN KEY ("workspace_id","contact_id") REFERENCES "public"."contacts"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "contact_methods_contact_idx" ON "contact_methods" USING btree ("workspace_id","contact_id");--> statement-breakpoint
CREATE INDEX "contact_methods_value_idx" ON "contact_methods" USING btree ("workspace_id","kind","value");--> statement-breakpoint
CREATE UNIQUE INDEX "contact_methods_one_primary" ON "contact_methods" USING btree ("workspace_id","contact_id","kind") WHERE "contact_methods"."is_primary";--> statement-breakpoint
ALTER TABLE contact_methods ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE contact_methods FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON contact_methods FROM crm_app;--> statement-breakpoint
CREATE POLICY cm_select ON contact_methods FOR SELECT TO crm_app USING (workspace_id = (SELECT app_workspace_id()) AND (SELECT app_has_role(array['owner','admin','agent','viewer'])));--> statement-breakpoint
GRANT SELECT, INSERT ON contact_methods TO crm_worker;--> statement-breakpoint
CREATE POLICY cm_worker_select ON contact_methods FOR SELECT TO crm_worker USING (workspace_id = (SELECT app_workspace_id()));--> statement-breakpoint
CREATE POLICY cm_worker_insert ON contact_methods FOR INSERT TO crm_worker WITH CHECK (workspace_id = (SELECT app_workspace_id()) AND source IN ('messenger','instagram') AND verified = false);--> statement-breakpoint
-- The worker may fill an EMPTY primary phone/email of a contact and nothing else: a value a person entered is never overwritten (trigger below).
GRANT SELECT (phone, phone_normalized, email, email_normalized) ON contacts TO crm_worker;--> statement-breakpoint
GRANT UPDATE (phone, phone_normalized, email, email_normalized) ON contacts TO crm_worker;--> statement-breakpoint
CREATE OR REPLACE FUNCTION contacts_worker_name_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF current_user = 'crm_worker' THEN
    IF NEW.name IS DISTINCT FROM OLD.name AND NOT (OLD.source IN ('messenger','instagram') AND OLD.name ~ '^(Messenger|Instagram) user [0-9]{1,4}$') THEN
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
-- Audit entries written by the worker for automatic changes (no user context).
GRANT INSERT ON audit_log TO crm_worker;--> statement-breakpoint
CREATE POLICY audit_log_worker_insert ON audit_log FOR INSERT TO crm_worker WITH CHECK (workspace_id = (SELECT app_workspace_id()) AND actor_user_id IS NULL);
