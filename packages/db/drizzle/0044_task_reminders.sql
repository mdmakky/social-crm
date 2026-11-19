-- Task reminders. Additive only: two nullable columns and a partial index; RLS unchanged (the app role already has table-level grants).
-- remind_at = when to notify the assignee; reminded_at = set once the notification exists (a changed remind_at clears it).
ALTER TABLE "tasks" ADD COLUMN "remind_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "reminded_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "tasks_remind_idx" ON "tasks" ("remind_at") WHERE remind_at IS NOT NULL AND reminded_at IS NULL AND deleted_at IS NULL;
--> statement-breakpoint
-- The reminder sweep runs as the dispatcher (app.system = 'dispatcher', no user role): it may read open tasks of the workspace it is working on and
-- mark one reminded. It can only touch rows that still await their reminder (reminded_at IS NULL). Permissive policies, OR-ed with the member ones.
CREATE POLICY tasks_system_select ON tasks FOR SELECT TO crm_app USING (workspace_id = (SELECT app_workspace_id()) AND (SELECT app_is_system()) AND remind_at IS NOT NULL);--> statement-breakpoint
CREATE POLICY tasks_system_update ON tasks FOR UPDATE TO crm_app USING (workspace_id = (SELECT app_workspace_id()) AND (SELECT app_is_system()) AND reminded_at IS NULL AND remind_at IS NOT NULL) WITH CHECK (workspace_id = (SELECT app_workspace_id()));
