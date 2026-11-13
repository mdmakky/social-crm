DROP POLICY lifecycle_stages_select ON lifecycle_stages;
--> statement-breakpoint
CREATE POLICY lifecycle_stages_select ON lifecycle_stages FOR SELECT USING (workspace_id = (SELECT app_workspace_id()) AND (SELECT app_has_role(array['owner','admin','agent','viewer'])));
--> statement-breakpoint
DROP POLICY contacts_select ON contacts;
--> statement-breakpoint
CREATE POLICY contacts_select ON contacts FOR SELECT USING (workspace_id = (SELECT app_workspace_id()) AND (SELECT app_has_role(array['owner','admin','agent','viewer'])));
--> statement-breakpoint
DROP POLICY tags_select ON tags;
--> statement-breakpoint
CREATE POLICY tags_select ON tags FOR SELECT USING (workspace_id = (SELECT app_workspace_id()) AND (SELECT app_has_role(array['owner','admin','agent','viewer'])));
--> statement-breakpoint
DROP POLICY contact_tags_select ON contact_tags;
--> statement-breakpoint
CREATE POLICY contact_tags_select ON contact_tags FOR SELECT USING (workspace_id = (SELECT app_workspace_id()) AND (SELECT app_has_role(array['owner','admin','agent','viewer'])));
--> statement-breakpoint
DROP POLICY custom_field_definitions_select ON custom_field_definitions;
--> statement-breakpoint
CREATE POLICY custom_field_definitions_select ON custom_field_definitions FOR SELECT USING (workspace_id = (SELECT app_workspace_id()) AND (SELECT app_has_role(array['owner','admin','agent','viewer'])));
--> statement-breakpoint
DROP POLICY notes_select ON notes;
--> statement-breakpoint
CREATE POLICY notes_select ON notes FOR SELECT USING (workspace_id = (SELECT app_workspace_id()) AND (SELECT app_has_role(array['owner','admin','agent','viewer'])));
--> statement-breakpoint
DROP POLICY activities_select ON activities;
--> statement-breakpoint
CREATE POLICY activities_select ON activities FOR SELECT USING (workspace_id = (SELECT app_workspace_id()) AND (SELECT app_has_role(array['owner','admin','agent','viewer'])));
--> statement-breakpoint
DROP POLICY tasks_select ON tasks;
--> statement-breakpoint
CREATE POLICY tasks_select ON tasks FOR SELECT USING (workspace_id = (SELECT app_workspace_id()) AND (SELECT app_has_role(array['owner','admin','agent','viewer'])));
--> statement-breakpoint
DROP POLICY lifecycle_stages_insert ON lifecycle_stages;
--> statement-breakpoint
CREATE POLICY lifecycle_stages_insert ON lifecycle_stages FOR INSERT WITH CHECK (workspace_id = (SELECT app_workspace_id()) AND (SELECT app_has_role(array['owner','admin'])));
--> statement-breakpoint
DROP POLICY lifecycle_stages_update ON lifecycle_stages;
--> statement-breakpoint
CREATE POLICY lifecycle_stages_update ON lifecycle_stages FOR UPDATE USING (workspace_id = (SELECT app_workspace_id()) AND (SELECT app_has_role(array['owner','admin']))) WITH CHECK (workspace_id = (SELECT app_workspace_id()) AND (SELECT app_has_role(array['owner','admin'])));
--> statement-breakpoint
DROP POLICY contacts_insert ON contacts;
--> statement-breakpoint
CREATE POLICY contacts_insert ON contacts FOR INSERT WITH CHECK (workspace_id = (SELECT app_workspace_id()) AND (SELECT app_has_role(array['owner','admin','agent'])));
--> statement-breakpoint
DROP POLICY contacts_update ON contacts;
--> statement-breakpoint
CREATE POLICY contacts_update ON contacts FOR UPDATE USING (workspace_id = (SELECT app_workspace_id()) AND (SELECT app_has_role(array['owner','admin','agent']))) WITH CHECK (workspace_id = (SELECT app_workspace_id()) AND (SELECT app_has_role(array['owner','admin','agent'])));
--> statement-breakpoint
DROP POLICY tags_insert ON tags;
--> statement-breakpoint
CREATE POLICY tags_insert ON tags FOR INSERT WITH CHECK (workspace_id = (SELECT app_workspace_id()) AND (SELECT app_has_role(array['owner','admin','agent'])));
--> statement-breakpoint
DROP POLICY tags_update ON tags;
--> statement-breakpoint
CREATE POLICY tags_update ON tags FOR UPDATE USING (workspace_id = (SELECT app_workspace_id()) AND (SELECT app_has_role(array['owner','admin']))) WITH CHECK (workspace_id = (SELECT app_workspace_id()) AND (SELECT app_has_role(array['owner','admin'])));
--> statement-breakpoint
DROP POLICY tags_delete ON tags;
--> statement-breakpoint
CREATE POLICY tags_delete ON tags FOR DELETE USING (workspace_id = (SELECT app_workspace_id()) AND (SELECT app_has_role(array['owner','admin'])));
--> statement-breakpoint
DROP POLICY contact_tags_insert ON contact_tags;
--> statement-breakpoint
CREATE POLICY contact_tags_insert ON contact_tags FOR INSERT WITH CHECK (workspace_id = (SELECT app_workspace_id()) AND (SELECT app_has_role(array['owner','admin','agent'])));
--> statement-breakpoint
DROP POLICY contact_tags_delete ON contact_tags;
--> statement-breakpoint
CREATE POLICY contact_tags_delete ON contact_tags FOR DELETE USING (workspace_id = (SELECT app_workspace_id()) AND (SELECT app_has_role(array['owner','admin','agent'])));
--> statement-breakpoint
DROP POLICY custom_field_definitions_insert ON custom_field_definitions;
--> statement-breakpoint
CREATE POLICY custom_field_definitions_insert ON custom_field_definitions FOR INSERT WITH CHECK (workspace_id = (SELECT app_workspace_id()) AND (SELECT app_has_role(array['owner','admin'])));
--> statement-breakpoint
DROP POLICY custom_field_definitions_update ON custom_field_definitions;
--> statement-breakpoint
CREATE POLICY custom_field_definitions_update ON custom_field_definitions FOR UPDATE USING (workspace_id = (SELECT app_workspace_id()) AND (SELECT app_has_role(array['owner','admin']))) WITH CHECK (workspace_id = (SELECT app_workspace_id()) AND (SELECT app_has_role(array['owner','admin'])));
--> statement-breakpoint
DROP POLICY notes_insert ON notes;
--> statement-breakpoint
CREATE POLICY notes_insert ON notes FOR INSERT WITH CHECK (workspace_id = (SELECT app_workspace_id()) AND (SELECT app_has_role(array['owner','admin','agent'])) AND author_user_id = (SELECT app_user_id()));
--> statement-breakpoint
DROP POLICY notes_update ON notes;
--> statement-breakpoint
CREATE POLICY notes_update ON notes FOR UPDATE USING (workspace_id = (SELECT app_workspace_id()) AND ((SELECT app_has_role(array['owner','admin'])) OR (author_user_id = (SELECT app_user_id()) AND (SELECT app_has_role(array['owner','admin','agent']))))) WITH CHECK (workspace_id = (SELECT app_workspace_id()) AND ((SELECT app_has_role(array['owner','admin'])) OR (author_user_id = (SELECT app_user_id()) AND (SELECT app_has_role(array['owner','admin','agent'])))));
--> statement-breakpoint
DROP POLICY activities_insert ON activities;
--> statement-breakpoint
CREATE POLICY activities_insert ON activities FOR INSERT WITH CHECK (workspace_id = (SELECT app_workspace_id()) AND (SELECT app_has_role(array['owner','admin','agent'])));
--> statement-breakpoint
DROP POLICY tasks_insert ON tasks;
--> statement-breakpoint
CREATE POLICY tasks_insert ON tasks FOR INSERT WITH CHECK (workspace_id = (SELECT app_workspace_id()) AND (SELECT app_has_role(array['owner','admin','agent'])));
--> statement-breakpoint
DROP POLICY tasks_update ON tasks;
--> statement-breakpoint
CREATE POLICY tasks_update ON tasks FOR UPDATE USING (workspace_id = (SELECT app_workspace_id()) AND (SELECT app_has_role(array['owner','admin','agent']))) WITH CHECK (workspace_id = (SELECT app_workspace_id()) AND (SELECT app_has_role(array['owner','admin','agent'])));
--> statement-breakpoint
DROP POLICY tasks_delete ON tasks;
--> statement-breakpoint
CREATE POLICY tasks_delete ON tasks FOR DELETE USING (workspace_id = (SELECT app_workspace_id()) AND (SELECT app_has_role(array['owner','admin','agent'])));
--> statement-breakpoint
DROP POLICY saved_views_select ON saved_views;
--> statement-breakpoint
CREATE POLICY saved_views_select ON saved_views FOR SELECT USING (workspace_id = (SELECT app_workspace_id()) AND (SELECT app_has_role(array['owner','admin','agent','viewer'])) AND (user_id IS NULL OR user_id = (SELECT app_user_id())));
--> statement-breakpoint
DROP POLICY saved_views_insert ON saved_views;
--> statement-breakpoint
CREATE POLICY saved_views_insert ON saved_views FOR INSERT WITH CHECK (workspace_id = (SELECT app_workspace_id()) AND (SELECT app_has_role(array['owner','admin','agent','viewer'])) AND (user_id = (SELECT app_user_id()) OR (user_id IS NULL AND (SELECT app_has_role(array['owner','admin'])))));
--> statement-breakpoint
DROP POLICY saved_views_update ON saved_views;
--> statement-breakpoint
CREATE POLICY saved_views_update ON saved_views FOR UPDATE USING (workspace_id = (SELECT app_workspace_id()) AND ((user_id = (SELECT app_user_id()) AND (SELECT app_has_role(array['owner','admin','agent','viewer']))) OR (user_id IS NULL AND (SELECT app_has_role(array['owner','admin']))))) WITH CHECK (workspace_id = (SELECT app_workspace_id()) AND ((user_id = (SELECT app_user_id()) AND (SELECT app_has_role(array['owner','admin','agent','viewer']))) OR (user_id IS NULL AND (SELECT app_has_role(array['owner','admin'])))));
--> statement-breakpoint
DROP POLICY saved_views_delete ON saved_views;
--> statement-breakpoint
CREATE POLICY saved_views_delete ON saved_views FOR DELETE USING (workspace_id = (SELECT app_workspace_id()) AND ((user_id = (SELECT app_user_id()) AND (SELECT app_has_role(array['owner','admin','agent','viewer']))) OR (user_id IS NULL AND (SELECT app_has_role(array['owner','admin'])))));
--> statement-breakpoint
DROP POLICY import_jobs_select ON import_jobs;
--> statement-breakpoint
CREATE POLICY import_jobs_select ON import_jobs FOR SELECT USING (workspace_id = (SELECT app_workspace_id()) AND (SELECT app_has_role(array['owner','admin'])));
--> statement-breakpoint
DROP POLICY import_jobs_insert ON import_jobs;
--> statement-breakpoint
CREATE POLICY import_jobs_insert ON import_jobs FOR INSERT WITH CHECK (workspace_id = (SELECT app_workspace_id()) AND (SELECT app_has_role(array['owner','admin'])));
--> statement-breakpoint
DROP POLICY import_jobs_update ON import_jobs;
--> statement-breakpoint
CREATE POLICY import_jobs_update ON import_jobs FOR UPDATE USING (workspace_id = (SELECT app_workspace_id()) AND (SELECT app_has_role(array['owner','admin']))) WITH CHECK (workspace_id = (SELECT app_workspace_id()) AND (SELECT app_has_role(array['owner','admin'])));
