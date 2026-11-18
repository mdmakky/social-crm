-- "Ask if missing" for a CAPI rule. Additive only: one defaulted column, no data change, RLS unchanged. false = today's behaviour (skip and record when the value is missing).
-- The column is writable by the app role like the other rule fields (column-level UPDATE grant). Asking only makes sense when the value comes from the lead.
ALTER TABLE "capi_event_mappings" ADD COLUMN "ask_for_value" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "capi_event_mappings" ADD CONSTRAINT "capi_mappings_ask_value" CHECK (NOT "ask_for_value" OR "value_mode" = 'lead_value');--> statement-breakpoint
GRANT UPDATE ("ask_for_value") ON "capi_event_mappings" TO crm_app;
