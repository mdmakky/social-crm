-- Track B (tasks): RLS, grants, triggers. Self-contained so the integrator can re-apply it after regenerating the schema migration.
-- Policies call helpers as scalar subqueries (decision D45).

-- Backfill the generic link table for pre-existing contact tasks (before RLS is forced on it).
INSERT INTO task_links (workspace_id, task_id, entity_type, entity_id) SELECT workspace_id, id, 'contact', contact_id FROM tasks WHERE contact_id IS NOT NULL ON CONFLICT DO NOTHING;
--> statement-breakpoint
ALTER TABLE task_links ADD CONSTRAINT task_links_entity_type_allowed CHECK (entity_type IN ('contact'));
--> statement-breakpoint
ALTER TABLE task_events ADD CONSTRAINT task_events_kind_allowed CHECK (kind IN ('created','updated','status_changed','completed','reopened','assignee_changed','due_date_changed','priority_changed','contact_changed','deleted'));
--> statement-breakpoint
ALTER TABLE task_events ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE task_events FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE task_links ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE task_links FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
-- tasks: everyone in the workspace reads; owner/admin write anything; an agent writes only tasks assigned to or created by them (matrix: task.edit "own").
DROP POLICY tasks_insert ON tasks;
--> statement-breakpoint
DROP POLICY tasks_update ON tasks;
--> statement-breakpoint
DROP POLICY tasks_delete ON tasks;
--> statement-breakpoint
CREATE POLICY tasks_insert ON tasks FOR INSERT WITH CHECK (workspace_id = (SELECT app_workspace_id()) AND (SELECT app_has_role(array['owner','admin','agent'])) AND created_by = (SELECT app_user_id()));
--> statement-breakpoint
CREATE POLICY tasks_update ON tasks FOR UPDATE
  USING (workspace_id = (SELECT app_workspace_id()) AND ((SELECT app_has_role(array['owner','admin'])) OR ((SELECT app_has_role(array['agent'])) AND (assignee_user_id = (SELECT app_user_id()) OR created_by = (SELECT app_user_id())))))
  WITH CHECK (workspace_id = (SELECT app_workspace_id()) AND (SELECT app_has_role(array['owner','admin','agent'])));
--> statement-breakpoint
REVOKE DELETE, TRUNCATE ON tasks FROM crm_app;
--> statement-breakpoint
-- task_events: read by all roles, insert by writers as themselves, never updated or deleted.
CREATE POLICY task_events_select ON task_events FOR SELECT USING (workspace_id = (SELECT app_workspace_id()) AND (SELECT app_has_role(array['owner','admin','agent','viewer'])));
--> statement-breakpoint
CREATE POLICY task_events_insert ON task_events FOR INSERT WITH CHECK (workspace_id = (SELECT app_workspace_id()) AND (SELECT app_has_role(array['owner','admin','agent'])) AND actor_user_id = (SELECT app_user_id()));
--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE ON task_events FROM crm_app;
--> statement-breakpoint
CREATE FUNCTION task_events_append_only() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'task_events are append-only'; END $$;
--> statement-breakpoint
CREATE TRIGGER task_events_append_only_guard BEFORE UPDATE OR DELETE OR TRUNCATE ON task_events FOR EACH STATEMENT EXECUTE FUNCTION task_events_append_only();
--> statement-breakpoint
-- task_links: generic task to entity links. Mutable (links come and go) but never updated in place.
CREATE POLICY task_links_select ON task_links FOR SELECT USING (workspace_id = (SELECT app_workspace_id()) AND (SELECT app_has_role(array['owner','admin','agent','viewer'])));
--> statement-breakpoint
CREATE POLICY task_links_insert ON task_links FOR INSERT WITH CHECK (workspace_id = (SELECT app_workspace_id()) AND (SELECT app_has_role(array['owner','admin','agent'])));
--> statement-breakpoint
CREATE POLICY task_links_delete ON task_links FOR DELETE USING (workspace_id = (SELECT app_workspace_id()) AND (SELECT app_has_role(array['owner','admin','agent'])));
--> statement-breakpoint
REVOKE UPDATE, TRUNCATE ON task_links FROM crm_app;
--> statement-breakpoint
-- Per entity type validation (no FK is possible on a polymorphic column). Add one branch per new entity type.
CREATE FUNCTION task_links_validate() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.entity_type = 'contact' AND NOT EXISTS (SELECT 1 FROM contacts c WHERE c.workspace_id = NEW.workspace_id AND c.id = NEW.entity_id) THEN
    RAISE EXCEPTION 'task link target does not exist in this workspace';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER task_links_validate_trg BEFORE INSERT ON task_links FOR EACH ROW EXECUTE FUNCTION task_links_validate();
--> statement-breakpoint
-- tasks.contact_id is the canonical contact link; keep its generic mirror in step atomically.
CREATE FUNCTION tasks_sync_contact_link() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF OLD.contact_id IS NOT DISTINCT FROM NEW.contact_id THEN RETURN NULL; END IF;
    DELETE FROM task_links WHERE workspace_id = NEW.workspace_id AND task_id = NEW.id AND entity_type = 'contact';
  END IF;
  IF NEW.contact_id IS NOT NULL THEN
    INSERT INTO task_links (workspace_id, task_id, entity_type, entity_id) VALUES (NEW.workspace_id, NEW.id, 'contact', NEW.contact_id) ON CONFLICT DO NOTHING;
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE TRIGGER tasks_sync_contact_link_trg AFTER INSERT OR UPDATE OF contact_id ON tasks FOR EACH ROW EXECUTE FUNCTION tasks_sync_contact_link();
