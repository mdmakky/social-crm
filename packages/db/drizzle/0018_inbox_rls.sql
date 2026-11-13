-- Meta Inbox slice 1: roles, forced RLS, column-level grants, state-graph and immutability triggers, per-user unread cursors, raw body purge.
-- Policies use scalar subqueries (D45). Roles: crm_app (the API), crm_ingest (webhook ingress, INSERT only), crm_worker (background processing and the only path that creates integration accounts).
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'crm_ingest') OR NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'crm_worker') THEN
    RAISE EXCEPTION 'roles crm_ingest and crm_worker are missing: run packages/db/sql/001_roles_and_probe.sql as a superuser first';
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE integration_accounts ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE integration_accounts FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE integration_secrets ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE integration_secrets FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE platform_identities ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE platform_identities FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE conversations ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE conversations FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE messages ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE messages FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE conversation_reads ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE conversation_reads FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE webhook_events ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE webhook_events FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE outbound_attempts ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE outbound_attempts FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE integration_events ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE integration_events FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON integration_accounts FROM crm_app;
--> statement-breakpoint
GRANT SELECT ON integration_accounts TO crm_app;
--> statement-breakpoint
GRANT UPDATE (display_name, updated_at) ON integration_accounts TO crm_app;
--> statement-breakpoint
REVOKE ALL ON integration_secrets FROM crm_app;
--> statement-breakpoint
GRANT INSERT ON integration_secrets TO crm_app;
--> statement-breakpoint
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON platform_identities FROM crm_app;
--> statement-breakpoint
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON conversations FROM crm_app;
--> statement-breakpoint
GRANT UPDATE (status, assignee_user_id, lead_id, version, updated_at) ON conversations TO crm_app;
--> statement-breakpoint
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON messages FROM crm_app;
--> statement-breakpoint
GRANT INSERT (workspace_id, conversation_id, integration_account_id, direction, delivery_state, sender_kind, sender_user_id, external_id, client_msg_id, body, attachments) ON messages TO crm_app;
--> statement-breakpoint
GRANT UPDATE (delivery_state, failure_code, client_msg_id) ON messages TO crm_app;
--> statement-breakpoint
REVOKE ALL ON conversation_reads FROM crm_app;
--> statement-breakpoint
GRANT SELECT, INSERT ON conversation_reads TO crm_app;
--> statement-breakpoint
GRANT UPDATE (last_read_seq, updated_at) ON conversation_reads TO crm_app;
--> statement-breakpoint
REVOKE ALL ON webhook_events FROM crm_app;
--> statement-breakpoint
GRANT SELECT (id, workspace_id, platform, received_at, signature_valid, body_sha256, body_size, account_ref, status, attempts, last_error, processed_at, body_purged_at) ON webhook_events TO crm_app;
--> statement-breakpoint
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON outbound_attempts FROM crm_app;
--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE ON integration_events FROM crm_app;
--> statement-breakpoint
GRANT INSERT ON webhook_events TO crm_ingest;
--> statement-breakpoint
GRANT SELECT, INSERT ON integration_accounts TO crm_worker;
--> statement-breakpoint
GRANT UPDATE (status, display_name, scopes, token_expires_at, last_token_check_at, connected_by, connected_at, version, updated_at) ON integration_accounts TO crm_worker;
--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON integration_secrets TO crm_worker;
--> statement-breakpoint
GRANT SELECT, INSERT ON platform_identities TO crm_worker;
--> statement-breakpoint
GRANT UPDATE (profile_name, profile_fetched_at, contact_id) ON platform_identities TO crm_worker;
--> statement-breakpoint
GRANT SELECT, INSERT ON conversations TO crm_worker;
--> statement-breakpoint
GRANT UPDATE (status, assignee_user_id, lead_id, last_message_at, last_inbound_at, contact_delivered_at, contact_read_at, version, updated_at) ON conversations TO crm_worker;
--> statement-breakpoint
GRANT SELECT, INSERT ON messages TO crm_worker;
--> statement-breakpoint
GRANT UPDATE (external_id, delivery_state, failure_code, sent_at, client_msg_id) ON messages TO crm_worker;
--> statement-breakpoint
GRANT SELECT ON webhook_events TO crm_worker;
--> statement-breakpoint
GRANT UPDATE (workspace_id, status, attempts, last_error, processed_at, raw_body, body_purged_at) ON webhook_events TO crm_worker;
--> statement-breakpoint
GRANT SELECT, INSERT ON outbound_attempts TO crm_worker;
--> statement-breakpoint
GRANT UPDATE (finished_at, http_status, platform_error_code, outcome) ON outbound_attempts TO crm_worker;
--> statement-breakpoint
GRANT SELECT, INSERT ON integration_events TO crm_worker;
--> statement-breakpoint
CREATE POLICY ia_select ON integration_accounts FOR SELECT TO crm_app USING (workspace_id = (SELECT app_workspace_id()) AND (SELECT app_has_role(array['owner','admin','agent','viewer'])));
--> statement-breakpoint
CREATE POLICY ia_update ON integration_accounts FOR UPDATE TO crm_app USING (workspace_id = (SELECT app_workspace_id()) AND (SELECT app_has_role(array['owner','admin']))) WITH CHECK (workspace_id = (SELECT app_workspace_id()) AND (SELECT app_has_role(array['owner','admin'])));
--> statement-breakpoint
CREATE POLICY ia_worker_select ON integration_accounts FOR SELECT TO crm_worker USING (true);
--> statement-breakpoint
CREATE POLICY ia_worker_insert ON integration_accounts FOR INSERT TO crm_worker WITH CHECK (workspace_id = (SELECT app_workspace_id()));
--> statement-breakpoint
CREATE POLICY ia_worker_update ON integration_accounts FOR UPDATE TO crm_worker USING (workspace_id = (SELECT app_workspace_id())) WITH CHECK (workspace_id = (SELECT app_workspace_id()));
--> statement-breakpoint
CREATE POLICY isec_insert ON integration_secrets FOR INSERT TO crm_app WITH CHECK (workspace_id = (SELECT app_workspace_id()) AND (SELECT app_has_role(array['owner','admin'])));
--> statement-breakpoint
CREATE POLICY isec_worker_select ON integration_secrets FOR SELECT TO crm_worker USING (workspace_id = (SELECT app_workspace_id()));
--> statement-breakpoint
CREATE POLICY isec_worker_insert ON integration_secrets FOR INSERT TO crm_worker WITH CHECK (workspace_id = (SELECT app_workspace_id()));
--> statement-breakpoint
CREATE POLICY isec_worker_delete ON integration_secrets FOR DELETE TO crm_worker USING (workspace_id = (SELECT app_workspace_id()));
--> statement-breakpoint
CREATE POLICY pi_select ON platform_identities FOR SELECT TO crm_app USING (workspace_id = (SELECT app_workspace_id()) AND (SELECT app_has_role(array['owner','admin','agent','viewer'])));
--> statement-breakpoint
CREATE POLICY pi_worker_select ON platform_identities FOR SELECT TO crm_worker USING (workspace_id = (SELECT app_workspace_id()));
--> statement-breakpoint
CREATE POLICY pi_worker_insert ON platform_identities FOR INSERT TO crm_worker WITH CHECK (workspace_id = (SELECT app_workspace_id()));
--> statement-breakpoint
CREATE POLICY pi_worker_update ON platform_identities FOR UPDATE TO crm_worker USING (workspace_id = (SELECT app_workspace_id())) WITH CHECK (workspace_id = (SELECT app_workspace_id()));
--> statement-breakpoint
CREATE POLICY cv_select ON conversations FOR SELECT TO crm_app USING (workspace_id = (SELECT app_workspace_id()) AND (SELECT app_has_role(array['owner','admin','agent','viewer'])));
--> statement-breakpoint
CREATE POLICY cv_update ON conversations FOR UPDATE TO crm_app USING (workspace_id = (SELECT app_workspace_id()) AND (SELECT app_has_role(array['owner','admin','agent']))) WITH CHECK (workspace_id = (SELECT app_workspace_id()) AND (SELECT app_has_role(array['owner','admin','agent'])));
--> statement-breakpoint
CREATE POLICY cv_worker_select ON conversations FOR SELECT TO crm_worker USING (workspace_id = (SELECT app_workspace_id()));
--> statement-breakpoint
CREATE POLICY cv_worker_insert ON conversations FOR INSERT TO crm_worker WITH CHECK (workspace_id = (SELECT app_workspace_id()));
--> statement-breakpoint
CREATE POLICY cv_worker_update ON conversations FOR UPDATE TO crm_worker USING (workspace_id = (SELECT app_workspace_id())) WITH CHECK (workspace_id = (SELECT app_workspace_id()));
--> statement-breakpoint
CREATE POLICY cv_seq_select ON conversations FOR SELECT TO crm_migrator USING (true);
--> statement-breakpoint
CREATE POLICY cv_seq_update ON conversations FOR UPDATE TO crm_migrator USING (true) WITH CHECK (true);
--> statement-breakpoint
CREATE POLICY ms_select ON messages FOR SELECT TO crm_app USING (workspace_id = (SELECT app_workspace_id()) AND (SELECT app_has_role(array['owner','admin','agent','viewer'])));
--> statement-breakpoint
CREATE POLICY ms_insert ON messages FOR INSERT TO crm_app WITH CHECK (workspace_id = (SELECT app_workspace_id()) AND (SELECT app_has_role(array['owner','admin','agent'])) AND direction = 'out' AND delivery_state = 'pending' AND sender_kind = 'user' AND sender_user_id = (SELECT app_user_id()) AND external_id IS NULL AND client_msg_id IS NOT NULL);
--> statement-breakpoint
CREATE POLICY ms_update ON messages FOR UPDATE TO crm_app USING (workspace_id = (SELECT app_workspace_id()) AND (SELECT app_has_role(array['owner','admin','agent'])) AND direction = 'out') WITH CHECK (workspace_id = (SELECT app_workspace_id()) AND (SELECT app_has_role(array['owner','admin','agent'])) AND direction = 'out');
--> statement-breakpoint
CREATE POLICY ms_worker_select ON messages FOR SELECT TO crm_worker USING (workspace_id = (SELECT app_workspace_id()));
--> statement-breakpoint
CREATE POLICY ms_worker_insert ON messages FOR INSERT TO crm_worker WITH CHECK (workspace_id = (SELECT app_workspace_id()));
--> statement-breakpoint
CREATE POLICY ms_worker_update ON messages FOR UPDATE TO crm_worker USING (workspace_id = (SELECT app_workspace_id())) WITH CHECK (workspace_id = (SELECT app_workspace_id()));
--> statement-breakpoint
CREATE POLICY cr_select ON conversation_reads FOR SELECT TO crm_app USING (workspace_id = (SELECT app_workspace_id()) AND (SELECT app_has_role(array['owner','admin','agent','viewer'])) AND user_id = (SELECT app_user_id()));
--> statement-breakpoint
CREATE POLICY cr_insert ON conversation_reads FOR INSERT TO crm_app WITH CHECK (workspace_id = (SELECT app_workspace_id()) AND (SELECT app_has_role(array['owner','admin','agent','viewer'])) AND user_id = (SELECT app_user_id()));
--> statement-breakpoint
CREATE POLICY cr_update ON conversation_reads FOR UPDATE TO crm_app USING (workspace_id = (SELECT app_workspace_id()) AND (SELECT app_has_role(array['owner','admin','agent','viewer'])) AND user_id = (SELECT app_user_id())) WITH CHECK (workspace_id = (SELECT app_workspace_id()) AND (SELECT app_has_role(array['owner','admin','agent','viewer'])) AND user_id = (SELECT app_user_id()));
--> statement-breakpoint
CREATE POLICY we_select ON webhook_events FOR SELECT TO crm_app USING (workspace_id = (SELECT app_workspace_id()) AND (SELECT app_has_role(array['owner','admin'])));
--> statement-breakpoint
CREATE POLICY we_ingest_insert ON webhook_events FOR INSERT TO crm_ingest WITH CHECK (workspace_id IS NULL AND attempts = 0 AND processed_at IS NULL AND body_purged_at IS NULL AND status IN ('received','rejected','orphan'));
--> statement-breakpoint
CREATE POLICY we_worker_select ON webhook_events FOR SELECT TO crm_worker USING (true);
--> statement-breakpoint
CREATE POLICY we_worker_update ON webhook_events FOR UPDATE TO crm_worker USING (true) WITH CHECK (true);
--> statement-breakpoint
CREATE POLICY oa_select ON outbound_attempts FOR SELECT TO crm_app USING (workspace_id = (SELECT app_workspace_id()) AND (SELECT app_has_role(array['owner','admin','agent'])));
--> statement-breakpoint
CREATE POLICY oa_worker_select ON outbound_attempts FOR SELECT TO crm_worker USING (workspace_id = (SELECT app_workspace_id()));
--> statement-breakpoint
CREATE POLICY oa_worker_insert ON outbound_attempts FOR INSERT TO crm_worker WITH CHECK (workspace_id = (SELECT app_workspace_id()));
--> statement-breakpoint
CREATE POLICY oa_worker_update ON outbound_attempts FOR UPDATE TO crm_worker USING (workspace_id = (SELECT app_workspace_id())) WITH CHECK (workspace_id = (SELECT app_workspace_id()));
--> statement-breakpoint
CREATE POLICY ie_select ON integration_events FOR SELECT TO crm_app USING (workspace_id = (SELECT app_workspace_id()) AND (SELECT app_has_role(array['owner','admin'])));
--> statement-breakpoint
CREATE POLICY ie_insert ON integration_events FOR INSERT TO crm_app WITH CHECK (workspace_id = (SELECT app_workspace_id()) AND (SELECT app_has_role(array['owner','admin'])) AND actor_user_id = (SELECT app_user_id()));
--> statement-breakpoint
CREATE POLICY ie_worker_select ON integration_events FOR SELECT TO crm_worker USING (workspace_id = (SELECT app_workspace_id()));
--> statement-breakpoint
CREATE POLICY ie_worker_insert ON integration_events FOR INSERT TO crm_worker WITH CHECK (workspace_id = (SELECT app_workspace_id()));
--> statement-breakpoint
CREATE FUNCTION messages_assign_seq() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  UPDATE conversations SET message_seq = message_seq + 1 WHERE workspace_id = NEW.workspace_id AND id = NEW.conversation_id RETURNING message_seq INTO NEW.seq;
  IF NOT FOUND THEN RAISE EXCEPTION 'conversation not found'; END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION messages_assign_seq() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER messages_assign_seq_trg BEFORE INSERT ON messages FOR EACH ROW EXECUTE FUNCTION messages_assign_seq();
