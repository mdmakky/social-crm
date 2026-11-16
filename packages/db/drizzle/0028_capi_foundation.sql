-- Meta Conversions API foundation (slice 1, mock first): datasets, sealed dataset tokens, ad-measurement consent records, and the outbound event queue.
-- Roles: crm_app (the API: configures datasets, records consent, enqueues events from CRM changes), crm_worker (the queue worker: claims, sends, records results, reads the sealed token).
-- Policies use scalar subqueries (D45). Nothing here talks to Meta; "live" mode exists in the schema only so a real adapter can be wired after a recorded test event.
CREATE TABLE "capi_datasets" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"dataset_id" text NOT NULL,
	"name" text NOT NULL,
	"mode" text DEFAULT 'mock' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"test_event_code" text,
	"events" text[] DEFAULT '{}' NOT NULL,
	"token_last4" text NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "capi_datasets_ws_id" UNIQUE("workspace_id","id"),
	CONSTRAINT "capi_datasets_ws_dataset" UNIQUE("workspace_id","dataset_id"),
	CONSTRAINT "capi_datasets_dataset_id" CHECK ("dataset_id" ~ '^[1-9][0-9]{0,99}$'),
	CONSTRAINT "capi_datasets_name" CHECK (char_length("name") BETWEEN 1 AND 120),
	CONSTRAINT "capi_datasets_mode" CHECK ("mode" IN ('mock','live')),
	CONSTRAINT "capi_datasets_status" CHECK ("status" IN ('active','disabled','needs_reauth')),
	CONSTRAINT "capi_datasets_test_code" CHECK ("test_event_code" IS NULL OR "test_event_code" ~ '^[A-Za-z0-9_-]{1,40}$'),
	CONSTRAINT "capi_datasets_events" CHECK ("events" <@ ARRAY['Lead','Purchase','Schedule','CompleteRegistration','Contact','SubmitApplication']::text[]),
	CONSTRAINT "capi_datasets_last4" CHECK (char_length("token_last4") = 4)
);--> statement-breakpoint
ALTER TABLE "capi_datasets" ADD CONSTRAINT "capi_datasets_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "capi_datasets" ADD CONSTRAINT "capi_datasets_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE TABLE "capi_dataset_secrets" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"dataset_id" uuid NOT NULL,
	"ciphertext" "bytea" NOT NULL,
	"nonce" "bytea" NOT NULL,
	"key_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "capi_dataset_secrets_dataset" UNIQUE("dataset_id"),
	CONSTRAINT "capi_dataset_secrets_nonce_len" CHECK (octet_length("nonce") = 12),
	CONSTRAINT "capi_dataset_secrets_key_id" CHECK (char_length("key_id") BETWEEN 1 AND 64),
	CONSTRAINT "capi_dataset_secrets_ciphertext_len" CHECK (octet_length("ciphertext") BETWEEN 17 AND 4096)
);--> statement-breakpoint
ALTER TABLE "capi_dataset_secrets" ADD CONSTRAINT "capi_dataset_secrets_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "capi_dataset_secrets" ADD CONSTRAINT "capi_dataset_secrets_dataset_fk" FOREIGN KEY ("workspace_id","dataset_id") REFERENCES "public"."capi_datasets"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- Append-only record of what a contact allowed or withdrew; the newest row per (contact, purpose) is the current state.
CREATE TABLE "consent_records" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"contact_id" uuid NOT NULL,
	"purpose" text DEFAULT 'ad_measurement' NOT NULL,
	"status" text NOT NULL,
	"source" text NOT NULL,
	"recorded_by" text,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "consent_records_purpose" CHECK ("purpose" IN ('ad_measurement')),
	CONSTRAINT "consent_records_status" CHECK ("status" IN ('granted','revoked')),
	CONSTRAINT "consent_records_source" CHECK ("source" IN ('manual','form','import','api','customer_request'))
);--> statement-breakpoint
ALTER TABLE "consent_records" ADD CONSTRAINT "consent_records_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consent_records" ADD CONSTRAINT "consent_records_contact_fk" FOREIGN KEY ("workspace_id","contact_id") REFERENCES "public"."contacts"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consent_records" ADD CONSTRAINT "consent_records_recorded_by_user_id_fk" FOREIGN KEY ("recorded_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "consent_records_latest_idx" ON "consent_records" USING btree ("workspace_id","contact_id","purpose","id" DESC);--> statement-breakpoint
-- The outbound queue. payload is the Meta event with HASHED identifiers only (see packages/capi); raw email, phone and names are never stored here.
CREATE TABLE "capi_events" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"dataset_id" uuid NOT NULL,
	"contact_id" uuid,
	"event_name" text NOT NULL,
	"event_id" text NOT NULL,
	"crm_event_ref" text NOT NULL,
	"event_time" timestamp with time zone NOT NULL,
	"payload" jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_error" text,
	"fbtrace_id" text,
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "capi_events_dataset_event" UNIQUE("workspace_id","dataset_id","event_id"),
	CONSTRAINT "capi_events_status" CHECK ("status" IN ('pending','sent','failed','skipped_no_consent')),
	CONSTRAINT "capi_events_attempts" CHECK ("attempts" >= 0),
	CONSTRAINT "capi_events_last_error" CHECK ("last_error" IS NULL OR "last_error" ~ '^[a-z0-9_:]{1,80}$'),
	CONSTRAINT "capi_events_fbtrace" CHECK ("fbtrace_id" IS NULL OR char_length("fbtrace_id") <= 64),
	CONSTRAINT "capi_events_sent" CHECK (("status" = 'sent') = ("sent_at" IS NOT NULL))
);--> statement-breakpoint
ALTER TABLE "capi_events" ADD CONSTRAINT "capi_events_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "capi_events" ADD CONSTRAINT "capi_events_dataset_fk" FOREIGN KEY ("workspace_id","dataset_id") REFERENCES "public"."capi_datasets"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "capi_events" ADD CONSTRAINT "capi_events_contact_fk" FOREIGN KEY ("workspace_id","contact_id") REFERENCES "public"."contacts"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "capi_events_due_idx" ON "capi_events" USING btree ("next_attempt_at") WHERE "status" = 'pending';--> statement-breakpoint
CREATE INDEX "capi_events_history_idx" ON "capi_events" USING btree ("workspace_id","id" DESC);--> statement-breakpoint
ALTER TABLE capi_datasets ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE capi_datasets FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE capi_dataset_secrets ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE capi_dataset_secrets FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE consent_records ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE consent_records FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE capi_events ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE capi_events FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON capi_datasets, capi_dataset_secrets, consent_records, capi_events FROM crm_app, crm_worker;--> statement-breakpoint
-- API: configure datasets (never DELETE), insert the sealed token but never read it back, append consent, enqueue and read events.
GRANT SELECT, INSERT ON capi_datasets TO crm_app;--> statement-breakpoint
GRANT UPDATE (status, test_event_code, events, updated_at) ON capi_datasets TO crm_app;--> statement-breakpoint
GRANT INSERT ON capi_dataset_secrets TO crm_app;--> statement-breakpoint
GRANT SELECT, INSERT ON consent_records TO crm_app;--> statement-breakpoint
GRANT SELECT, INSERT ON capi_events TO crm_app;--> statement-breakpoint
-- Worker: reads datasets, the sealed token and consent; claims and updates the delivery state of events (and may only blank the identifiers of one, see the guard).
GRANT SELECT ON capi_datasets, capi_dataset_secrets, consent_records TO crm_worker;--> statement-breakpoint
GRANT SELECT ON capi_events TO crm_worker;--> statement-breakpoint
GRANT UPDATE (status, attempts, next_attempt_at, last_error, fbtrace_id, sent_at, payload, updated_at) ON capi_events TO crm_worker;--> statement-breakpoint
CREATE POLICY capid_select ON capi_datasets FOR SELECT TO crm_app USING (workspace_id = (SELECT app_workspace_id()) AND (SELECT app_has_role(array['owner','admin','agent'])));--> statement-breakpoint
CREATE POLICY capid_insert ON capi_datasets FOR INSERT TO crm_app WITH CHECK (workspace_id = (SELECT app_workspace_id()) AND (SELECT app_has_role(array['owner','admin'])));--> statement-breakpoint
CREATE POLICY capid_update ON capi_datasets FOR UPDATE TO crm_app USING (workspace_id = (SELECT app_workspace_id()) AND (SELECT app_has_role(array['owner','admin']))) WITH CHECK (workspace_id = (SELECT app_workspace_id()) AND (SELECT app_has_role(array['owner','admin'])));--> statement-breakpoint
CREATE POLICY capid_worker_select ON capi_datasets FOR SELECT TO crm_worker USING (workspace_id = (SELECT app_workspace_id()));--> statement-breakpoint
CREATE POLICY capis_insert ON capi_dataset_secrets FOR INSERT TO crm_app WITH CHECK (workspace_id = (SELECT app_workspace_id()) AND (SELECT app_has_role(array['owner','admin'])));--> statement-breakpoint
CREATE POLICY capis_worker_select ON capi_dataset_secrets FOR SELECT TO crm_worker USING (workspace_id = (SELECT app_workspace_id()));--> statement-breakpoint
CREATE POLICY cons_select ON consent_records FOR SELECT TO crm_app USING (workspace_id = (SELECT app_workspace_id()) AND (SELECT app_has_role(array['owner','admin','agent'])));--> statement-breakpoint
CREATE POLICY cons_insert ON consent_records FOR INSERT TO crm_app WITH CHECK (workspace_id = (SELECT app_workspace_id()) AND (SELECT app_has_role(array['owner','admin','agent'])) AND recorded_by = (SELECT app_user_id()));--> statement-breakpoint
CREATE POLICY cons_worker_select ON consent_records FOR SELECT TO crm_worker USING (workspace_id = (SELECT app_workspace_id()));--> statement-breakpoint
-- Enqueueing is allowed to anyone who can change a lead (a lead change is the trigger), and INSERT ... ON CONFLICT needs the SELECT policy to pass too, so agents can see rows at the database level.
-- The history ENDPOINT is still owner/admin only (capi.view) and its DTO carries no payload or identifiers.
CREATE POLICY cape_select ON capi_events FOR SELECT TO crm_app USING (workspace_id = (SELECT app_workspace_id()) AND (SELECT app_has_role(array['owner','admin','agent'])));--> statement-breakpoint
CREATE POLICY cape_insert ON capi_events FOR INSERT TO crm_app WITH CHECK (workspace_id = (SELECT app_workspace_id()) AND (SELECT app_has_role(array['owner','admin','agent'])) AND status IN ('pending','skipped_no_consent') AND attempts = 0 AND sent_at IS NULL);--> statement-breakpoint
-- The queue is claimed across workspaces (like webhook_events); everything else the worker does for an event runs under that event's workspace context.
CREATE POLICY cape_worker_select ON capi_events FOR SELECT TO crm_worker USING (true);--> statement-breakpoint
CREATE POLICY cape_worker_update ON capi_events FOR UPDATE TO crm_worker USING (true) WITH CHECK (true);--> statement-breakpoint
-- Datasets: identity never changes, and a disabled dataset stays disabled (connect a new one instead; the token is write-once).
CREATE FUNCTION capi_datasets_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id <> OLD.id OR NEW.workspace_id <> OLD.workspace_id OR NEW.dataset_id <> OLD.dataset_id OR NEW.mode <> OLD.mode OR NEW.token_last4 <> OLD.token_last4 OR NEW.name <> OLD.name THEN
    RAISE EXCEPTION 'a capi dataset cannot change its identity';
  END IF;
  IF OLD.status = 'disabled' AND NEW.status <> 'disabled' THEN
    RAISE EXCEPTION 'a disabled capi dataset cannot be re-enabled';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER capi_datasets_guard_trg BEFORE UPDATE ON capi_datasets FOR EACH ROW EXECUTE FUNCTION capi_datasets_guard();--> statement-breakpoint
