-- AI foundation (Phase 6 slice 1, mock first): provider configs with a sealed API key, versioned prompts, an append-only run log, and a monthly budget.
-- Roles: crm_app (the API: owner/admin configure; writes the sealed key but can never read it back) and crm_worker (runAi: reads config, key, prompt and budget, appends runs).
-- The run log holds sizes, token counts, cost and a fingerprint of the input; NEVER prompt or reply text. The app role cannot write runs, so usage cannot be forged from a request.
-- Policies use scalar subqueries (D45). Provider ids are not CHECKed against a list: adding a provider is one adapter plus one registry line, not a migration; the API validates against the registry.
CREATE TABLE "ai_provider_configs" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"base_url" text,
	"default_model" text,
	"enabled" boolean DEFAULT true NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"key_last4" text,
	"model_prices" jsonb DEFAULT '{}' NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_provider_configs_ws_id" UNIQUE("workspace_id","id"),
	CONSTRAINT "ai_provider_configs_ws_provider" UNIQUE("workspace_id","provider"),
	CONSTRAINT "ai_provider_configs_provider" CHECK ("provider" ~ '^[a-z][a-z0-9_]{1,30}$'),
	CONSTRAINT "ai_provider_configs_base_url" CHECK ("base_url" IS NULL OR ("base_url" ~ '^https://[^\s]+$' AND char_length("base_url") <= 320)),
	CONSTRAINT "ai_provider_configs_model" CHECK ("default_model" IS NULL OR char_length("default_model") BETWEEN 1 AND 100),
	CONSTRAINT "ai_provider_configs_last4" CHECK ("key_last4" IS NULL OR char_length("key_last4") = 4),
	CONSTRAINT "ai_provider_configs_prices" CHECK (jsonb_typeof("model_prices") = 'object' AND octet_length("model_prices"::text) <= 4000),
	CONSTRAINT "ai_provider_configs_default_enabled" CHECK (NOT "is_default" OR "enabled")
);--> statement-breakpoint
ALTER TABLE "ai_provider_configs" ADD CONSTRAINT "ai_provider_configs_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_provider_configs" ADD CONSTRAINT "ai_provider_configs_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ai_provider_configs_one_default" ON "ai_provider_configs" USING btree ("workspace_id") WHERE "is_default";--> statement-breakpoint
-- Sealed key (same envelope as capi_dataset_secrets; config id is the AAD). Append-only: rotating a key inserts a new row, the worker uses the newest.
CREATE TABLE "ai_provider_secrets" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"config_id" uuid NOT NULL,
	"ciphertext" "bytea" NOT NULL,
	"nonce" "bytea" NOT NULL,
	"key_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_provider_secrets_nonce_len" CHECK (octet_length("nonce") = 12),
	CONSTRAINT "ai_provider_secrets_key_id" CHECK (char_length("key_id") BETWEEN 1 AND 64),
	CONSTRAINT "ai_provider_secrets_ciphertext_len" CHECK (octet_length("ciphertext") BETWEEN 17 AND 4096)
);--> statement-breakpoint
ALTER TABLE "ai_provider_secrets" ADD CONSTRAINT "ai_provider_secrets_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_provider_secrets" ADD CONSTRAINT "ai_provider_secrets_config_fk" FOREIGN KEY ("workspace_id","config_id") REFERENCES "public"."ai_provider_configs"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ai_provider_secrets_latest_idx" ON "ai_provider_secrets" USING btree ("workspace_id","config_id","id" DESC);--> statement-breakpoint
-- Versioned prompt templates. Append-style: a new version is a new row; only `active` can change (publish a version, or roll back to an older one). One active version per (workspace, key).
CREATE TABLE "ai_prompts" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"key" text NOT NULL,
	"version" integer NOT NULL,
	"template" text NOT NULL,
	"active" boolean DEFAULT false NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_prompts_version_uq" UNIQUE("workspace_id","key","version"),
	CONSTRAINT "ai_prompts_key" CHECK ("key" ~ '^[a-z][a-z0-9_]{1,40}$'),
	CONSTRAINT "ai_prompts_version" CHECK ("version" >= 1),
	CONSTRAINT "ai_prompts_template" CHECK (char_length("template") BETWEEN 1 AND 4000)
);--> statement-breakpoint
ALTER TABLE "ai_prompts" ADD CONSTRAINT "ai_prompts_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_prompts" ADD CONSTRAINT "ai_prompts_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ai_prompts_one_active" ON "ai_prompts" USING btree ("workspace_id","key") WHERE "active";--> statement-breakpoint
-- One row per AI call attempt, including calls blocked by the budget (the provider is not contacted for those). No prompt or reply text: `summary` is sizes only, `input_hash` a 16 hex fingerprint.
CREATE TABLE "ai_runs" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"capability" text NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"prompt_key" text NOT NULL,
	"prompt_version" integer NOT NULL,
	"status" text NOT NULL,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"cost_micro" bigint DEFAULT 0 NOT NULL,
	"latency_ms" integer DEFAULT 0 NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"error_code" text,
	"requested_by" text,
	"entity_type" text,
	"entity_id" uuid,
	"input_hash" text,
	"summary" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_runs_capability" CHECK ("capability" ~ '^[a-z][a-z0-9_]{1,40}$'),
	CONSTRAINT "ai_runs_provider" CHECK ("provider" ~ '^[a-z][a-z0-9_]{1,30}$'),
	CONSTRAINT "ai_runs_model" CHECK (char_length("model") BETWEEN 1 AND 100),
	CONSTRAINT "ai_runs_prompt_key" CHECK ("prompt_key" ~ '^[a-z][a-z0-9_]{1,40}$'),
	CONSTRAINT "ai_runs_prompt_version" CHECK ("prompt_version" >= 0),
	CONSTRAINT "ai_runs_status" CHECK ("status" IN ('ok','error','blocked_budget')),
	CONSTRAINT "ai_runs_numbers" CHECK ("input_tokens" >= 0 AND "output_tokens" >= 0 AND "cost_micro" >= 0 AND "latency_ms" >= 0 AND "attempts" >= 0),
	CONSTRAINT "ai_runs_error_code" CHECK (("status" = 'ok') = ("error_code" IS NULL) AND ("error_code" IS NULL OR "error_code" ~ '^[a-z0-9_:]{1,60}$')),
	CONSTRAINT "ai_runs_blocked_free" CHECK ("status" <> 'blocked_budget' OR ("input_tokens" = 0 AND "output_tokens" = 0 AND "cost_micro" = 0 AND "attempts" = 0)),
	CONSTRAINT "ai_runs_entity" CHECK (("entity_type" IS NULL) = ("entity_id" IS NULL)),
	CONSTRAINT "ai_runs_entity_type" CHECK ("entity_type" IS NULL OR "entity_type" ~ '^[a-z][a-z0-9_]{1,30}$'),
	CONSTRAINT "ai_runs_hash" CHECK ("input_hash" IS NULL OR "input_hash" ~ '^[0-9a-f]{16}$'),
	CONSTRAINT "ai_runs_summary" CHECK ("summary" IS NULL OR char_length("summary") <= 200)
);--> statement-breakpoint
ALTER TABLE "ai_runs" ADD CONSTRAINT "ai_runs_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_runs" ADD CONSTRAINT "ai_runs_requested_by_user_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ai_runs_ws_time_idx" ON "ai_runs" USING btree ("workspace_id","created_at");--> statement-breakpoint
-- Monthly cap in micro-units (1 000 000 = 1 currency unit; no floats for money). NULL cap = no cap. Month usage is computed from ai_runs (UTC calendar month), never stored.
CREATE TABLE "ai_budgets" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"monthly_cap_micro" bigint,
	"hard_stop" boolean DEFAULT true NOT NULL,
	"updated_by" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_budgets_workspace" UNIQUE("workspace_id"),
	CONSTRAINT "ai_budgets_cap" CHECK ("monthly_cap_micro" IS NULL OR "monthly_cap_micro" BETWEEN 0 AND 1000000000000000)
);--> statement-breakpoint
ALTER TABLE "ai_budgets" ADD CONSTRAINT "ai_budgets_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_budgets" ADD CONSTRAINT "ai_budgets_updated_by_user_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE ai_provider_configs ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ai_provider_configs FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ai_provider_secrets ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ai_provider_secrets FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ai_prompts ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ai_prompts FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ai_runs ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ai_runs FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ai_budgets ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ai_budgets FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON ai_provider_configs, ai_provider_secrets, ai_prompts, ai_runs, ai_budgets FROM crm_app, crm_worker;--> statement-breakpoint
-- API: configure (never DELETE), insert the sealed key but never read it back, publish prompts, read runs (cannot write them), set the budget.
GRANT SELECT, INSERT ON ai_provider_configs TO crm_app;--> statement-breakpoint
GRANT UPDATE (base_url, default_model, enabled, is_default, key_last4, model_prices, updated_at) ON ai_provider_configs TO crm_app;--> statement-breakpoint
GRANT INSERT ON ai_provider_secrets TO crm_app;--> statement-breakpoint
GRANT SELECT, INSERT ON ai_prompts TO crm_app;--> statement-breakpoint
GRANT UPDATE (active) ON ai_prompts TO crm_app;--> statement-breakpoint
GRANT SELECT ON ai_runs TO crm_app;--> statement-breakpoint
GRANT SELECT, INSERT ON ai_budgets TO crm_app;--> statement-breakpoint
GRANT UPDATE (monthly_cap_micro, hard_stop, updated_by, updated_at) ON ai_budgets TO crm_app;--> statement-breakpoint
-- Worker (runAi): reads config, the sealed key, prompts and the budget; appends runs. It cannot change anything else.
GRANT SELECT ON ai_provider_configs, ai_provider_secrets, ai_prompts, ai_budgets TO crm_worker;--> statement-breakpoint
GRANT SELECT, INSERT ON ai_runs TO crm_worker;--> statement-breakpoint
-- Configs are readable by every role that may use AI (the composer asks whether a provider is ready); they hold no secret. Everything else is owner/admin.
CREATE POLICY aipc_select ON ai_provider_configs FOR SELECT TO crm_app USING (workspace_id = (SELECT app_workspace_id()) AND (SELECT app_has_role(array['owner','admin','agent'])));--> statement-breakpoint
CREATE POLICY aipc_insert ON ai_provider_configs FOR INSERT TO crm_app WITH CHECK (workspace_id = (SELECT app_workspace_id()) AND (SELECT app_has_role(array['owner','admin'])));--> statement-breakpoint
CREATE POLICY aipc_update ON ai_provider_configs FOR UPDATE TO crm_app USING (workspace_id = (SELECT app_workspace_id()) AND (SELECT app_has_role(array['owner','admin']))) WITH CHECK (workspace_id = (SELECT app_workspace_id()) AND (SELECT app_has_role(array['owner','admin'])));--> statement-breakpoint
CREATE POLICY aipc_worker_select ON ai_provider_configs FOR SELECT TO crm_worker USING (workspace_id = (SELECT app_workspace_id()));--> statement-breakpoint
CREATE POLICY aips_insert ON ai_provider_secrets FOR INSERT TO crm_app WITH CHECK (workspace_id = (SELECT app_workspace_id()) AND (SELECT app_has_role(array['owner','admin'])));--> statement-breakpoint
CREATE POLICY aips_worker_select ON ai_provider_secrets FOR SELECT TO crm_worker USING (workspace_id = (SELECT app_workspace_id()));--> statement-breakpoint
CREATE POLICY aipr_select ON ai_prompts FOR SELECT TO crm_app USING (workspace_id = (SELECT app_workspace_id()) AND (SELECT app_has_role(array['owner','admin'])));--> statement-breakpoint
CREATE POLICY aipr_insert ON ai_prompts FOR INSERT TO crm_app WITH CHECK (workspace_id = (SELECT app_workspace_id()) AND (SELECT app_has_role(array['owner','admin'])) AND created_by = (SELECT app_user_id()));--> statement-breakpoint
CREATE POLICY aipr_update ON ai_prompts FOR UPDATE TO crm_app USING (workspace_id = (SELECT app_workspace_id()) AND (SELECT app_has_role(array['owner','admin']))) WITH CHECK (workspace_id = (SELECT app_workspace_id()) AND (SELECT app_has_role(array['owner','admin'])));--> statement-breakpoint
CREATE POLICY aipr_worker_select ON ai_prompts FOR SELECT TO crm_worker USING (workspace_id = (SELECT app_workspace_id()));--> statement-breakpoint
CREATE POLICY airun_select ON ai_runs FOR SELECT TO crm_app USING (workspace_id = (SELECT app_workspace_id()) AND (SELECT app_has_role(array['owner','admin'])));--> statement-breakpoint
CREATE POLICY airun_worker_select ON ai_runs FOR SELECT TO crm_worker USING (workspace_id = (SELECT app_workspace_id()));--> statement-breakpoint
CREATE POLICY airun_worker_insert ON ai_runs FOR INSERT TO crm_worker WITH CHECK (workspace_id = (SELECT app_workspace_id()));--> statement-breakpoint
CREATE POLICY aibud_select ON ai_budgets FOR SELECT TO crm_app USING (workspace_id = (SELECT app_workspace_id()) AND (SELECT app_has_role(array['owner','admin'])));--> statement-breakpoint
CREATE POLICY aibud_insert ON ai_budgets FOR INSERT TO crm_app WITH CHECK (workspace_id = (SELECT app_workspace_id()) AND (SELECT app_has_role(array['owner','admin'])));--> statement-breakpoint
CREATE POLICY aibud_update ON ai_budgets FOR UPDATE TO crm_app USING (workspace_id = (SELECT app_workspace_id()) AND (SELECT app_has_role(array['owner','admin']))) WITH CHECK (workspace_id = (SELECT app_workspace_id()) AND (SELECT app_has_role(array['owner','admin'])));--> statement-breakpoint
CREATE POLICY aibud_worker_select ON ai_budgets FOR SELECT TO crm_worker USING (workspace_id = (SELECT app_workspace_id()));--> statement-breakpoint
-- Config identity never changes (the sealed key is bound to the config id as AAD).
CREATE FUNCTION ai_provider_configs_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id <> OLD.id OR NEW.workspace_id <> OLD.workspace_id OR NEW.provider <> OLD.provider OR NEW.created_by IS DISTINCT FROM OLD.created_by OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'an ai provider config cannot change its identity';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER ai_provider_configs_guard_trg BEFORE UPDATE ON ai_provider_configs FOR EACH ROW EXECUTE FUNCTION ai_provider_configs_guard();--> statement-breakpoint
-- A prompt version's text is final; publishing or rolling back only flips `active`.
CREATE FUNCTION ai_prompts_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id <> OLD.id OR NEW.workspace_id <> OLD.workspace_id OR NEW.key <> OLD.key OR NEW.version <> OLD.version OR NEW.template <> OLD.template OR NEW.created_by IS DISTINCT FROM OLD.created_by OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'an ai prompt version is immutable except for active';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER ai_prompts_guard_trg BEFORE UPDATE ON ai_prompts FOR EACH ROW EXECUTE FUNCTION ai_prompts_guard();--> statement-breakpoint
CREATE FUNCTION ai_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME;
END $$;--> statement-breakpoint
CREATE TRIGGER ai_provider_secrets_append_only BEFORE UPDATE OR DELETE ON ai_provider_secrets FOR EACH ROW EXECUTE FUNCTION ai_append_only();--> statement-breakpoint
CREATE TRIGGER ai_runs_append_only BEFORE UPDATE OR DELETE ON ai_runs FOR EACH ROW EXECUTE FUNCTION ai_append_only();
