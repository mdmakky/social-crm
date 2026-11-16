-- Automation foundation (Phase 5, slice 1): rules, runs (idempotent per rule + trigger event), step log, workspace kill switch.
-- Rules and runs are managed by owner/admin; the dispatcher/executor path (app.system = 'dispatcher') creates and finishes runs.
CREATE TABLE "automation_rules" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" text NOT NULL,
	"trigger_type" text NOT NULL,
	"conditions" jsonb DEFAULT '{"op":"and","conditions":[]}'::jsonb NOT NULL,
	"actions" jsonb NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"requires_approval" boolean DEFAULT true NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "automation_rules_ws_id" UNIQUE("workspace_id","id"),
	CONSTRAINT "automation_rules_name" CHECK (char_length("name") BETWEEN 1 AND 120),
	CONSTRAINT "automation_rules_trigger" CHECK ("trigger_type" IN ('contact.created','lead.stage_changed','contact.owner_assigned','lead.owner_assigned')),
	CONSTRAINT "automation_rules_actions" CHECK (jsonb_typeof("actions") = 'array' AND jsonb_array_length("actions") BETWEEN 1 AND 5 AND octet_length("actions"::text) <= 20000),
	CONSTRAINT "automation_rules_conditions" CHECK (jsonb_typeof("conditions") = 'object' AND octet_length("conditions"::text) <= 20000)
);--> statement-breakpoint
CREATE TABLE "automation_runs" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"rule_id" uuid NOT NULL,
	"rule_version" integer NOT NULL,
	"trigger_event_id" uuid NOT NULL,
	"idempotency_key" text NOT NULL,
	"trigger_type" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" text NOT NULL,
	"actions" jsonb NOT NULL,
	"context" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"error" text,
	"approved_by" text,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	CONSTRAINT "automation_runs_ws_id" UNIQUE("workspace_id","id"),
	CONSTRAINT "automation_runs_idem" UNIQUE("workspace_id","rule_id","idempotency_key"),
	CONSTRAINT "automation_runs_status" CHECK ("status" IN ('pending','awaiting_approval','running','succeeded','failed','cancelled','skipped')),
	CONSTRAINT "automation_runs_attempts" CHECK ("attempts" >= 0),
	CONSTRAINT "automation_runs_error" CHECK ("error" IS NULL OR char_length("error") <= 1000)
);--> statement-breakpoint
CREATE TABLE "automation_run_steps" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"attempt" integer NOT NULL,
	"idx" integer NOT NULL,
	"action_type" text NOT NULL,
	"status" text NOT NULL,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "automation_run_steps_status" CHECK ("status" IN ('succeeded','failed')),
	CONSTRAINT "automation_run_steps_error" CHECK ("error" IS NULL OR char_length("error") <= 1000)
);--> statement-breakpoint
CREATE TABLE "automation_settings" (
	"workspace_id" uuid PRIMARY KEY NOT NULL,
	"kill_switch" boolean DEFAULT false NOT NULL,
	"updated_by" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
ALTER TABLE "automation_rules" ADD CONSTRAINT "automation_rules_workspace_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_rules" ADD CONSTRAINT "automation_rules_created_by_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_runs" ADD CONSTRAINT "automation_runs_workspace_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_runs" ADD CONSTRAINT "automation_runs_rule_fk" FOREIGN KEY ("workspace_id","rule_id") REFERENCES "public"."automation_rules"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_run_steps" ADD CONSTRAINT "automation_run_steps_workspace_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_run_steps" ADD CONSTRAINT "automation_run_steps_run_fk" FOREIGN KEY ("workspace_id","run_id") REFERENCES "public"."automation_runs"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_settings" ADD CONSTRAINT "automation_settings_workspace_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "automation_rules_trigger_idx" ON "automation_rules" USING btree ("workspace_id","trigger_type") WHERE "deleted_at" IS NULL AND "enabled";--> statement-breakpoint
CREATE INDEX "automation_runs_due_idx" ON "automation_runs" USING btree ("next_attempt_at") WHERE "status" = 'pending';--> statement-breakpoint
CREATE INDEX "automation_runs_list_idx" ON "automation_runs" USING btree ("workspace_id","created_at" DESC,"id" DESC);--> statement-breakpoint
CREATE INDEX "automation_run_steps_run_idx" ON "automation_run_steps" USING btree ("workspace_id","run_id","created_at");--> statement-breakpoint
ALTER TABLE automation_rules ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE automation_rules FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE automation_runs ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE automation_runs FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE automation_run_steps ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE automation_run_steps FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE automation_settings ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE automation_settings FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON automation_rules, automation_runs, automation_run_steps, automation_settings FROM crm_app, crm_worker;--> statement-breakpoint
GRANT SELECT, INSERT ON automation_rules, automation_settings TO crm_app;--> statement-breakpoint
GRANT UPDATE (name, trigger_type, conditions, actions, enabled, requires_approval, version, updated_at, deleted_at) ON automation_rules TO crm_app;--> statement-breakpoint
GRANT UPDATE (kill_switch, updated_by, updated_at) ON automation_settings TO crm_app;--> statement-breakpoint
GRANT SELECT, INSERT ON automation_runs TO crm_app;--> statement-breakpoint
GRANT UPDATE (status, attempts, next_attempt_at, error, approved_by, decided_at, updated_at, finished_at) ON automation_runs TO crm_app;--> statement-breakpoint
GRANT SELECT, INSERT ON automation_run_steps TO crm_app;--> statement-breakpoint
GRANT SELECT ON automation_rules, automation_runs, automation_run_steps, automation_settings TO crm_worker;--> statement-breakpoint
-- Rules: owner/admin manage; the dispatcher path reads them (matching). Rules are soft-deleted (runs keep their rule).
CREATE POLICY ar_select ON automation_rules FOR SELECT TO crm_app USING (workspace_id = (SELECT app_workspace_id()) AND ((SELECT app_has_role(array['owner','admin'])) OR (SELECT app_is_system())));--> statement-breakpoint
CREATE POLICY ar_insert ON automation_rules FOR INSERT TO crm_app WITH CHECK (workspace_id = (SELECT app_workspace_id()) AND (SELECT app_has_role(array['owner','admin'])) AND created_by = (SELECT app_user_id()));--> statement-breakpoint
CREATE POLICY ar_update ON automation_rules FOR UPDATE TO crm_app USING (workspace_id = (SELECT app_workspace_id()) AND (SELECT app_has_role(array['owner','admin']))) WITH CHECK (workspace_id = (SELECT app_workspace_id()));--> statement-breakpoint
-- Runs: only the dispatcher path creates them; an owner/admin may only move an awaiting_approval run to pending (approve) or cancelled (reject).
CREATE POLICY aru_select ON automation_runs FOR SELECT TO crm_app USING (workspace_id = (SELECT app_workspace_id()) AND ((SELECT app_has_role(array['owner','admin'])) OR (SELECT app_is_system())));--> statement-breakpoint
CREATE POLICY aru_insert ON automation_runs FOR INSERT TO crm_app WITH CHECK (workspace_id = (SELECT app_workspace_id()) AND (SELECT app_is_system()) AND status IN ('pending','awaiting_approval','skipped'));--> statement-breakpoint
CREATE POLICY aru_update ON automation_runs FOR UPDATE TO crm_app
  USING (workspace_id = (SELECT app_workspace_id()) AND ((SELECT app_is_system()) OR ((SELECT app_has_role(array['owner','admin'])) AND status = 'awaiting_approval')))
  WITH CHECK (workspace_id = (SELECT app_workspace_id()) AND ((SELECT app_is_system()) OR ((SELECT app_has_role(array['owner','admin'])) AND status IN ('pending','cancelled') AND approved_by = (SELECT app_user_id()))));--> statement-breakpoint
CREATE POLICY arst_select ON automation_run_steps FOR SELECT TO crm_app USING (workspace_id = (SELECT app_workspace_id()) AND ((SELECT app_has_role(array['owner','admin'])) OR (SELECT app_is_system())));--> statement-breakpoint
CREATE POLICY arst_insert ON automation_run_steps FOR INSERT TO crm_app WITH CHECK (workspace_id = (SELECT app_workspace_id()) AND (SELECT app_is_system()));--> statement-breakpoint
-- Kill switch: owner/admin flip it; the dispatcher path reads it before matching and before executing.
CREATE POLICY aset_select ON automation_settings FOR SELECT TO crm_app USING (workspace_id = (SELECT app_workspace_id()) AND ((SELECT app_has_role(array['owner','admin'])) OR (SELECT app_is_system())));--> statement-breakpoint
CREATE POLICY aset_insert ON automation_settings FOR INSERT TO crm_app WITH CHECK (workspace_id = (SELECT app_workspace_id()) AND (SELECT app_has_role(array['owner','admin'])));--> statement-breakpoint
CREATE POLICY aset_update ON automation_settings FOR UPDATE TO crm_app USING (workspace_id = (SELECT app_workspace_id()) AND (SELECT app_has_role(array['owner','admin']))) WITH CHECK (workspace_id = (SELECT app_workspace_id()));--> statement-breakpoint
CREATE POLICY ar_worker_select ON automation_rules FOR SELECT TO crm_worker USING (workspace_id = (SELECT app_workspace_id()));--> statement-breakpoint
CREATE POLICY aru_worker_select ON automation_runs FOR SELECT TO crm_worker USING (workspace_id = (SELECT app_workspace_id()));--> statement-breakpoint
CREATE POLICY arst_worker_select ON automation_run_steps FOR SELECT TO crm_worker USING (workspace_id = (SELECT app_workspace_id()));--> statement-breakpoint
CREATE POLICY aset_worker_select ON automation_settings FOR SELECT TO crm_worker USING (workspace_id = (SELECT app_workspace_id()));
