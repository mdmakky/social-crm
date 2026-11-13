-- Meta Inbox slice 1: roles, forced RLS, column-level grants, state-graph and immutability triggers, raw body purge.
-- Policies use scalar subqueries (D45). Roles: crm_app (the API), crm_ingest (webhook ingress, INSERT only), crm_worker (background processing).
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
REVOKE DELETE, TRUNCATE ON integration_accounts FROM crm_app;
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
GRANT INSERT ON messages TO crm_app;
--> statement-breakpoint
GRANT UPDATE (delivery_state, failure_code, client_msg_id) ON messages TO crm_app;
--> statement-breakpoint
REVOKE DELETE, TRUNCATE ON conversation_reads FROM crm_app;
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
GRANT SELECT (id, workspace_id, platform, external_account_id, status) ON integration_accounts TO crm_ingest;
--> statement-breakpoint
GRANT SELECT, UPDATE (status, token_expires_at, last_token_check_at, version, updated_at) ON integration_accounts TO crm_worker;
--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON integration_secrets TO crm_worker;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE (profile_name, profile_fetched_at, contact_id) ON platform_identities TO crm_worker;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE (status, assignee_user_id, lead_id, contact_id, last_message_at, last_inbound_at, unread_count, version, updated_at) ON conversations TO crm_worker;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE (external_id, delivery_state, failure_code, sent_at, client_msg_id) ON messages TO crm_worker;
--> statement-breakpoint
GRANT SELECT ON webhook_events TO crm_worker;
--> statement-breakpoint
GRANT UPDATE (workspace_id, status, attempts, last_error, processed_at, raw_body, body_purged_at) ON webhook_events TO crm_worker;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE (finished_at, http_status, platform_error_code, outcome) ON outbound_attempts TO crm_worker;
--> statement-breakpoint
GRANT SELECT, INSERT ON integration_events TO crm_worker;
--> statement-breakpoint
CREATE POLICY ia_select ON integration_accounts FOR SELECT TO crm_app USING (workspace_id = (SELECT app_workspace_id()) AND (SELECT app_has_role(array['owner','admin','agent','viewer'])));
--> statement-breakpoint
CREATE POLICY ia_insert ON integration_accounts FOR INSERT TO crm_app WITH CHECK (workspace_id = (SELECT app_workspace_id()) AND (SELECT app_has_role(array['owner','admin'])));
--> statement-breakpoint
CREATE POLICY ia_update ON integration_accounts FOR UPDATE TO crm_app USING (workspace_id = (SELECT app_workspace_id()) AND (SELECT app_has_role(array['owner','admin']))) WITH CHECK (workspace_id = (SELECT app_workspace_id()) AND (SELECT app_has_role(array['owner','admin'])));
--> statement-breakpoint
CREATE POLICY ia_ingest_select ON integration_accounts FOR SELECT TO crm_ingest USING (true);
--> statement-breakpoint
CREATE POLICY ia_worker_select ON integration_accounts FOR SELECT TO crm_worker USING (workspace_id = (SELECT app_workspace_id()));
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
CREATE FUNCTION messages_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE ok boolean;
BEGIN
  IF NEW.id <> OLD.id OR NEW.workspace_id <> OLD.workspace_id OR NEW.conversation_id <> OLD.conversation_id OR NEW.integration_account_id <> OLD.integration_account_id
     OR NEW.direction <> OLD.direction OR NEW.sender_kind <> OLD.sender_kind OR NEW.sender_user_id IS DISTINCT FROM OLD.sender_user_id
     OR NEW.body IS DISTINCT FROM OLD.body OR NEW.attachments <> OLD.attachments OR NEW.occurred_at <> OLD.occurred_at OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'message content is immutable';
  END IF;
  IF NEW.external_id IS DISTINCT FROM OLD.external_id AND OLD.external_id IS NOT NULL THEN
    RAISE EXCEPTION 'message external id is immutable once set';
  END IF;
  IF NEW.client_msg_id IS DISTINCT FROM OLD.client_msg_id AND NOT (OLD.delivery_state = 'failed' AND NEW.delivery_state = 'pending') THEN
    RAISE EXCEPTION 'client message id changes only when a failed message is retried';
  END IF;
  IF NEW.delivery_state <> OLD.delivery_state THEN
    -- full graph; each role may use only its part. pending->failed: refused before any request (token or window); the unknown state is never left automatically.
    IF current_user = 'crm_app' THEN
      ok := (OLD.delivery_state, NEW.delivery_state) IN (('unknown','sent'),('unknown','failed'),('failed','pending'));
    ELSIF current_user = 'crm_worker' THEN
      ok := (OLD.delivery_state, NEW.delivery_state) IN (('pending','sending'),('pending','failed'),('sending','sent'),('sending','failed'),('sending','unknown'),('unknown','sent'),('unknown','failed'));
    ELSE
      ok := (OLD.delivery_state, NEW.delivery_state) IN (('pending','sending'),('pending','failed'),('sending','sent'),('sending','failed'),('sending','unknown'),('unknown','sent'),('unknown','failed'),('failed','pending'));
    END IF;
    IF NOT ok THEN
      RAISE EXCEPTION 'delivery state change % -> % is not allowed for role %', OLD.delivery_state, NEW.delivery_state, current_user;
    END IF;
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