CREATE FUNCTION capi_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME;
END $$;--> statement-breakpoint
CREATE TRIGGER consent_records_append_only BEFORE UPDATE OR DELETE ON consent_records FOR EACH ROW EXECUTE FUNCTION capi_append_only();--> statement-breakpoint
-- Events: identity and payload are fixed at creation (the same event_id always carries the same event). Only a pending row may change; sent, failed and skipped are final.
-- The one payload change allowed is blanking user_data (the worker does it when consent was withdrawn after queueing).
CREATE FUNCTION capi_events_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id <> OLD.id OR NEW.workspace_id <> OLD.workspace_id OR NEW.dataset_id <> OLD.dataset_id OR NEW.contact_id IS DISTINCT FROM OLD.contact_id
     OR NEW.event_name <> OLD.event_name OR NEW.event_id <> OLD.event_id OR NEW.crm_event_ref <> OLD.crm_event_ref OR NEW.event_time <> OLD.event_time OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'a capi event cannot change its identity';
  END IF;
  IF OLD.status <> 'pending' THEN
    RAISE EXCEPTION 'a capi event that is % is final', OLD.status;
  END IF;
  IF NEW.payload IS DISTINCT FROM OLD.payload AND NOT ((NEW.payload - 'user_data') = (OLD.payload - 'user_data') AND NEW.payload -> 'user_data' = '{}'::jsonb) THEN
    RAISE EXCEPTION 'a capi event payload can only have its user_data blanked';
  END IF;
  IF NEW.attempts < OLD.attempts THEN
    RAISE EXCEPTION 'attempts only go up';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER capi_events_guard_trg BEFORE UPDATE ON capi_events FOR EACH ROW EXECUTE FUNCTION capi_events_guard();--> statement-breakpoint
CREATE TRIGGER capi_events_no_delete BEFORE DELETE ON capi_events FOR EACH ROW EXECUTE FUNCTION capi_append_only();
