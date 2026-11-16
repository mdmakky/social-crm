-- AI agent builder (Phase 6 slice 2): workspace-configured agents, append-only versions, and the approval queue for sensitive tool calls.
-- Agents DRAFT replies and PROPOSE tool calls; nothing here sends a customer message. Role crm_app only (the model call itself goes through runAi as crm_worker, unchanged).
-- ai_agent_actions exists because automation_runs is bound to a rule (rule_id NOT NULL, actions validated as AutomationAction) and cannot hold a model-proposed tool call; see decision D110.
-- Policies use scalar subqueries (D45). Tool names are not CHECKed against a list: adding a tool is one file plus one registry line (the API validates against the registry).
CREATE TABLE "ai_agents" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"active_version_id" uuid,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_agents_ws_id" UNIQUE("workspace_id","id"),
	CONSTRAINT "ai_agents_ws_key" UNIQUE("workspace_id","key"),
	CONSTRAINT "ai_agents_key" CHECK ("key" ~ '^[a-z][a-z0-9_-]{1,40}$'),
	CONSTRAINT "ai_agents_name" CHECK (char_length("name") BETWEEN 1 AND 80),
	CONSTRAINT "ai_agents_description" CHECK (char_length("description") <= 300),
	CONSTRAINT "ai_agents_status" CHECK ("status" IN ('draft','active','archived')),
	CONSTRAINT "ai_agents_active_needs_version" CHECK ("status" <> 'active' OR "active_version_id" IS NOT NULL)
);--> statement-breakpoint
ALTER TABLE "ai_agents" ADD CONSTRAINT "ai_agents_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_agents" ADD CONSTRAINT "ai_agents_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- A version's text and settings are final. A new version is a new row; "rollback" re-points ai_agents.active_version_id at an older one.
CREATE TABLE "ai_agent_versions" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"instructions" text NOT NULL,
	"personality" text DEFAULT '' NOT NULL,
	"language" text DEFAULT 'auto' NOT NULL,
	"response_style" text DEFAULT 'concise' NOT NULL,
	"provider" text,
	"model" text,
	"temperature" real DEFAULT 0.4 NOT NULL,
	"max_output_tokens" integer DEFAULT 600 NOT NULL,
	"tool_grants" jsonb DEFAULT '[]' NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_agent_versions_ws_id" UNIQUE("workspace_id","id"),
	CONSTRAINT "ai_agent_versions_ws_agent_id" UNIQUE("workspace_id","agent_id","id"),
	CONSTRAINT "ai_agent_versions_version_uq" UNIQUE("workspace_id","agent_id","version"),
	CONSTRAINT "ai_agent_versions_version" CHECK ("version" >= 1),
	CONSTRAINT "ai_agent_versions_instructions" CHECK (char_length("instructions") BETWEEN 1 AND 6000),
	CONSTRAINT "ai_agent_versions_personality" CHECK (char_length("personality") <= 500),
	CONSTRAINT "ai_agent_versions_language" CHECK ("language" = 'auto' OR "language" ~ '^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8}){0,2}$'),
	CONSTRAINT "ai_agent_versions_style" CHECK (char_length("response_style") BETWEEN 1 AND 60),
	CONSTRAINT "ai_agent_versions_provider" CHECK ("provider" IS NULL OR "provider" ~ '^[a-z][a-z0-9_]{1,30}$'),
	CONSTRAINT "ai_agent_versions_model" CHECK ("model" IS NULL OR char_length("model") BETWEEN 1 AND 100),
	CONSTRAINT "ai_agent_versions_temperature" CHECK ("temperature" BETWEEN 0 AND 1),
	CONSTRAINT "ai_agent_versions_max_tokens" CHECK ("max_output_tokens" BETWEEN 50 AND 2000),
	CONSTRAINT "ai_agent_versions_grants" CHECK (jsonb_typeof("tool_grants") = 'array' AND jsonb_array_length("tool_grants") <= 20 AND octet_length("tool_grants"::text) <= 4000)
);--> statement-breakpoint
ALTER TABLE "ai_agent_versions" ADD CONSTRAINT "ai_agent_versions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_agent_versions" ADD CONSTRAINT "ai_agent_versions_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_agent_versions" ADD CONSTRAINT "ai_agent_versions_agent_fk" FOREIGN KEY ("workspace_id","agent_id") REFERENCES "public"."ai_agents"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- The active version must belong to the same agent (MATCH SIMPLE: skipped while active_version_id is NULL).
ALTER TABLE "ai_agents" ADD CONSTRAINT "ai_agents_active_version_fk" FOREIGN KEY ("workspace_id","id","active_version_id") REFERENCES "public"."ai_agent_versions"("workspace_id","agent_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- Proposed tool calls. `source_ref` + `idx` make an automation run idempotent (a retried run cannot queue the same call twice).
CREATE TABLE "ai_agent_actions" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"agent_version_id" uuid NOT NULL,
	"source" text NOT NULL,
	"source_ref" text,
	"idx" integer DEFAULT 0 NOT NULL,
	"contact_id" uuid,
	"conversation_id" uuid,
	"tool" text NOT NULL,
	"args" jsonb NOT NULL,
	"reason" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"requested_by" text NOT NULL,
	"decided_by" text,
	"decided_at" timestamp with time zone,
	"result" jsonb,
	"error" text,
	"ai_run_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_agent_actions_ws_id" UNIQUE("workspace_id","id"),
	CONSTRAINT "ai_agent_actions_idem" UNIQUE("workspace_id","source_ref","idx"),
	CONSTRAINT "ai_agent_actions_source" CHECK ("source" IN ('test','run','automation')),
	CONSTRAINT "ai_agent_actions_reason" CHECK ("reason" IN ('approval_granted','sensitive')),
	CONSTRAINT "ai_agent_actions_status" CHECK ("status" IN ('pending','approved','rejected','executed','failed')),
	CONSTRAINT "ai_agent_actions_tool" CHECK ("tool" ~ '^[a-z][a-z0-9_.]{1,60}$'),
	CONSTRAINT "ai_agent_actions_args" CHECK (jsonb_typeof("args") = 'object' AND octet_length("args"::text) <= 4000),
	CONSTRAINT "ai_agent_actions_result" CHECK ("result" IS NULL OR octet_length("result"::text) <= 4000),
	CONSTRAINT "ai_agent_actions_error" CHECK ("error" IS NULL OR char_length("error") <= 500),
	CONSTRAINT "ai_agent_actions_decided" CHECK (("status" = 'pending') = ("decided_by" IS NULL))
);--> statement-breakpoint
ALTER TABLE "ai_agent_actions" ADD CONSTRAINT "ai_agent_actions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_agent_actions" ADD CONSTRAINT "ai_agent_actions_requested_by_user_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_agent_actions" ADD CONSTRAINT "ai_agent_actions_decided_by_user_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_agent_actions" ADD CONSTRAINT "ai_agent_actions_version_fk" FOREIGN KEY ("workspace_id","agent_id","agent_version_id") REFERENCES "public"."ai_agent_versions"("workspace_id","agent_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_agent_actions" ADD CONSTRAINT "ai_agent_actions_contact_fk" FOREIGN KEY ("workspace_id","contact_id") REFERENCES "public"."contacts"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ai_agent_actions_pending_idx" ON "ai_agent_actions" USING btree ("workspace_id","created_at") WHERE "status" = 'pending';--> statement-breakpoint
CREATE INDEX "ai_agent_actions_agent_idx" ON "ai_agent_actions" USING btree ("workspace_id","agent_id","created_at");--> statement-breakpoint
-- Link a model call to the agent version that made it (ids and a version number only, never prompt text).
ALTER TABLE "ai_runs" ADD COLUMN "agent_id" uuid;--> statement-breakpoint
ALTER TABLE "ai_runs" ADD COLUMN "agent_version" integer;--> statement-breakpoint
ALTER TABLE "ai_runs" ADD CONSTRAINT "ai_runs_agent_pair" CHECK (("agent_id" IS NULL) = ("agent_version" IS NULL));--> statement-breakpoint
ALTER TABLE "ai_runs" ADD CONSTRAINT "ai_runs_agent_fk" FOREIGN KEY ("workspace_id","agent_id") REFERENCES "public"."ai_agents"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ai_runs_agent_idx" ON "ai_runs" USING btree ("workspace_id","agent_id","created_at") WHERE "agent_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE ai_agents ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ai_agents FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ai_agent_versions ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ai_agent_versions FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ai_agent_actions ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ai_agent_actions FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON ai_agents, ai_agent_versions, ai_agent_actions FROM crm_app, crm_worker;--> statement-breakpoint
GRANT SELECT, INSERT ON ai_agents, ai_agent_versions, ai_agent_actions TO crm_app;--> statement-breakpoint
GRANT UPDATE (name, description, status, active_version_id, updated_at) ON ai_agents TO crm_app;--> statement-breakpoint
GRANT UPDATE (status, decided_by, decided_at, result, error, updated_at) ON ai_agent_actions TO crm_app;--> statement-breakpoint
-- The worker (runAi) needs nothing here: the API hands it the composed system text.
-- owner/admin manage; the agent role (members with ai.use) may read agents to run them and queue proposals; viewers see nothing.
CREATE POLICY aiag_select ON ai_agents FOR SELECT TO crm_app USING (workspace_id = (SELECT app_workspace_id()) AND (SELECT app_has_role(array['owner','admin','agent'])));--> statement-breakpoint
CREATE POLICY aiag_insert ON ai_agents FOR INSERT TO crm_app WITH CHECK (workspace_id = (SELECT app_workspace_id()) AND (SELECT app_has_role(array['owner','admin'])) AND created_by = (SELECT app_user_id()));--> statement-breakpoint
CREATE POLICY aiag_update ON ai_agents FOR UPDATE TO crm_app USING (workspace_id = (SELECT app_workspace_id()) AND (SELECT app_has_role(array['owner','admin']))) WITH CHECK (workspace_id = (SELECT app_workspace_id()) AND (SELECT app_has_role(array['owner','admin'])));--> statement-breakpoint
CREATE POLICY aiagv_select ON ai_agent_versions FOR SELECT TO crm_app USING (workspace_id = (SELECT app_workspace_id()) AND (SELECT app_has_role(array['owner','admin','agent'])));--> statement-breakpoint
CREATE POLICY aiagv_insert ON ai_agent_versions FOR INSERT TO crm_app WITH CHECK (workspace_id = (SELECT app_workspace_id()) AND (SELECT app_has_role(array['owner','admin'])) AND created_by = (SELECT app_user_id()));--> statement-breakpoint
CREATE POLICY aiaga_select ON ai_agent_actions FOR SELECT TO crm_app USING (workspace_id = (SELECT app_workspace_id()) AND ((SELECT app_has_role(array['owner','admin'])) OR (requested_by = (SELECT app_user_id()) AND (SELECT app_has_role(array['agent'])))));--> statement-breakpoint
CREATE POLICY aiaga_insert ON ai_agent_actions FOR INSERT TO crm_app WITH CHECK (workspace_id = (SELECT app_workspace_id()) AND (SELECT app_has_role(array['owner','admin','agent'])) AND requested_by = (SELECT app_user_id()));--> statement-breakpoint
CREATE POLICY aiaga_update ON ai_agent_actions FOR UPDATE TO crm_app USING (workspace_id = (SELECT app_workspace_id()) AND (SELECT app_has_role(array['owner','admin']))) WITH CHECK (workspace_id = (SELECT app_workspace_id()) AND (SELECT app_has_role(array['owner','admin'])));--> statement-breakpoint
CREATE FUNCTION ai_agents_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id <> OLD.id OR NEW.workspace_id <> OLD.workspace_id OR NEW.key <> OLD.key OR NEW.created_by <> OLD.created_by OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'an ai agent cannot change its identity';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER ai_agents_guard_trg BEFORE UPDATE ON ai_agents FOR EACH ROW EXECUTE FUNCTION ai_agents_guard();--> statement-breakpoint
CREATE TRIGGER ai_agent_versions_append_only BEFORE UPDATE OR DELETE ON ai_agent_versions FOR EACH ROW EXECUTE FUNCTION ai_append_only();--> statement-breakpoint
-- A decided action is final; only pending -> approved|rejected and approved -> executed|failed are allowed, and the proposal itself never changes.
CREATE FUNCTION ai_agent_actions_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'ai_agent_actions rows cannot be deleted'; END IF;
  IF NEW.id <> OLD.id OR NEW.workspace_id <> OLD.workspace_id OR NEW.agent_id <> OLD.agent_id OR NEW.agent_version_id <> OLD.agent_version_id OR NEW.tool <> OLD.tool OR NEW.args <> OLD.args OR NEW.requested_by <> OLD.requested_by OR NEW.source <> OLD.source OR NEW.contact_id IS DISTINCT FROM OLD.contact_id THEN
    RAISE EXCEPTION 'a proposed agent action cannot be edited';
  END IF;
  IF NOT ((OLD.status = 'pending' AND NEW.status IN ('approved','rejected')) OR (OLD.status = 'approved' AND NEW.status IN ('executed','failed'))) THEN
    RAISE EXCEPTION 'invalid agent action status change % -> %', OLD.status, NEW.status;
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER ai_agent_actions_guard_trg BEFORE UPDATE OR DELETE ON ai_agent_actions FOR EACH ROW EXECUTE FUNCTION ai_agent_actions_guard();
