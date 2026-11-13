CREATE FUNCTION app_workspace_id() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('app.workspace_id', true), '')::uuid $$;
--> statement-breakpoint
CREATE FUNCTION app_user_id() RETURNS text LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('app.user_id', true), '') $$;
--> statement-breakpoint
ALTER TABLE workspaces ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE workspaces FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE memberships ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE memberships FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE audit_log FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
-- workspaces: visible to members and to the owner (so INSERT ... RETURNING works before the membership row exists)
CREATE POLICY workspaces_select ON workspaces FOR SELECT USING (
  id = app_workspace_id()
  OR owner_user_id = app_user_id()
  OR id IN (SELECT workspace_id FROM memberships WHERE user_id = app_user_id() AND status = 'active')
);
--> statement-breakpoint
CREATE POLICY workspaces_insert ON workspaces FOR INSERT WITH CHECK (owner_user_id = app_user_id());
--> statement-breakpoint
CREATE POLICY workspaces_update ON workspaces FOR UPDATE USING (id = app_workspace_id()) WITH CHECK (id = app_workspace_id());
--> statement-breakpoint
-- memberships: a user sees their own rows; members of the current workspace see the member list
CREATE POLICY memberships_select ON memberships FOR SELECT USING (user_id = app_user_id() OR workspace_id = app_workspace_id());
--> statement-breakpoint
-- only owners/admins of the current workspace manage memberships; the workspace owner may create their own owner row
CREATE POLICY memberships_insert ON memberships FOR INSERT WITH CHECK (
  (workspace_id = app_workspace_id() AND EXISTS (
     SELECT 1 FROM memberships m WHERE m.workspace_id = app_workspace_id() AND m.user_id = app_user_id() AND m.role IN ('owner','admin') AND m.status = 'active'))
  OR (user_id = app_user_id() AND role = 'owner' AND EXISTS (
     SELECT 1 FROM workspaces w WHERE w.id = workspace_id AND w.owner_user_id = app_user_id()))
);
--> statement-breakpoint
CREATE POLICY memberships_update ON memberships FOR UPDATE USING (
  workspace_id = app_workspace_id() AND EXISTS (
     SELECT 1 FROM memberships m WHERE m.workspace_id = app_workspace_id() AND m.user_id = app_user_id() AND m.role IN ('owner','admin') AND m.status = 'active')
) WITH CHECK (workspace_id = app_workspace_id());
--> statement-breakpoint
CREATE POLICY memberships_delete ON memberships FOR DELETE USING (
  workspace_id = app_workspace_id() AND EXISTS (
     SELECT 1 FROM memberships m WHERE m.workspace_id = app_workspace_id() AND m.user_id = app_user_id() AND m.role IN ('owner','admin') AND m.status = 'active')
);
--> statement-breakpoint
CREATE POLICY audit_log_select ON audit_log FOR SELECT USING (workspace_id = app_workspace_id());
--> statement-breakpoint
CREATE POLICY audit_log_insert ON audit_log FOR INSERT WITH CHECK (workspace_id = app_workspace_id());
--> statement-breakpoint
-- the application role never hard-deletes workspaces and can only append to the audit log
REVOKE DELETE, TRUNCATE ON workspaces FROM crm_app;
--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE ON audit_log FROM crm_app;
--> statement-breakpoint
CREATE FUNCTION audit_log_append_only() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'audit_log is append-only'; END $$;
--> statement-breakpoint
CREATE TRIGGER audit_log_no_update BEFORE UPDATE OR DELETE ON audit_log FOR EACH ROW EXECUTE FUNCTION audit_log_append_only();