--> statement-breakpoint
CREATE FUNCTION messages_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE ok boolean;
BEGIN
  IF NEW.id <> OLD.id OR NEW.workspace_id <> OLD.workspace_id OR NEW.conversation_id <> OLD.conversation_id OR NEW.integration_account_id <> OLD.integration_account_id
     OR NEW.direction <> OLD.direction OR NEW.sender_kind <> OLD.sender_kind OR NEW.sender_user_id IS DISTINCT FROM OLD.sender_user_id
     OR NEW.body IS DISTINCT FROM OLD.body OR NEW.attachments <> OLD.attachments OR NEW.occurred_at <> OLD.occurred_at OR NEW.created_at <> OLD.created_at OR NEW.seq <> OLD.seq THEN
    RAISE EXCEPTION 'message content is immutable';
  END IF;
  IF NEW.external_id IS DISTINCT FROM OLD.external_id AND OLD.external_id IS NOT NULL THEN
    RAISE EXCEPTION 'message external id is immutable once set';
  END IF;
  IF OLD.delivery_state = 'failed' AND NEW.delivery_state = 'pending' AND NEW.client_msg_id IS NOT DISTINCT FROM OLD.client_msg_id THEN
    RAISE EXCEPTION 'a retry needs a new client message id';
  END IF;
  IF NEW.client_msg_id IS DISTINCT FROM OLD.client_msg_id AND NOT (OLD.delivery_state = 'failed' AND NEW.delivery_state = 'pending') THEN
    RAISE EXCEPTION 'client message id changes only when a failed message is retried';
  END IF;
  IF NEW.failure_code IS DISTINCT FROM OLD.failure_code AND NEW.delivery_state = OLD.delivery_state THEN
    RAISE EXCEPTION 'failure code changes only together with the delivery state';
  END IF;
  IF NEW.delivery_state <> OLD.delivery_state THEN
    -- Full graph; each role may use only its part. The worker can reach "sent" from unknown (an echo matched it) but never "failed": leaving the unknown state any other way is a human decision (D-G).
    IF current_user = 'crm_app' THEN
      ok := (OLD.delivery_state, NEW.delivery_state) IN (('unknown','sent'),('unknown','failed'),('failed','pending'));
      IF ok AND OLD.delivery_state = 'unknown' AND now() - OLD.state_changed_at < interval '10 minutes' THEN
        RAISE EXCEPTION 'a delivery-unknown message can be decided by a person only after 10 minutes';
      END IF;
    ELSIF current_user = 'crm_worker' THEN
      ok := (OLD.delivery_state, NEW.delivery_state) IN (('pending','sending'),('pending','failed'),('sending','sent'),('sending','failed'),('sending','unknown'),('unknown','sent'));
    ELSE
      ok := (OLD.delivery_state, NEW.delivery_state) IN (('pending','sending'),('pending','failed'),('sending','sent'),('sending','failed'),('sending','unknown'),('unknown','sent'),('unknown','failed'),('failed','pending'));
    END IF;
    IF NOT ok THEN
      RAISE EXCEPTION 'delivery state change % -> % is not allowed for role %', OLD.delivery_state, NEW.delivery_state, current_user;
    END IF;
    NEW.state_changed_at := now();
  ELSE
    NEW.state_changed_at := OLD.state_changed_at;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER messages_guard_trg BEFORE UPDATE ON messages FOR EACH ROW EXECUTE FUNCTION messages_guard();
