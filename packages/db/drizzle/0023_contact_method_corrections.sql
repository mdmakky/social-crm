-- Humans may correct or delete a method that was DETECTED from a conversation (never an entered or verified one). The policies restrict rows to unverified messenger/instagram methods
-- and to roles that may edit contacts; the column grants keep kind, source, contact, verification and confidence out of reach.
ALTER TABLE "contact_methods" ADD COLUMN "corrected_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "contact_methods" ADD COLUMN "corrected_by" text;--> statement-breakpoint
GRANT UPDATE (value, raw_value, corrected_at, corrected_by, updated_at) ON contact_methods TO crm_app;--> statement-breakpoint
GRANT DELETE ON contact_methods TO crm_app;--> statement-breakpoint
CREATE POLICY cm_app_update ON contact_methods FOR UPDATE TO crm_app USING (workspace_id = (SELECT app_workspace_id()) AND (SELECT app_has_role(array['owner','admin','agent'])) AND verified = false AND source IN ('messenger','instagram')) WITH CHECK (workspace_id = (SELECT app_workspace_id()) AND (SELECT app_has_role(array['owner','admin','agent'])) AND verified = false AND source IN ('messenger','instagram'));--> statement-breakpoint
CREATE POLICY cm_app_delete ON contact_methods FOR DELETE TO crm_app USING (workspace_id = (SELECT app_workspace_id()) AND (SELECT app_has_role(array['owner','admin','agent'])) AND verified = false AND source IN ('messenger','instagram'));
