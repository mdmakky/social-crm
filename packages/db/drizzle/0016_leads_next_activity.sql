-- leads.next_activity_at = earliest due_at among open/in_progress, non-deleted tasks linked to the lead (null if none). Kept in step by triggers in the writer's transaction.
CREATE FUNCTION leads_recompute_next_activity(p_workspace uuid, p_lead uuid) RETURNS void LANGUAGE sql AS $$
  UPDATE leads l SET next_activity_at = n.v
  FROM (SELECT min(t.due_at) AS v FROM task_links tl JOIN tasks t ON t.workspace_id = tl.workspace_id AND t.id = tl.task_id
        WHERE tl.workspace_id = p_workspace AND tl.entity_type = 'lead' AND tl.entity_id = p_lead AND t.status IN ('open', 'in_progress') AND t.deleted_at IS NULL) n
  WHERE l.workspace_id = p_workspace AND l.id = p_lead AND l.deleted_at IS NULL AND l.next_activity_at IS DISTINCT FROM n.v;
$$;
--> statement-breakpoint
CREATE FUNCTION task_links_next_activity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.entity_type = 'lead' THEN PERFORM leads_recompute_next_activity(OLD.workspace_id, OLD.entity_id); END IF;
  ELSIF NEW.entity_type = 'lead' THEN
    PERFORM leads_recompute_next_activity(NEW.workspace_id, NEW.entity_id);
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE TRIGGER task_links_next_activity_trg AFTER INSERT OR DELETE ON task_links FOR EACH ROW EXECUTE FUNCTION task_links_next_activity();
--> statement-breakpoint
CREATE FUNCTION tasks_next_activity() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE r record;
BEGIN
  FOR r IN SELECT entity_id FROM task_links WHERE workspace_id = NEW.workspace_id AND task_id = NEW.id AND entity_type = 'lead' LOOP
    PERFORM leads_recompute_next_activity(NEW.workspace_id, r.entity_id);
  END LOOP;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE TRIGGER tasks_next_activity_trg AFTER UPDATE OF status, due_at, deleted_at ON tasks FOR EACH ROW EXECUTE FUNCTION tasks_next_activity();
--> statement-breakpoint
UPDATE leads l SET next_activity_at = n.v
FROM (SELECT tl.workspace_id, tl.entity_id, min(t.due_at) AS v FROM task_links tl JOIN tasks t ON t.workspace_id = tl.workspace_id AND t.id = tl.task_id
      WHERE tl.entity_type = 'lead' AND t.status IN ('open', 'in_progress') AND t.deleted_at IS NULL GROUP BY 1, 2) n
WHERE l.workspace_id = n.workspace_id AND l.id = n.entity_id AND l.next_activity_at IS DISTINCT FROM n.v;