--> statement-breakpoint
CREATE FUNCTION messages_no_delete() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'messages are never deleted (contact erasure anonymises them through a dedicated procedure)'; END $$;
--> statement-breakpoint
CREATE TRIGGER messages_no_delete_trg BEFORE DELETE OR TRUNCATE ON messages FOR EACH STATEMENT EXECUTE FUNCTION messages_no_delete();
--> statement-breakpoint
CREATE FUNCTION inbox_append_only() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION '% is append-only', TG_TABLE_NAME; END $$;
--> statement-breakpoint
CREATE TRIGGER integration_events_append_only_guard BEFORE UPDATE OR DELETE OR TRUNCATE ON integration_events FOR EACH STATEMENT EXECUTE FUNCTION inbox_append_only();
--> statement-breakpoint
CREATE TRIGGER outbound_attempts_no_delete_guard BEFORE DELETE OR TRUNCATE ON outbound_attempts FOR EACH STATEMENT EXECUTE FUNCTION inbox_append_only();
--> statement-breakpoint
CREATE FUNCTION outbound_attempts_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.outcome IS NOT NULL THEN RAISE EXCEPTION 'a finished send attempt cannot change'; END IF;
  IF NEW.id <> OLD.id OR NEW.workspace_id <> OLD.workspace_id OR NEW.message_id <> OLD.message_id OR NEW.attempt <> OLD.attempt OR NEW.started_at <> OLD.started_at OR NEW.request_summary <> OLD.request_summary THEN
    RAISE EXCEPTION 'send attempt identity is immutable';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER outbound_attempts_guard_trg BEFORE UPDATE ON outbound_attempts FOR EACH ROW EXECUTE FUNCTION outbound_attempts_guard();
