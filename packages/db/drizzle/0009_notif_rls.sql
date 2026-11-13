-- Track C (notifications + event outbox) RLS. Self-contained so the integrator can re-apply it after regenerating the tables.
-- app_is_system(): true only inside the dispatcher's transactions (it sets app.system = 'dispatcher' with set_config(..., true)).
-- Request handlers never set it. It unlocks event-log reads and notification inserts, never reading another user's notifications.
CREATE FUNCTION app_is_system() RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT coalesce(current_setting('app.system', true), '') = 'dispatcher' $$;
--> statement-breakpoint
ALTER TABLE domain_events ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE domain_events FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE workspace_event_counters ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE workspace_event_counters FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE event_consumers ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE event_consumers FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE notifications FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE notification_preferences ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE notification_preferences FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
-- domain_events: any active member's request may append; only the system path reads; deletes only at or below every consumer offset (pruning).
CREATE POLICY domain_events_insert ON domain_events FOR INSERT WITH CHECK (workspace_id = (SELECT app_workspace_id()) AND (SELECT app_has_role(array['owner','admin','agent','viewer'])));
--> statement-breakpoint
CREATE POLICY domain_events_select ON domain_events FOR SELECT USING (workspace_id = (SELECT app_workspace_id()) AND (SELECT app_is_system()));
--> statement-breakpoint
CREATE POLICY domain_events_delete ON domain_events FOR DELETE USING (
  workspace_id = (SELECT app_workspace_id()) AND (SELECT app_is_system())
  AND seq <= (SELECT min(c.last_seq) FROM event_consumers c WHERE c.workspace_id = domain_events.workspace_id)
);
--> statement-breakpoint
REVOKE UPDATE, TRUNCATE ON domain_events FROM crm_app;
--> statement-breakpoint
-- workspace_event_counters: members bump it through emitEvent; the dispatcher may list it to discover workspaces (ids and counters only).
CREATE POLICY workspace_event_counters_select ON workspace_event_counters FOR SELECT USING (workspace_id = (SELECT app_workspace_id()) OR (SELECT app_is_system()));
--> statement-breakpoint
CREATE POLICY workspace_event_counters_insert ON workspace_event_counters FOR INSERT WITH CHECK (workspace_id = (SELECT app_workspace_id()) AND (SELECT app_has_role(array['owner','admin','agent','viewer'])) AND last_seq = 0);
--> statement-breakpoint
CREATE POLICY workspace_event_counters_update ON workspace_event_counters FOR UPDATE USING (workspace_id = (SELECT app_workspace_id()) AND (SELECT app_has_role(array['owner','admin','agent','viewer']))) WITH CHECK (workspace_id = (SELECT app_workspace_id()));
--> statement-breakpoint
REVOKE DELETE, TRUNCATE ON workspace_event_counters FROM crm_app;
--> statement-breakpoint
-- the counter may only ever move up by exactly one (gapless seq)
CREATE FUNCTION workspace_event_counter_step() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.last_seq <> OLD.last_seq + 1 THEN RAISE EXCEPTION 'event counter must increase by exactly 1'; END IF; RETURN NEW; END $$;
--> statement-breakpoint
CREATE TRIGGER workspace_event_counter_step BEFORE UPDATE ON workspace_event_counters FOR EACH ROW EXECUTE FUNCTION workspace_event_counter_step();
--> statement-breakpoint
-- event_consumers: dispatcher only
CREATE POLICY event_consumers_select ON event_consumers FOR SELECT USING (workspace_id = (SELECT app_workspace_id()) AND (SELECT app_is_system()));
--> statement-breakpoint
CREATE POLICY event_consumers_insert ON event_consumers FOR INSERT WITH CHECK (workspace_id = (SELECT app_workspace_id()) AND (SELECT app_is_system()));
--> statement-breakpoint
CREATE POLICY event_consumers_update ON event_consumers FOR UPDATE USING (workspace_id = (SELECT app_workspace_id()) AND (SELECT app_is_system())) WITH CHECK (workspace_id = (SELECT app_workspace_id()));
--> statement-breakpoint
REVOKE DELETE, TRUNCATE ON event_consumers FROM crm_app;
--> statement-breakpoint
-- notifications: a user reads and updates ONLY their own rows (admins included). Inserts: system path, recipient must be an active member.
CREATE POLICY notifications_select ON notifications FOR SELECT USING (workspace_id = (SELECT app_workspace_id()) AND user_id = (SELECT app_user_id()));
--> statement-breakpoint
CREATE POLICY notifications_update ON notifications FOR UPDATE USING (workspace_id = (SELECT app_workspace_id()) AND user_id = (SELECT app_user_id())) WITH CHECK (workspace_id = (SELECT app_workspace_id()) AND user_id = (SELECT app_user_id()));
--> statement-breakpoint
CREATE POLICY notifications_insert ON notifications FOR INSERT WITH CHECK (
  workspace_id = (SELECT app_workspace_id()) AND (SELECT app_is_system())
  AND EXISTS (SELECT 1 FROM memberships m WHERE m.workspace_id = notifications.workspace_id AND m.user_id = notifications.user_id AND m.status = 'active')
);
--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE ON notifications FROM crm_app;
--> statement-breakpoint
GRANT UPDATE (read_at) ON notifications TO crm_app;
--> statement-breakpoint
-- notification_preferences: own rows only; the dispatcher may read them to honour preferences
CREATE POLICY notification_preferences_select ON notification_preferences FOR SELECT USING (workspace_id = (SELECT app_workspace_id()) AND (user_id = (SELECT app_user_id()) OR (SELECT app_is_system())));
--> statement-breakpoint
CREATE POLICY notification_preferences_insert ON notification_preferences FOR INSERT WITH CHECK (workspace_id = (SELECT app_workspace_id()) AND user_id = (SELECT app_user_id()) AND (SELECT app_has_role(array['owner','admin','agent','viewer'])));
--> statement-breakpoint
CREATE POLICY notification_preferences_update ON notification_preferences FOR UPDATE USING (workspace_id = (SELECT app_workspace_id()) AND user_id = (SELECT app_user_id())) WITH CHECK (workspace_id = (SELECT app_workspace_id()) AND user_id = (SELECT app_user_id()));
--> statement-breakpoint
REVOKE DELETE, TRUNCATE ON notification_preferences FROM crm_app;
