-- Web chat widget appearance (v2) and the visitor's last page. Additive only: new nullable or defaulted columns, same RLS, no data migration.
-- title = name and greeting headline = greeting (existing columns). subtitle is a plain configurable line, never a time promise.
ALTER TABLE "chat_widgets" ADD COLUMN "avatar_url" text;--> statement-breakpoint
ALTER TABLE "chat_widgets" ADD COLUMN "subtitle" text DEFAULT 'We reply here' NOT NULL;--> statement-breakpoint
ALTER TABLE "chat_widgets" ADD COLUMN "position" text DEFAULT 'right' NOT NULL;--> statement-breakpoint
ALTER TABLE "chat_widgets" ADD COLUMN "quick_replies" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "chat_widgets" ADD COLUMN "away_mode" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "chat_widgets" ADD COLUMN "away_text" text;--> statement-breakpoint
ALTER TABLE "chat_widgets" ADD COLUMN "default_language" text DEFAULT 'en' NOT NULL;--> statement-breakpoint
ALTER TABLE "chat_widgets" ADD CONSTRAINT "chat_widgets_avatar" CHECK ("avatar_url" IS NULL OR ("avatar_url" ~ '^https://[^[:space:]]+$' AND char_length("avatar_url") <= 500));--> statement-breakpoint
ALTER TABLE "chat_widgets" ADD CONSTRAINT "chat_widgets_subtitle" CHECK (char_length("subtitle") <= 60);--> statement-breakpoint
ALTER TABLE "chat_widgets" ADD CONSTRAINT "chat_widgets_position" CHECK ("position" IN ('left','right'));--> statement-breakpoint
CREATE FUNCTION chat_quick_replies_ok(q text[]) RETURNS boolean LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$ SELECT coalesce(cardinality(q), 0) <= 3 AND NOT EXISTS (SELECT 1 FROM unnest(q) e WHERE e IS NULL OR char_length(e) NOT BETWEEN 1 AND 30) $$;--> statement-breakpoint
ALTER TABLE "chat_widgets" ADD CONSTRAINT "chat_widgets_quick" CHECK (chat_quick_replies_ok("quick_replies"));--> statement-breakpoint
ALTER TABLE "chat_widgets" ADD CONSTRAINT "chat_widgets_away" CHECK ("away_text" IS NULL OR char_length("away_text") <= 160);--> statement-breakpoint
ALTER TABLE "chat_widgets" ADD CONSTRAINT "chat_widgets_lang" CHECK ("default_language" IN ('en','bn'));--> statement-breakpoint
ALTER TABLE "chat_visitor_sessions" ADD COLUMN "last_page_url" text;--> statement-breakpoint
ALTER TABLE "chat_visitor_sessions" ADD CONSTRAINT "chat_visitor_sessions_page" CHECK ("last_page_url" IS NULL OR ("last_page_url" ~ '^https?://[^[:space:]]+$' AND char_length("last_page_url") <= 300));--> statement-breakpoint
GRANT UPDATE (avatar_url, subtitle, position, quick_replies, away_mode, away_text, default_language) ON chat_widgets TO crm_app;--> statement-breakpoint
GRANT UPDATE (last_page_url) ON chat_visitor_sessions TO crm_worker;--> statement-breakpoint
DROP FUNCTION chat_widget_resolve(text);--> statement-breakpoint
CREATE FUNCTION chat_widget_resolve(p_key text) RETURNS TABLE (id uuid, workspace_id uuid, integration_account_id uuid, enabled boolean, allowed_origins text[], name text, greeting text, offline_message text, color text, prechat_form boolean, avatar_url text, subtitle text, "position" text, quick_replies text[], away_mode boolean, away_text text, default_language text) LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT w.id, w.workspace_id, w.integration_account_id, w.enabled, w.allowed_origins, w.name, w.greeting, w.offline_message, w.color, w.prechat_form, w.avatar_url, w.subtitle, w."position", w.quick_replies, w.away_mode, w.away_text, w.default_language FROM chat_widgets w WHERE w.public_key = p_key
$$;--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION chat_widget_resolve(text) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION chat_widget_resolve(text) TO crm_worker;
--> statement-breakpoint
-- The Inbox (application role) shows "From page" for a web chat conversation. The role has no grant on chat_visitor_sessions (token hashes), so it gets this one narrow lookup: its own workspace only, any member role, returns the page text and nothing else.
CREATE POLICY cvs_def_select ON chat_visitor_sessions FOR SELECT TO crm_migrator USING (true);--> statement-breakpoint
CREATE FUNCTION chat_conversation_page(p_conversation uuid) RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT s.last_page_url FROM chat_visitor_sessions s WHERE s.workspace_id = app_workspace_id() AND s.conversation_id = p_conversation AND app_has_role(array['owner','admin','agent','viewer']) LIMIT 1
$$;--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION chat_conversation_page(uuid) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION chat_conversation_page(uuid) TO crm_app;