--> statement-breakpoint
CREATE FUNCTION integration_accounts_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id <> OLD.id OR NEW.workspace_id <> OLD.workspace_id OR NEW.platform <> OLD.platform OR NEW.external_account_id <> OLD.external_account_id THEN
    RAISE EXCEPTION 'an integration account cannot change workspace, platform or external id';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER integration_accounts_guard_trg BEFORE UPDATE ON integration_accounts FOR EACH ROW EXECUTE FUNCTION integration_accounts_guard();
--> statement-breakpoint
CREATE FUNCTION conversations_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id <> OLD.id OR NEW.workspace_id <> OLD.workspace_id OR NEW.integration_account_id <> OLD.integration_account_id OR NEW.identity_id <> OLD.identity_id THEN
    RAISE EXCEPTION 'a conversation cannot change workspace, account or identity';
  END IF;
  IF NEW.message_seq <> OLD.message_seq AND NEW.message_seq <> OLD.message_seq + 1 THEN
    RAISE EXCEPTION 'the message sequence only advances by one, through the message trigger';
  END IF;
  IF (NEW.last_message_at IS DISTINCT FROM OLD.last_message_at AND OLD.last_message_at IS NOT NULL AND (NEW.last_message_at IS NULL OR NEW.last_message_at < OLD.last_message_at))
     OR (NEW.last_inbound_at IS DISTINCT FROM OLD.last_inbound_at AND OLD.last_inbound_at IS NOT NULL AND (NEW.last_inbound_at IS NULL OR NEW.last_inbound_at < OLD.last_inbound_at))
     OR (NEW.contact_delivered_at IS DISTINCT FROM OLD.contact_delivered_at AND OLD.contact_delivered_at IS NOT NULL AND (NEW.contact_delivered_at IS NULL OR NEW.contact_delivered_at < OLD.contact_delivered_at))
     OR (NEW.contact_read_at IS DISTINCT FROM OLD.contact_read_at AND OLD.contact_read_at IS NOT NULL AND (NEW.contact_read_at IS NULL OR NEW.contact_read_at < OLD.contact_read_at)) THEN
    RAISE EXCEPTION 'conversation timestamps and watermarks only move forward';
  END IF;
  -- agents assign only to themselves (matrix: conversation.assign "self"); admins and owners to any member (the foreign key proves membership)
  IF current_user = 'crm_app' AND NEW.assignee_user_id IS DISTINCT FROM OLD.assignee_user_id AND NOT (SELECT app_has_role(array['owner','admin'])) THEN
    IF NOT (coalesce(NEW.assignee_user_id = (SELECT app_user_id()), false) OR (NEW.assignee_user_id IS NULL AND coalesce(OLD.assignee_user_id = (SELECT app_user_id()), false))) THEN
      RAISE EXCEPTION 'agents can assign a conversation only to themselves';
    END IF;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER conversations_guard_trg BEFORE UPDATE ON conversations FOR EACH ROW EXECUTE FUNCTION conversations_guard();
