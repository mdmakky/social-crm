-- Security review M4 and m1: make the database enforce the permission matrix where it can, instead of trusting the API alone.
-- Additive: only policies are replaced; no data or column changes. Earlier migrations are untouched.

-- audit_log: only owners and admins read it (matrix: audit.view); inserts need an active membership in the workspace in context.
DROP POLICY audit_log_select ON audit_log;
--> statement-breakpoint
CREATE POLICY audit_log_select ON audit_log FOR SELECT USING (workspace_id = (SELECT app_workspace_id()) AND (SELECT app_has_role(array['owner','admin'])));
--> statement-breakpoint
DROP POLICY audit_log_insert ON audit_log;
--> statement-breakpoint
CREATE POLICY audit_log_insert ON audit_log FOR INSERT WITH CHECK (workspace_id = (SELECT app_workspace_id()) AND (SELECT app_has_role(array['owner','admin','agent','viewer'])));
--> statement-breakpoint

-- workspaces: no longer visible just because app.workspace_id names it; the caller must be a member or the creating owner.
-- Renaming or changing settings is owner/admin only (matrix: workspace.settings).
DROP POLICY workspaces_select ON workspaces;
--> statement-breakpoint
CREATE POLICY workspaces_select ON workspaces FOR SELECT USING (
  owner_user_id = (SELECT app_user_id())
  OR id IN (SELECT workspace_id FROM memberships WHERE user_id = (SELECT app_user_id()) AND status = 'active')
);
--> statement-breakpoint
DROP POLICY workspaces_update ON workspaces;
--> statement-breakpoint
CREATE POLICY workspaces_update ON workspaces FOR UPDATE USING (id = (SELECT app_workspace_id()) AND (SELECT app_has_role(array['owner','admin']))) WITH CHECK (id = (SELECT app_workspace_id()) AND (SELECT app_has_role(array['owner','admin'])));
--> statement-breakpoint

-- contacts: soft delete (deleted_at) is admin-only, as in the matrix (contact.delete). Agents can still edit live contacts.
DROP POLICY contacts_update ON contacts;
--> statement-breakpoint
CREATE POLICY contacts_update ON contacts FOR UPDATE
  USING (workspace_id = (SELECT app_workspace_id()) AND (SELECT app_has_role(array['owner','admin','agent'])) AND (deleted_at IS NULL OR (SELECT app_has_role(array['owner','admin']))))
  WITH CHECK (workspace_id = (SELECT app_workspace_id()) AND (SELECT app_has_role(array['owner','admin','agent'])) AND (deleted_at IS NULL OR (SELECT app_has_role(array['owner','admin']))));
--> statement-breakpoint

-- tasks: agents may only change or delete tasks they created or are assigned to (matrix: task.edit is "own" for agents).
DROP POLICY tasks_update ON tasks;
--> statement-breakpoint
CREATE POLICY tasks_update ON tasks FOR UPDATE
  USING (workspace_id = (SELECT app_workspace_id()) AND ((SELECT app_has_role(array['owner','admin'])) OR ((SELECT app_has_role(array['agent'])) AND (assignee_user_id = (SELECT app_user_id()) OR created_by = (SELECT app_user_id())))))
  WITH CHECK (workspace_id = (SELECT app_workspace_id()) AND ((SELECT app_has_role(array['owner','admin'])) OR ((SELECT app_has_role(array['agent'])) AND (assignee_user_id = (SELECT app_user_id()) OR created_by = (SELECT app_user_id())))));
--> statement-breakpoint
DROP POLICY tasks_delete ON tasks;
--> statement-breakpoint
CREATE POLICY tasks_delete ON tasks FOR DELETE
  USING (workspace_id = (SELECT app_workspace_id()) AND ((SELECT app_has_role(array['owner','admin'])) OR ((SELECT app_has_role(array['agent'])) AND (assignee_user_id = (SELECT app_user_id()) OR created_by = (SELECT app_user_id())))));
--> statement-breakpoint

-- activities: an entry is attributed to the caller or to nobody (system); it cannot be forged for another user.
DROP POLICY activities_insert ON activities;
--> statement-breakpoint
CREATE POLICY activities_insert ON activities FOR INSERT WITH CHECK (workspace_id = (SELECT app_workspace_id()) AND (SELECT app_has_role(array['owner','admin','agent'])) AND (actor_user_id IS NULL OR actor_user_id = (SELECT app_user_id())));
