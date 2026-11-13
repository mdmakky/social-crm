-- Leads and pipelines: RLS, grants, immutability and append-only triggers, task_links allow-list. Policies use scalar subqueries (D45).
ALTER TABLE pipelines ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE pipelines FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON pipelines TO crm_app;
--> statement-breakpoint
ALTER TABLE pipeline_stages ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE pipeline_stages FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON pipeline_stages TO crm_app;
--> statement-breakpoint
ALTER TABLE lost_reasons ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE lost_reasons FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON lost_reasons TO crm_app;
--> statement-breakpoint
ALTER TABLE leads ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE leads FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON leads TO crm_app;
--> statement-breakpoint
ALTER TABLE lead_tags ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE lead_tags FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON lead_tags TO crm_app;
--> statement-breakpoint
ALTER TABLE stage_transitions ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE stage_transitions FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON stage_transitions TO crm_app;
--> statement-breakpoint
ALTER TABLE lead_value_grants ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE lead_value_grants FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON lead_value_grants TO crm_app;
--> statement-breakpoint
CREATE POLICY pipelines_select ON pipelines FOR SELECT USING (workspace_id = (SELECT app_workspace_id()) AND (SELECT app_has_role(array['owner','admin','agent','viewer'])));
--> statement-breakpoint
CREATE POLICY pipelines_insert ON pipelines FOR INSERT WITH CHECK (workspace_id = (SELECT app_workspace_id()) AND (SELECT app_has_role(array['owner','admin'])));
--> statement-breakpoint
CREATE POLICY pipelines_update ON pipelines FOR UPDATE USING (workspace_id = (SELECT app_workspace_id()) AND (SELECT app_has_role(array['owner','admin']))) WITH CHECK (workspace_id = (SELECT app_workspace_id()) AND (SELECT app_has_role(array['owner','admin'])));
--> statement-breakpoint
REVOKE DELETE, TRUNCATE ON pipelines FROM crm_app;
--> statement-breakpoint
CREATE POLICY pipeline_stages_select ON pipeline_stages FOR SELECT USING (workspace_id = (SELECT app_workspace_id()) AND (SELECT app_has_role(array['owner','admin','agent','viewer'])));
--> statement-breakpoint
CREATE POLICY pipeline_stages_insert ON pipeline_stages FOR INSERT WITH CHECK (workspace_id = (SELECT app_workspace_id()) AND (SELECT app_has_role(array['owner','admin'])));
--> statement-breakpoint
CREATE POLICY pipeline_stages_update ON pipeline_stages FOR UPDATE USING (workspace_id = (SELECT app_workspace_id()) AND (SELECT app_has_role(array['owner','admin']))) WITH CHECK (workspace_id = (SELECT app_workspace_id()) AND (SELECT app_has_role(array['owner','admin'])));
--> statement-breakpoint
REVOKE DELETE, TRUNCATE ON pipeline_stages FROM crm_app;
--> statement-breakpoint
CREATE POLICY lost_reasons_select ON lost_reasons FOR SELECT USING (workspace_id = (SELECT app_workspace_id()) AND (SELECT app_has_role(array['owner','admin','agent','viewer'])));
--> statement-breakpoint
CREATE POLICY lost_reasons_insert ON lost_reasons FOR INSERT WITH CHECK (workspace_id = (SELECT app_workspace_id()) AND (SELECT app_has_role(array['owner','admin'])));
--> statement-breakpoint
CREATE POLICY lost_reasons_update ON lost_reasons FOR UPDATE USING (workspace_id = (SELECT app_workspace_id()) AND (SELECT app_has_role(array['owner','admin']))) WITH CHECK (workspace_id = (SELECT app_workspace_id()) AND (SELECT app_has_role(array['owner','admin'])));
--> statement-breakpoint
REVOKE DELETE, TRUNCATE ON lost_reasons FROM crm_app;
--> statement-breakpoint
CREATE POLICY leads_select ON leads FOR SELECT USING (workspace_id = (SELECT app_workspace_id()) AND (SELECT app_has_role(array['owner','admin','agent','viewer'])));
--> statement-breakpoint
CREATE POLICY leads_insert ON leads FOR INSERT WITH CHECK (workspace_id = (SELECT app_workspace_id()) AND (SELECT app_has_role(array['owner','admin','agent'])) AND deleted_at IS NULL);
--> statement-breakpoint
CREATE POLICY leads_update ON leads FOR UPDATE USING (workspace_id = (SELECT app_workspace_id()) AND (SELECT app_has_role(array['owner','admin','agent']))) WITH CHECK (workspace_id = (SELECT app_workspace_id()) AND (SELECT app_has_role(array['owner','admin','agent'])) AND (deleted_at IS NULL OR (SELECT app_has_role(array['owner','admin']))));
--> statement-breakpoint
REVOKE DELETE, TRUNCATE ON leads FROM crm_app;
--> statement-breakpoint
CREATE POLICY lead_tags_select ON lead_tags FOR SELECT USING (workspace_id = (SELECT app_workspace_id()) AND (SELECT app_has_role(array['owner','admin','agent','viewer'])));
--> statement-breakpoint
CREATE POLICY lead_tags_insert ON lead_tags FOR INSERT WITH CHECK (workspace_id = (SELECT app_workspace_id()) AND (SELECT app_has_role(array['owner','admin','agent'])));
--> statement-breakpoint
CREATE POLICY lead_tags_delete ON lead_tags FOR DELETE USING (workspace_id = (SELECT app_workspace_id()) AND (SELECT app_has_role(array['owner','admin','agent'])));
--> statement-breakpoint
REVOKE UPDATE, TRUNCATE ON lead_tags FROM crm_app;
--> statement-breakpoint
CREATE POLICY stage_transitions_select ON stage_transitions FOR SELECT USING (workspace_id = (SELECT app_workspace_id()) AND (SELECT app_has_role(array['owner','admin','agent','viewer'])));
--> statement-breakpoint
CREATE POLICY stage_transitions_insert ON stage_transitions FOR INSERT WITH CHECK (workspace_id = (SELECT app_workspace_id()) AND (SELECT app_has_role(array['owner','admin','agent'])) AND actor_user_id = (SELECT app_user_id()));
--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE ON stage_transitions FROM crm_app;
--> statement-breakpoint
CREATE FUNCTION stage_transitions_append_only() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'stage_transitions are append-only'; END $$;
--> statement-breakpoint
CREATE TRIGGER stage_transitions_append_only_guard BEFORE UPDATE OR DELETE OR TRUNCATE ON stage_transitions FOR EACH STATEMENT EXECUTE FUNCTION stage_transitions_append_only();
--> statement-breakpoint
CREATE POLICY lead_value_grants_select ON lead_value_grants FOR SELECT USING (workspace_id = (SELECT app_workspace_id()) AND ((SELECT app_has_role(array['owner','admin'])) OR user_id = (SELECT app_user_id())));
--> statement-breakpoint
CREATE POLICY lead_value_grants_insert ON lead_value_grants FOR INSERT WITH CHECK (workspace_id = (SELECT app_workspace_id()) AND (SELECT app_has_role(array['owner','admin'])) AND granted_by = (SELECT app_user_id()));
--> statement-breakpoint
CREATE POLICY lead_value_grants_update ON lead_value_grants FOR UPDATE USING (workspace_id = (SELECT app_workspace_id()) AND (SELECT app_has_role(array['owner','admin']))) WITH CHECK (workspace_id = (SELECT app_workspace_id()) AND (SELECT app_has_role(array['owner','admin'])));
--> statement-breakpoint
CREATE POLICY lead_value_grants_delete ON lead_value_grants FOR DELETE USING (workspace_id = (SELECT app_workspace_id()) AND (SELECT app_has_role(array['owner','admin'])));
--> statement-breakpoint
REVOKE TRUNCATE ON lead_value_grants FROM crm_app;
--> statement-breakpoint
CREATE FUNCTION pipeline_stages_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.kind <> OLD.kind OR NEW.pipeline_id <> OLD.pipeline_id THEN RAISE EXCEPTION 'stage kind and pipeline are immutable'; END IF; RETURN NEW; END $$;
--> statement-breakpoint
CREATE TRIGGER pipeline_stages_immutable_trg BEFORE UPDATE ON pipeline_stages FOR EACH ROW EXECUTE FUNCTION pipeline_stages_immutable();
--> statement-breakpoint
ALTER TABLE task_links DROP CONSTRAINT task_links_entity_type_allowed;
--> statement-breakpoint
ALTER TABLE task_links ADD CONSTRAINT task_links_entity_type_allowed CHECK (entity_type IN ('contact','lead'));
--> statement-breakpoint
CREATE OR REPLACE FUNCTION task_links_validate() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.entity_type = 'contact' AND NOT EXISTS (SELECT 1 FROM contacts c WHERE c.workspace_id = NEW.workspace_id AND c.id = NEW.entity_id) THEN
    RAISE EXCEPTION 'task link target does not exist in this workspace';
  END IF;
  IF NEW.entity_type = 'lead' AND NOT EXISTS (SELECT 1 FROM leads l WHERE l.workspace_id = NEW.workspace_id AND l.id = NEW.entity_id) THEN
    RAISE EXCEPTION 'task link target does not exist in this workspace';
  END IF;
  RETURN NEW;
END $$;