--> statement-breakpoint
CREATE FUNCTION platform_identities_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id <> OLD.id OR NEW.workspace_id <> OLD.workspace_id OR NEW.integration_account_id <> OLD.integration_account_id OR NEW.external_user_id <> OLD.external_user_id THEN
    RAISE EXCEPTION 'a platform identity cannot change workspace, account or external id';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER platform_identities_guard_trg BEFORE UPDATE ON platform_identities FOR EACH ROW EXECUTE FUNCTION platform_identities_guard();
--> statement-breakpoint
CREATE FUNCTION conversation_reads_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE last_seq bigint;
BEGIN
  SELECT message_seq INTO last_seq FROM conversations c WHERE c.workspace_id = NEW.workspace_id AND c.id = NEW.conversation_id;
  IF last_seq IS NULL THEN RAISE EXCEPTION 'conversation not found'; END IF;
  IF NEW.last_read_seq > last_seq THEN RAISE EXCEPTION 'a read cursor cannot pass the last message'; END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW.conversation_id <> OLD.conversation_id OR NEW.user_id <> OLD.user_id OR NEW.workspace_id <> OLD.workspace_id THEN RAISE EXCEPTION 'a read marker cannot change owner or conversation'; END IF;
    NEW.last_read_seq := GREATEST(OLD.last_read_seq, NEW.last_read_seq); -- two tabs marking read concurrently can never move the cursor back
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER conversation_reads_guard_trg BEFORE INSERT OR UPDATE ON conversation_reads FOR EACH ROW EXECUTE FUNCTION conversation_reads_guard();
--> statement-breakpoint
CREATE FUNCTION conversation_unread_count(conv uuid) RETURNS bigint LANGUAGE sql STABLE AS $$
  SELECT count(*) FROM messages m
  WHERE m.workspace_id = (SELECT app_workspace_id()) AND m.conversation_id = conv AND m.direction = 'in'
    AND m.seq > coalesce((SELECT r.last_read_seq FROM conversation_reads r WHERE r.workspace_id = (SELECT app_workspace_id()) AND r.conversation_id = conv AND r.user_id = (SELECT app_user_id())), 0)
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION conversation_unread_count(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION conversation_unread_count(uuid) TO crm_app;
--> statement-breakpoint
CREATE FUNCTION webhook_events_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id <> OLD.id OR NEW.platform <> OLD.platform OR NEW.received_at <> OLD.received_at OR NEW.signature_valid <> OLD.signature_valid
     OR NEW.body_sha256 IS DISTINCT FROM OLD.body_sha256 OR NEW.body_size <> OLD.body_size OR NEW.account_ref IS DISTINCT FROM OLD.account_ref THEN
    RAISE EXCEPTION 'webhook event identity is immutable';
  END IF;
  IF NEW.raw_body IS DISTINCT FROM OLD.raw_body AND NOT (NEW.raw_body IS NULL AND NEW.body_purged_at IS NOT NULL) THEN
    RAISE EXCEPTION 'a raw body can only be purged, never rewritten';
  END IF;
  IF OLD.workspace_id IS NOT NULL AND NEW.workspace_id IS DISTINCT FROM OLD.workspace_id THEN
    RAISE EXCEPTION 'a routed webhook event cannot move to another workspace';
  END IF;
  -- routing is bound in the database: the workspace stamped on an event must be the workspace that owns the account the event names
  IF OLD.workspace_id IS NULL AND NEW.workspace_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM integration_accounts a WHERE a.platform = NEW.platform AND a.external_account_id = NEW.account_ref AND a.workspace_id = NEW.workspace_id) THEN
    RAISE EXCEPTION 'webhook event can only be routed to the workspace that owns its account';
  END IF;
  IF NEW.status <> OLD.status AND NOT ((OLD.status, NEW.status) IN (('received','processed'),('received','failed'),('received','orphan'),('failed','received'),('failed','processed'),('orphan','received'))) THEN
    RAISE EXCEPTION 'webhook event status change % -> % is not allowed', OLD.status, NEW.status;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER webhook_events_guard_trg BEFORE UPDATE ON webhook_events FOR EACH ROW EXECUTE FUNCTION webhook_events_guard();
--> statement-breakpoint
CREATE FUNCTION purge_webhook_event_bodies(retention interval DEFAULT interval '30 days') RETURNS integer LANGUAGE plpgsql AS $$
DECLARE n integer;
BEGIN
  IF retention > interval '30 days' THEN RAISE EXCEPTION 'raw webhook bodies are kept at most 30 days (decision D-E)'; END IF;
  UPDATE webhook_events SET raw_body = NULL, body_purged_at = now() WHERE raw_body IS NOT NULL AND received_at < now() - retention;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION purge_webhook_event_bodies(interval) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION purge_webhook_event_bodies(interval) TO crm_worker;

