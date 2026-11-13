CREATE FUNCTION app_has_role(roles text[]) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS (SELECT 1 FROM memberships m WHERE m.workspace_id = app_workspace_id() AND m.user_id = app_user_id() AND m.status = 'active' AND m.role::text = ANY(roles))
$$;
--> statement-breakpoint
ALTER TABLE lifecycle_stages ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE lifecycle_stages FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE contacts ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE contacts FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE tags ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE tags FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE contact_tags ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE contact_tags FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE custom_field_definitions ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE custom_field_definitions FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE notes ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE notes FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE activities ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE activities FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE tasks ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE tasks FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE saved_views ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE saved_views FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE import_jobs ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE import_jobs FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY lifecycle_stages_select ON lifecycle_stages FOR SELECT USING (workspace_id = app_workspace_id() AND app_has_role(array['owner','admin','agent','viewer']));
--> statement-breakpoint
CREATE POLICY contacts_select ON contacts FOR SELECT USING (workspace_id = app_workspace_id() AND app_has_role(array['owner','admin','agent','viewer']));
--> statement-breakpoint
CREATE POLICY tags_select ON tags FOR SELECT USING (workspace_id = app_workspace_id() AND app_has_role(array['owner','admin','agent','viewer']));
--> statement-breakpoint
CREATE POLICY contact_tags_select ON contact_tags FOR SELECT USING (workspace_id = app_workspace_id() AND app_has_role(array['owner','admin','agent','viewer']));
--> statement-breakpoint
CREATE POLICY custom_field_definitions_select ON custom_field_definitions FOR SELECT USING (workspace_id = app_workspace_id() AND app_has_role(array['owner','admin','agent','viewer']));
--> statement-breakpoint
CREATE POLICY notes_select ON notes FOR SELECT USING (workspace_id = app_workspace_id() AND app_has_role(array['owner','admin','agent','viewer']));
--> statement-breakpoint
CREATE POLICY activities_select ON activities FOR SELECT USING (workspace_id = app_workspace_id() AND app_has_role(array['owner','admin','agent','viewer']));
--> statement-breakpoint
CREATE POLICY tasks_select ON tasks FOR SELECT USING (workspace_id = app_workspace_id() AND app_has_role(array['owner','admin','agent','viewer']));
--> statement-breakpoint
CREATE POLICY lifecycle_stages_insert ON lifecycle_stages FOR INSERT WITH CHECK (workspace_id = app_workspace_id() AND app_has_role(array['owner','admin']));
--> statement-breakpoint
CREATE POLICY lifecycle_stages_update ON lifecycle_stages FOR UPDATE USING (workspace_id = app_workspace_id() AND app_has_role(array['owner','admin'])) WITH CHECK (workspace_id = app_workspace_id() AND app_has_role(array['owner','admin']));
--> statement-breakpoint
CREATE POLICY contacts_insert ON contacts FOR INSERT WITH CHECK (workspace_id = app_workspace_id() AND app_has_role(array['owner','admin','agent']));
--> statement-breakpoint
CREATE POLICY contacts_update ON contacts FOR UPDATE USING (workspace_id = app_workspace_id() AND app_has_role(array['owner','admin','agent'])) WITH CHECK (workspace_id = app_workspace_id() AND app_has_role(array['owner','admin','agent']));
--> statement-breakpoint
CREATE POLICY tags_insert ON tags FOR INSERT WITH CHECK (workspace_id = app_workspace_id() AND app_has_role(array['owner','admin','agent']));
--> statement-breakpoint
CREATE POLICY tags_update ON tags FOR UPDATE USING (workspace_id = app_workspace_id() AND app_has_role(array['owner','admin'])) WITH CHECK (workspace_id = app_workspace_id() AND app_has_role(array['owner','admin']));
--> statement-breakpoint
CREATE POLICY tags_delete ON tags FOR DELETE USING (workspace_id = app_workspace_id() AND app_has_role(array['owner','admin']));
--> statement-breakpoint
CREATE POLICY contact_tags_insert ON contact_tags FOR INSERT WITH CHECK (workspace_id = app_workspace_id() AND app_has_role(array['owner','admin','agent']));
--> statement-breakpoint
CREATE POLICY contact_tags_delete ON contact_tags FOR DELETE USING (workspace_id = app_workspace_id() AND app_has_role(array['owner','admin','agent']));
--> statement-breakpoint
CREATE POLICY custom_field_definitions_insert ON custom_field_definitions FOR INSERT WITH CHECK (workspace_id = app_workspace_id() AND app_has_role(array['owner','admin']));
--> statement-breakpoint
CREATE POLICY custom_field_definitions_update ON custom_field_definitions FOR UPDATE USING (workspace_id = app_workspace_id() AND app_has_role(array['owner','admin'])) WITH CHECK (workspace_id = app_workspace_id() AND app_has_role(array['owner','admin']));
--> statement-breakpoint
CREATE POLICY notes_insert ON notes FOR INSERT WITH CHECK (workspace_id = app_workspace_id() AND app_has_role(array['owner','admin','agent']) AND author_user_id = app_user_id());
--> statement-breakpoint
CREATE POLICY notes_update ON notes FOR UPDATE USING (workspace_id = app_workspace_id() AND (app_has_role(array['owner','admin']) OR (author_user_id = app_user_id() AND app_has_role(array['owner','admin','agent'])))) WITH CHECK (workspace_id = app_workspace_id() AND (app_has_role(array['owner','admin']) OR (author_user_id = app_user_id() AND app_has_role(array['owner','admin','agent']))));
--> statement-breakpoint
CREATE POLICY activities_insert ON activities FOR INSERT WITH CHECK (workspace_id = app_workspace_id() AND app_has_role(array['owner','admin','agent']));
--> statement-breakpoint
CREATE POLICY tasks_insert ON tasks FOR INSERT WITH CHECK (workspace_id = app_workspace_id() AND app_has_role(array['owner','admin','agent']));
--> statement-breakpoint
CREATE POLICY tasks_update ON tasks FOR UPDATE USING (workspace_id = app_workspace_id() AND app_has_role(array['owner','admin','agent'])) WITH CHECK (workspace_id = app_workspace_id() AND app_has_role(array['owner','admin','agent']));
--> statement-breakpoint
CREATE POLICY tasks_delete ON tasks FOR DELETE USING (workspace_id = app_workspace_id() AND app_has_role(array['owner','admin','agent']));
--> statement-breakpoint
CREATE POLICY saved_views_select ON saved_views FOR SELECT USING (workspace_id = app_workspace_id() AND app_has_role(array['owner','admin','agent','viewer']) AND (user_id IS NULL OR user_id = app_user_id()));
--> statement-breakpoint
CREATE POLICY saved_views_insert ON saved_views FOR INSERT WITH CHECK (workspace_id = app_workspace_id() AND app_has_role(array['owner','admin','agent','viewer']) AND (user_id = app_user_id() OR (user_id IS NULL AND app_has_role(array['owner','admin']))));
--> statement-breakpoint
CREATE POLICY saved_views_update ON saved_views FOR UPDATE USING (workspace_id = app_workspace_id() AND ((user_id = app_user_id() AND app_has_role(array['owner','admin','agent','viewer'])) OR (user_id IS NULL AND app_has_role(array['owner','admin'])))) WITH CHECK (workspace_id = app_workspace_id() AND ((user_id = app_user_id() AND app_has_role(array['owner','admin','agent','viewer'])) OR (user_id IS NULL AND app_has_role(array['owner','admin']))));
--> statement-breakpoint
CREATE POLICY saved_views_delete ON saved_views FOR DELETE USING (workspace_id = app_workspace_id() AND ((user_id = app_user_id() AND app_has_role(array['owner','admin','agent','viewer'])) OR (user_id IS NULL AND app_has_role(array['owner','admin']))));
--> statement-breakpoint
CREATE POLICY import_jobs_select ON import_jobs FOR SELECT USING (workspace_id = app_workspace_id() AND app_has_role(array['owner','admin']));
--> statement-breakpoint
CREATE POLICY import_jobs_insert ON import_jobs FOR INSERT WITH CHECK (workspace_id = app_workspace_id() AND app_has_role(array['owner','admin']));
--> statement-breakpoint
CREATE POLICY import_jobs_update ON import_jobs FOR UPDATE USING (workspace_id = app_workspace_id() AND app_has_role(array['owner','admin'])) WITH CHECK (workspace_id = app_workspace_id() AND app_has_role(array['owner','admin']));
--> statement-breakpoint
REVOKE DELETE, TRUNCATE ON lifecycle_stages FROM crm_app;
--> statement-breakpoint
REVOKE DELETE, TRUNCATE ON contacts FROM crm_app;
--> statement-breakpoint
REVOKE DELETE, TRUNCATE ON custom_field_definitions FROM crm_app;
--> statement-breakpoint
REVOKE DELETE, TRUNCATE ON notes FROM crm_app;
--> statement-breakpoint
REVOKE DELETE, TRUNCATE ON import_jobs FROM crm_app;
--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE ON activities FROM crm_app;
--> statement-breakpoint
CREATE FUNCTION activities_append_only() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'activities are append-only'; END $$;
--> statement-breakpoint
CREATE TRIGGER activities_append_only_guard BEFORE UPDATE OR DELETE OR TRUNCATE ON activities FOR EACH STATEMENT EXECUTE FUNCTION activities_append_only();
