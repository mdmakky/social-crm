-- Configurable CAPI event mappings: "when this happens in the CRM, send this event to this dataset". Replaces the one hard-coded hook (lead won -> Purchase).
-- Additive only. Roles: crm_app (the API) reads mappings in the lead-change transaction (owner, admin, agent: an agent moving a lead triggers them) and configures them (owner, admin).
-- The worker never reads this table: a mapping only decides which outbox rows are written; what is sent is the row's own payload.
CREATE TABLE "capi_event_mappings" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"dataset_id" uuid NOT NULL,
	"trigger_type" text NOT NULL,
	"stage_id" uuid,
	"event_name" text NOT NULL,
	"value_mode" text DEFAULT 'lead_value' NOT NULL,
	"fixed_value_minor" bigint,
	"currency" text,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "capi_mappings_trigger" CHECK ("trigger_type" IN ('lead_created','lead_stage_entered','lead_won','lead_lost')),
	CONSTRAINT "capi_mappings_stage" CHECK (("trigger_type" = 'lead_stage_entered') = ("stage_id" IS NOT NULL)),
	CONSTRAINT "capi_mappings_event_name" CHECK ("event_name" ~ '^[A-Za-z][A-Za-z0-9_]{0,39}$'),
	CONSTRAINT "capi_mappings_value_mode" CHECK ("value_mode" IN ('lead_value','fixed','none')),
	CONSTRAINT "capi_mappings_fixed" CHECK (("value_mode" = 'fixed') = ("fixed_value_minor" IS NOT NULL AND "fixed_value_minor" >= 0 AND "currency" IS NOT NULL)),
	CONSTRAINT "capi_mappings_currency" CHECK ("currency" IS NULL OR "currency" ~ '^[A-Z]{3}$'),
	CONSTRAINT "capi_mappings_purchase_value" CHECK (NOT ("event_name" = 'Purchase' AND "value_mode" = 'none'))
);--> statement-breakpoint
ALTER TABLE "capi_event_mappings" ADD CONSTRAINT "capi_event_mappings_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "capi_event_mappings" ADD CONSTRAINT "capi_mappings_dataset_fk" FOREIGN KEY ("workspace_id","dataset_id") REFERENCES "public"."capi_datasets"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "capi_event_mappings" ADD CONSTRAINT "capi_mappings_stage_fk" FOREIGN KEY ("workspace_id","stage_id") REFERENCES "public"."pipeline_stages"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "capi_event_mappings" ADD CONSTRAINT "capi_mappings_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "capi_mappings_unique" ON "capi_event_mappings" USING btree ("dataset_id","trigger_type",COALESCE("stage_id",'00000000-0000-0000-0000-000000000000'::uuid),"event_name");--> statement-breakpoint
CREATE INDEX "capi_mappings_lookup_idx" ON "capi_event_mappings" USING btree ("workspace_id","dataset_id") WHERE "enabled";--> statement-breakpoint
-- Seed (additive, idempotent): the legacy behaviour as an ordinary mapping, once per existing dataset that has none. It is enabled exactly when the dataset had opted in to Purchase,
-- so a dataset that used to send nothing still sends nothing. Runs before FORCE RLS is switched on (and capi_datasets is unforced for this one statement) because the migration role has no policy.
ALTER TABLE capi_datasets NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
INSERT INTO capi_event_mappings (workspace_id, dataset_id, trigger_type, event_name, value_mode, enabled, created_by)
SELECT d.workspace_id, d.id, 'lead_won', 'Purchase', 'lead_value', ('Purchase' = ANY(d.events)), NULL
FROM capi_datasets d
WHERE NOT EXISTS (SELECT 1 FROM capi_event_mappings m WHERE m.dataset_id = d.id)
ON CONFLICT DO NOTHING;--> statement-breakpoint
ALTER TABLE capi_datasets FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE capi_event_mappings ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE capi_event_mappings FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON capi_event_mappings FROM crm_app, crm_worker;--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON capi_event_mappings TO crm_app;--> statement-breakpoint
GRANT UPDATE (trigger_type, stage_id, event_name, value_mode, fixed_value_minor, currency, enabled, updated_at) ON capi_event_mappings TO crm_app;--> statement-breakpoint
CREATE POLICY capim_select ON capi_event_mappings FOR SELECT TO crm_app USING (workspace_id = (SELECT app_workspace_id()) AND (SELECT app_has_role(array['owner','admin','agent'])));--> statement-breakpoint
CREATE POLICY capim_insert ON capi_event_mappings FOR INSERT TO crm_app WITH CHECK (workspace_id = (SELECT app_workspace_id()) AND (SELECT app_has_role(array['owner','admin'])) AND created_by = (SELECT app_user_id()));--> statement-breakpoint
CREATE POLICY capim_update ON capi_event_mappings FOR UPDATE TO crm_app USING (workspace_id = (SELECT app_workspace_id()) AND (SELECT app_has_role(array['owner','admin']))) WITH CHECK (workspace_id = (SELECT app_workspace_id()) AND (SELECT app_has_role(array['owner','admin'])));--> statement-breakpoint
CREATE POLICY capim_delete ON capi_event_mappings FOR DELETE TO crm_app USING (workspace_id = (SELECT app_workspace_id()) AND (SELECT app_has_role(array['owner','admin'])));--> statement-breakpoint
-- Identity never changes; at most 50 mappings per dataset (serialised per dataset so two concurrent inserts cannot both pass the count).
CREATE FUNCTION capi_mappings_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    PERFORM pg_advisory_xact_lock(hashtextextended(NEW.dataset_id::text, 34));
    IF (SELECT count(*) FROM capi_event_mappings WHERE dataset_id = NEW.dataset_id) >= 50 THEN
      RAISE EXCEPTION 'a dataset can have at most 50 event mappings' USING ERRCODE = '54000';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.id <> OLD.id OR NEW.workspace_id <> OLD.workspace_id OR NEW.dataset_id <> OLD.dataset_id OR NEW.created_by IS DISTINCT FROM OLD.created_by OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'a capi event mapping cannot change its identity';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER capi_mappings_guard_trg BEFORE INSERT OR UPDATE ON capi_event_mappings FOR EACH ROW EXECUTE FUNCTION capi_mappings_guard();--> statement-breakpoint
-- A mapping that cannot send is recorded, not dropped: status 'skipped' with a reason code in last_error (for example no_value). Final from birth, never picked up by the worker, payload stays {}.
ALTER TABLE "capi_events" DROP CONSTRAINT "capi_events_status";--> statement-breakpoint
ALTER TABLE "capi_events" ADD CONSTRAINT "capi_events_status" CHECK ("status" IN ('pending','sent','failed','skipped_no_consent','cancelled','skipped'));--> statement-breakpoint
DROP POLICY cape_insert ON capi_events;--> statement-breakpoint
CREATE POLICY cape_insert ON capi_events FOR INSERT TO crm_app WITH CHECK (workspace_id = (SELECT app_workspace_id()) AND (SELECT app_has_role(array['owner','admin','agent'])) AND status IN ('pending','skipped_no_consent','skipped') AND attempts = 0 AND sent_at IS NULL);
