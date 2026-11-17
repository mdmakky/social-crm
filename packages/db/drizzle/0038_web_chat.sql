-- Website chat widget (inbox channel "web_chat"). Visitors are anonymous: they hold a random session token (only its SHA-256 is stored) and never get a database session of their own.
-- The public API resolves a widget key to its workspace through the narrow SECURITY DEFINER function below (fixed search_path, execute only for crm_worker), then runs every read and write inside that workspace's RLS context as crm_worker.
CREATE TABLE "chat_widgets" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"integration_account_id" uuid NOT NULL,
	"public_key" text NOT NULL,
	"name" text NOT NULL,
	"allowed_origins" text[] DEFAULT '{}'::text[] NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"greeting" text,
	"offline_message" text,
	"color" text DEFAULT '#2563eb' NOT NULL,
	"prechat_form" boolean DEFAULT false NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chat_widgets_public_key" UNIQUE("public_key"),
	CONSTRAINT "chat_widgets_ws_id" UNIQUE("workspace_id","id"),
	CONSTRAINT "chat_widgets_key_shape" CHECK ("public_key" ~ '^[A-Za-z0-9_-]{22,64}$'),
	CONSTRAINT "chat_widgets_name" CHECK (char_length("name") BETWEEN 1 AND 80),
	CONSTRAINT "chat_widgets_origins" CHECK (cardinality("allowed_origins") <= 20),
	CONSTRAINT "chat_widgets_texts" CHECK (("greeting" IS NULL OR char_length("greeting") <= 300) AND ("offline_message" IS NULL OR char_length("offline_message") <= 300)),
	CONSTRAINT "chat_widgets_color" CHECK ("color" ~ '^#[0-9a-fA-F]{6}$')
);--> statement-breakpoint
CREATE TABLE "chat_visitor_sessions" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"widget_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"visitor_ref" text NOT NULL,
	"contact_id" uuid,
	"conversation_id" uuid,
	"ip_hash" text,
	"user_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone DEFAULT now() + interval '30 days' NOT NULL,
	CONSTRAINT "chat_visitor_sessions_token_hash" UNIQUE("token_hash"),
	CONSTRAINT "chat_visitor_sessions_hash_shape" CHECK ("token_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "chat_visitor_sessions_ref" CHECK ("visitor_ref" ~ '^[1-9][0-9]{0,99}$'),
	CONSTRAINT "chat_visitor_sessions_pair" CHECK (("contact_id" IS NULL) = ("conversation_id" IS NULL)),
	CONSTRAINT "chat_visitor_sessions_ua" CHECK ("user_agent" IS NULL OR char_length("user_agent") <= 200)
);--> statement-breakpoint
ALTER TABLE "chat_widgets" ADD CONSTRAINT "chat_widgets_workspace_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_widgets" ADD CONSTRAINT "chat_widgets_account_fk" FOREIGN KEY ("workspace_id","integration_account_id") REFERENCES "public"."integration_accounts"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_widgets" ADD CONSTRAINT "chat_widgets_created_by_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_visitor_sessions" ADD CONSTRAINT "chat_visitor_sessions_workspace_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_visitor_sessions" ADD CONSTRAINT "chat_visitor_sessions_widget_fk" FOREIGN KEY ("workspace_id","widget_id") REFERENCES "public"."chat_widgets"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_visitor_sessions" ADD CONSTRAINT "chat_visitor_sessions_conversation_fk" FOREIGN KEY ("workspace_id","conversation_id") REFERENCES "public"."conversations"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_visitor_sessions" ADD CONSTRAINT "chat_visitor_sessions_contact_fk" FOREIGN KEY ("workspace_id","contact_id") REFERENCES "public"."contacts"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "chat_widgets_list_idx" ON "chat_widgets" USING btree ("workspace_id","created_at" DESC,"id" DESC);--> statement-breakpoint
CREATE UNIQUE INDEX "chat_visitor_sessions_ref_uq" ON "chat_visitor_sessions" USING btree ("widget_id","visitor_ref");--> statement-breakpoint
CREATE INDEX "chat_visitor_sessions_expiry_idx" ON "chat_visitor_sessions" USING btree ("expires_at");--> statement-breakpoint
ALTER TABLE chat_widgets ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE chat_widgets FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE chat_visitor_sessions ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE chat_visitor_sessions FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON chat_widgets, chat_visitor_sessions FROM crm_app, crm_worker, crm_ingest;--> statement-breakpoint
-- Owner/admin manage widgets. No DELETE: a widget is disabled, not removed (its conversations stay).
GRANT SELECT, INSERT ON chat_widgets TO crm_app;--> statement-breakpoint
GRANT UPDATE (name, allowed_origins, enabled, greeting, offline_message, color, prechat_form, public_key, updated_at) ON chat_widgets TO crm_app;--> statement-breakpoint
CREATE POLICY cw_select ON chat_widgets FOR SELECT TO crm_app USING (workspace_id = (SELECT app_workspace_id()) AND (SELECT app_has_role(array['owner','admin'])));--> statement-breakpoint
CREATE POLICY cw_insert ON chat_widgets FOR INSERT TO crm_app WITH CHECK (workspace_id = (SELECT app_workspace_id()) AND created_by = (SELECT app_user_id()) AND (SELECT app_has_role(array['owner','admin'])));--> statement-breakpoint
CREATE POLICY cw_update ON chat_widgets FOR UPDATE TO crm_app USING (workspace_id = (SELECT app_workspace_id()) AND (SELECT app_has_role(array['owner','admin']))) WITH CHECK (workspace_id = (SELECT app_workspace_id()));--> statement-breakpoint
-- The public API acts as crm_worker inside a workspace context it derived itself (never from the caller).
GRANT SELECT ON chat_widgets TO crm_worker;--> statement-breakpoint
CREATE POLICY cw_worker_select ON chat_widgets FOR SELECT TO crm_worker USING (workspace_id = (SELECT app_workspace_id()));--> statement-breakpoint
GRANT SELECT, INSERT ON chat_visitor_sessions TO crm_worker;--> statement-breakpoint
GRANT UPDATE (last_seen_at, expires_at, contact_id, conversation_id) ON chat_visitor_sessions TO crm_worker;--> statement-breakpoint
CREATE POLICY cvs_worker_select ON chat_visitor_sessions FOR SELECT TO crm_worker USING (workspace_id = (SELECT app_workspace_id()));--> statement-breakpoint
CREATE POLICY cvs_worker_insert ON chat_visitor_sessions FOR INSERT TO crm_worker WITH CHECK (workspace_id = (SELECT app_workspace_id()));--> statement-breakpoint
CREATE POLICY cvs_worker_update ON chat_visitor_sessions FOR UPDATE TO crm_worker USING (workspace_id = (SELECT app_workspace_id())) WITH CHECK (workspace_id = (SELECT app_workspace_id()));--> statement-breakpoint
-- Key -> workspace. The one cross-tenant lookup of this feature: it takes only the public key, returns only the widget's own public configuration, and is runnable by crm_worker alone.
CREATE POLICY cw_def_select ON chat_widgets FOR SELECT TO crm_migrator USING (true);--> statement-breakpoint
CREATE FUNCTION chat_widget_resolve(p_key text) RETURNS TABLE (id uuid, workspace_id uuid, integration_account_id uuid, enabled boolean, allowed_origins text[], name text, greeting text, offline_message text, color text, prechat_form boolean) LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT w.id, w.workspace_id, w.integration_account_id, w.enabled, w.allowed_origins, w.name, w.greeting, w.offline_message, w.color, w.prechat_form FROM chat_widgets w WHERE w.public_key = p_key
$$;--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION chat_widget_resolve(text) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION chat_widget_resolve(text) TO crm_worker;
