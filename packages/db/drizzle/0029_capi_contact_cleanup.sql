-- CAPI contact cleanup. Deleting a contact (soft delete: contacts.deleted_at) must stop its queued events and strip hashed identifiers from what was already recorded.
-- New terminal status 'cancelled' (a pending event whose contact was deleted; never sent). The app role may now UPDATE status, payload, last_error and updated_at of an event
-- ONLY when its contact is already soft-deleted (RLS policy) and ONLY to cancel a pending row or to purge the payload to '{}' (guard). Nothing else about an event can change.
-- consent_records is untouched: it stays append-only and holds no PII (contact id, status, source, recorded_by); the contact row is soft-deleted, never removed, so the FK stays valid.
ALTER TABLE "capi_events" DROP CONSTRAINT "capi_events_status";--> statement-breakpoint
ALTER TABLE "capi_events" ADD CONSTRAINT "capi_events_status" CHECK ("status" IN ('pending','sent','failed','skipped_no_consent','cancelled'));--> statement-breakpoint
GRANT UPDATE (status, payload, last_error, updated_at) ON capi_events TO crm_app;--> statement-breakpoint
CREATE POLICY cape_erase_update ON capi_events FOR UPDATE TO crm_app
  USING (workspace_id = (SELECT app_workspace_id()) AND (SELECT app_has_role(array['owner','admin'])) AND contact_id IS NOT NULL
    AND EXISTS (SELECT 1 FROM contacts c WHERE c.workspace_id = capi_events.workspace_id AND c.id = capi_events.contact_id AND c.deleted_at IS NOT NULL))
  WITH CHECK (workspace_id = (SELECT app_workspace_id()) AND (SELECT app_has_role(array['owner','admin'])));--> statement-breakpoint
CREATE OR REPLACE FUNCTION capi_events_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id <> OLD.id OR NEW.workspace_id <> OLD.workspace_id OR NEW.dataset_id <> OLD.dataset_id OR NEW.contact_id IS DISTINCT FROM OLD.contact_id
     OR NEW.event_name <> OLD.event_name OR NEW.event_id <> OLD.event_id OR NEW.crm_event_ref <> OLD.crm_event_ref OR NEW.event_time <> OLD.event_time OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'a capi event cannot change its identity';
  END IF;
  IF OLD.status = 'pending' AND NEW.status = 'cancelled' THEN
    IF NEW.payload <> '{}'::jsonb OR NEW.attempts <> OLD.attempts OR NEW.sent_at IS NOT NULL THEN
      RAISE EXCEPTION 'a cancelled capi event must have its payload purged';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.status <> 'pending' THEN
    -- the only change to a final row: purge the payload (contact erasure); delivery metadata stays as it was
    IF NEW.payload = '{}'::jsonb AND NEW.status = OLD.status AND NEW.attempts = OLD.attempts AND NEW.next_attempt_at = OLD.next_attempt_at
       AND NEW.last_error IS NOT DISTINCT FROM OLD.last_error AND NEW.fbtrace_id IS NOT DISTINCT FROM OLD.fbtrace_id AND NEW.sent_at IS NOT DISTINCT FROM OLD.sent_at THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'a capi event that is % is final', OLD.status;
  END IF;
  IF current_user = 'crm_app' THEN
    RAISE EXCEPTION 'the app role can only cancel a pending capi event or purge its payload';
  END IF;
  IF NEW.payload IS DISTINCT FROM OLD.payload AND NOT ((NEW.payload - 'user_data') = (OLD.payload - 'user_data') AND NEW.payload -> 'user_data' = '{}'::jsonb) THEN
    RAISE EXCEPTION 'a capi event payload can only have its user_data blanked';
  END IF;
  IF NEW.attempts < OLD.attempts THEN
    RAISE EXCEPTION 'attempts only go up';
  END IF;
  RETURN NEW;
END $$;
