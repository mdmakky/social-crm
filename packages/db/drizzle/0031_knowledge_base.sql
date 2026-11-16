-- AI Studio knowledge base, slice 1: sources a workspace teaches the assistant (pasted text, files, one web page) and their searchable chunks.
-- Retrieval is Postgres full-text search with the 'simple' configuration: no stemming and no stop words, so it works for any language that separates words with spaces
-- (Bangla, Arabic, English...). Chinese, Japanese and Thai runs without spaces index as one token (documented limit). No pgvector or external service in this slice.
-- Ingestion is synchronous inside the API request, so only crm_app has access; a worker role gets grants when ingestion becomes asynchronous.
-- Sources are soft-deleted (deleted_at, final); their chunks are physically deleted so deleted content cannot be searched or recovered.
CREATE TABLE "knowledge_sources" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"type" text NOT NULL,
	"title" text NOT NULL,
	"source_ref" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"error" text,
	"body" text,
	"char_count" integer DEFAULT 0 NOT NULL,
	"chunk_count" integer DEFAULT 0 NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "knowledge_sources_ws_id" UNIQUE("workspace_id","id"),
	CONSTRAINT "knowledge_sources_type" CHECK ("type" IN ('text','url','file')),
	CONSTRAINT "knowledge_sources_title" CHECK (char_length("title") BETWEEN 1 AND 200),
	CONSTRAINT "knowledge_sources_ref" CHECK ("source_ref" IS NULL OR char_length("source_ref") BETWEEN 1 AND 2048),
	CONSTRAINT "knowledge_sources_status" CHECK ("status" IN ('pending','ready','failed')),
	CONSTRAINT "knowledge_sources_error" CHECK ("error" IS NULL OR "error" ~ '^[a-z0-9_:]{1,80}$'),
	CONSTRAINT "knowledge_sources_counts" CHECK ("char_count" >= 0 AND "chunk_count" >= 0)
);--> statement-breakpoint
ALTER TABLE "knowledge_sources" ADD CONSTRAINT "knowledge_sources_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_sources" ADD CONSTRAINT "knowledge_sources_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "knowledge_sources_list_idx" ON "knowledge_sources" USING btree ("workspace_id","id" DESC) WHERE "deleted_at" IS NULL;--> statement-breakpoint
CREATE TABLE "knowledge_chunks" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"source_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"content" text NOT NULL,
	"tsv" tsvector GENERATED ALWAYS AS (to_tsvector('simple', "content")) STORED NOT NULL,
	"token_estimate" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "knowledge_chunks_source_position" UNIQUE("workspace_id","source_id","position"),
	CONSTRAINT "knowledge_chunks_position" CHECK ("position" >= 0),
	CONSTRAINT "knowledge_chunks_content" CHECK (char_length("content") BETWEEN 1 AND 2000),
	CONSTRAINT "knowledge_chunks_tokens" CHECK ("token_estimate" >= 0)
);--> statement-breakpoint
ALTER TABLE "knowledge_chunks" ADD CONSTRAINT "knowledge_chunks_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_chunks" ADD CONSTRAINT "knowledge_chunks_source_fk" FOREIGN KEY ("workspace_id","source_id") REFERENCES "public"."knowledge_sources"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "knowledge_chunks_tsv_idx" ON "knowledge_chunks" USING gin ("tsv");--> statement-breakpoint
ALTER TABLE knowledge_sources ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE knowledge_sources FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE knowledge_chunks ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE knowledge_chunks FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON knowledge_sources, knowledge_chunks FROM crm_app, crm_worker;--> statement-breakpoint
-- Every member reads (viewers included, they may test retrieval); owner and admin write. Chunks are immutable: a re-index deletes and inserts. Sources are never DELETEd.
GRANT SELECT, INSERT ON knowledge_sources TO crm_app;--> statement-breakpoint
GRANT UPDATE (title, status, error, body, char_count, chunk_count, updated_at, deleted_at) ON knowledge_sources TO crm_app;--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON knowledge_chunks TO crm_app;--> statement-breakpoint
CREATE POLICY ks_select ON knowledge_sources FOR SELECT TO crm_app USING (workspace_id = (SELECT app_workspace_id()) AND (SELECT app_has_role(array['owner','admin','agent','viewer'])));--> statement-breakpoint
CREATE POLICY ks_insert ON knowledge_sources FOR INSERT TO crm_app WITH CHECK (workspace_id = (SELECT app_workspace_id()) AND (SELECT app_has_role(array['owner','admin'])) AND created_by = (SELECT app_user_id()));--> statement-breakpoint
CREATE POLICY ks_update ON knowledge_sources FOR UPDATE TO crm_app USING (workspace_id = (SELECT app_workspace_id()) AND (SELECT app_has_role(array['owner','admin']))) WITH CHECK (workspace_id = (SELECT app_workspace_id()) AND (SELECT app_has_role(array['owner','admin'])));--> statement-breakpoint
CREATE POLICY kc_select ON knowledge_chunks FOR SELECT TO crm_app USING (workspace_id = (SELECT app_workspace_id()) AND (SELECT app_has_role(array['owner','admin','agent','viewer'])));--> statement-breakpoint
CREATE POLICY kc_insert ON knowledge_chunks FOR INSERT TO crm_app WITH CHECK (workspace_id = (SELECT app_workspace_id()) AND (SELECT app_has_role(array['owner','admin'])));--> statement-breakpoint
CREATE POLICY kc_delete ON knowledge_chunks FOR DELETE TO crm_app USING (workspace_id = (SELECT app_workspace_id()) AND (SELECT app_has_role(array['owner','admin'])));--> statement-breakpoint
-- Identity is fixed, and a deleted source stays deleted.
CREATE FUNCTION knowledge_sources_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id <> OLD.id OR NEW.workspace_id <> OLD.workspace_id OR NEW.type <> OLD.type OR NEW.source_ref IS DISTINCT FROM OLD.source_ref OR NEW.created_by IS DISTINCT FROM OLD.created_by THEN
    RAISE EXCEPTION 'a knowledge source cannot change its identity';
  END IF;
  IF OLD.deleted_at IS NOT NULL THEN
    RAISE EXCEPTION 'a deleted knowledge source is final';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER knowledge_sources_guard_trg BEFORE UPDATE ON knowledge_sources FOR EACH ROW EXECUTE FUNCTION knowledge_sources_guard();
