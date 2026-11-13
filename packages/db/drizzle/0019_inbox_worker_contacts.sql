-- Slice 2: the worker creates a contact when an unknown platform user writes in. Minimal, column-level, workspace-scoped (the worker sets app.workspace_id after routing).
GRANT SELECT ON lifecycle_stages TO crm_worker;
--> statement-breakpoint
CREATE POLICY ls_worker_select ON lifecycle_stages FOR SELECT TO crm_worker USING (workspace_id = (SELECT app_workspace_id()));
--> statement-breakpoint
GRANT SELECT (id, workspace_id, name, deleted_at, last_activity_at) ON contacts TO crm_worker;
--> statement-breakpoint
GRANT INSERT (workspace_id, name, lifecycle_stage_id, source) ON contacts TO crm_worker;
--> statement-breakpoint
GRANT UPDATE (last_activity_at) ON contacts TO crm_worker;
--> statement-breakpoint
CREATE POLICY contacts_worker_select ON contacts FOR SELECT TO crm_worker USING (workspace_id = (SELECT app_workspace_id()));
--> statement-breakpoint
CREATE POLICY contacts_worker_insert ON contacts FOR INSERT TO crm_worker WITH CHECK (workspace_id = (SELECT app_workspace_id()) AND source IN ('messenger','instagram'));
--> statement-breakpoint
CREATE POLICY contacts_worker_update ON contacts FOR UPDATE TO crm_worker USING (workspace_id = (SELECT app_workspace_id())) WITH CHECK (workspace_id = (SELECT app_workspace_id()));
