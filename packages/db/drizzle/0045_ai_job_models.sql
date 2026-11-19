-- One pinned AI model per job (reply, agent, vision, document, transcription). No row = automatic pick. Owner/admin change it, owner/admin/agent read it (same as provider configs), crm_worker (runAi) reads it.
CREATE TABLE "ai_job_models" (
	"workspace_id" uuid NOT NULL,
	"job" text NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"updated_by" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_job_models_pk" PRIMARY KEY("workspace_id","job")
);--> statement-breakpoint
ALTER TABLE "ai_job_models" ADD CONSTRAINT "ai_job_models_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_job_models" ADD CONSTRAINT "ai_job_models_updated_by_user_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE ai_job_models ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ai_job_models FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON ai_job_models FROM crm_app, crm_worker;--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON ai_job_models TO crm_app;--> statement-breakpoint
GRANT UPDATE (provider, model, updated_by, updated_at) ON ai_job_models TO crm_app;--> statement-breakpoint
GRANT SELECT ON ai_job_models TO crm_worker;--> statement-breakpoint
CREATE POLICY aijm_select ON ai_job_models FOR SELECT TO crm_app USING (workspace_id = (SELECT app_workspace_id()) AND (SELECT app_has_role(array['owner','admin','agent'])));--> statement-breakpoint
CREATE POLICY aijm_insert ON ai_job_models FOR INSERT TO crm_app WITH CHECK (workspace_id = (SELECT app_workspace_id()) AND (SELECT app_has_role(array['owner','admin'])));--> statement-breakpoint
CREATE POLICY aijm_update ON ai_job_models FOR UPDATE TO crm_app USING (workspace_id = (SELECT app_workspace_id()) AND (SELECT app_has_role(array['owner','admin']))) WITH CHECK (workspace_id = (SELECT app_workspace_id()) AND (SELECT app_has_role(array['owner','admin'])));--> statement-breakpoint
CREATE POLICY aijm_delete ON ai_job_models FOR DELETE TO crm_app USING (workspace_id = (SELECT app_workspace_id()) AND (SELECT app_has_role(array['owner','admin'])));--> statement-breakpoint
CREATE POLICY aijm_worker_select ON ai_job_models FOR SELECT TO crm_worker USING (workspace_id = (SELECT app_workspace_id()));
