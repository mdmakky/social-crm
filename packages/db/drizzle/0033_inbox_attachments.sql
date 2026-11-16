-- Inbox attachments (media received through, or sent from, a conversation). Metadata only: the bytes live in the BlobStore (local disk or an S3-compatible bucket), NEVER in PostgreSQL.
-- Key layout in the store is derived from ids (workspaces/{workspace_id}/attachments/{id}), so storage_key is informational and no user text ever reaches a path.
-- Inbound rows are created `pending` by the webhook worker (provider_media_id / provider_url), downloaded outside any transaction, validated by magic bytes, then `ready`.
-- Outbound rows (source user_upload) are inserted `ready` by the API once the bytes are validated and stored; message_id stays NULL until a message that carries them is sent.
-- Policies use scalar subqueries (D45). crm_app never reads provider_url (a short-lived CDN link). Delete rights are enforced in the guard trigger: owner/admin, or the uploader when an agent.
CREATE TABLE "attachments" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"message_id" uuid,
	"direction" text NOT NULL,
	"source" text NOT NULL,
	"kind" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"mime" text,
	"declared_mime" text,
	"original_filename" text,
	"size_bytes" bigint,
	"sha256" text,
	"storage_key" text,
	"provider_media_id" text,
	"provider_url" text,
	"error_code" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "attachments_ws_id" UNIQUE("workspace_id","id"),
	CONSTRAINT "attachments_direction" CHECK ("direction" IN ('inbound','outbound')),
	CONSTRAINT "attachments_source" CHECK ("source" IN ('channel_download','user_upload')),
	CONSTRAINT "attachments_kind" CHECK ("kind" IN ('image','audio','video','document')),
	CONSTRAINT "attachments_status" CHECK ("status" IN ('pending','ready','failed','deleted','missing')),
	CONSTRAINT "attachments_source_shape" CHECK (("source" = 'channel_download') = ("direction" = 'inbound')),
	CONSTRAINT "attachments_upload_user" CHECK ("source" <> 'user_upload' OR "created_by" IS NOT NULL),
	CONSTRAINT "attachments_ready_shape" CHECK ("status" NOT IN ('ready','missing') OR ("mime" IS NOT NULL AND "size_bytes" IS NOT NULL AND "sha256" IS NOT NULL AND "storage_key" IS NOT NULL)),
	CONSTRAINT "attachments_deleted_at" CHECK (("status" = 'deleted') = ("deleted_at" IS NOT NULL)),
	CONSTRAINT "attachments_size" CHECK ("size_bytes" IS NULL OR "size_bytes" > 0),
	CONSTRAINT "attachments_sha" CHECK ("sha256" IS NULL OR "sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "attachments_mime" CHECK ("mime" IS NULL OR char_length("mime") <= 127),
	CONSTRAINT "attachments_declared_mime" CHECK ("declared_mime" IS NULL OR char_length("declared_mime") <= 127),
	CONSTRAINT "attachments_filename" CHECK ("original_filename" IS NULL OR char_length("original_filename") BETWEEN 1 AND 200),
	CONSTRAINT "attachments_key" CHECK ("storage_key" IS NULL OR "storage_key" = 'workspaces/' || "workspace_id" || '/attachments/' || "id"),
	CONSTRAINT "attachments_provider_id" CHECK ("provider_media_id" IS NULL OR char_length("provider_media_id") BETWEEN 1 AND 255),
	CONSTRAINT "attachments_provider_url" CHECK ("provider_url" IS NULL OR char_length("provider_url") <= 2000),
	CONSTRAINT "attachments_error" CHECK ("error_code" IS NULL OR "error_code" ~ '^[a-z0-9_:]{1,80}$'),
	CONSTRAINT "attachments_attempts" CHECK ("attempts" >= 0)
);--> statement-breakpoint
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_conversation_fk" FOREIGN KEY ("workspace_id","conversation_id") REFERENCES "public"."conversations"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- A message can only carry attachments of its own conversation (MATCH SIMPLE: skipped while message_id is NULL).
ALTER TABLE "messages" ADD CONSTRAINT "messages_ws_id_conversation" UNIQUE("workspace_id","id","conversation_id");--> statement-breakpoint
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_message_fk" FOREIGN KEY ("workspace_id","message_id","conversation_id") REFERENCES "public"."messages"("workspace_id","id","conversation_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "attachments_conversation_idx" ON "attachments" USING btree ("workspace_id","conversation_id","created_at");--> statement-breakpoint
CREATE INDEX "attachments_message_idx" ON "attachments" USING btree ("workspace_id","message_id");--> statement-breakpoint
-- Idempotent inbound recording: one row per (message, provider media id). Messenger / Instagram have no media id, so the parser's position in the message ("idx:0") is used.
CREATE UNIQUE INDEX "attachments_provider_uq" ON "attachments" USING btree ("workspace_id","message_id","provider_media_id") WHERE "provider_media_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "attachments_pending_idx" ON "attachments" USING btree ("next_attempt_at") WHERE "status" = 'pending' AND "source" = 'channel_download';--> statement-breakpoint
ALTER TABLE attachments ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE attachments FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON attachments FROM crm_app, crm_worker;--> statement-breakpoint
GRANT SELECT (id, workspace_id, conversation_id, message_id, direction, source, kind, status, mime, declared_mime, original_filename, size_bytes, sha256, storage_key, provider_media_id, error_code, attempts, next_attempt_at, created_by, created_at, updated_at, deleted_at) ON attachments TO crm_app;--> statement-breakpoint
GRANT INSERT (id, workspace_id, conversation_id, direction, source, kind, status, mime, declared_mime, original_filename, size_bytes, sha256, storage_key, created_by) ON attachments TO crm_app;--> statement-breakpoint
GRANT UPDATE (message_id, status, error_code, attempts, next_attempt_at, deleted_at, updated_at) ON attachments TO crm_app;--> statement-breakpoint
GRANT SELECT, INSERT ON attachments TO crm_worker;--> statement-breakpoint
GRANT UPDATE (message_id, kind, status, mime, size_bytes, sha256, storage_key, error_code, attempts, next_attempt_at, deleted_at, updated_at) ON attachments TO crm_worker;--> statement-breakpoint
CREATE POLICY att_select ON attachments FOR SELECT TO crm_app USING (workspace_id = (SELECT app_workspace_id()) AND (SELECT app_has_role(array['owner','admin','agent','viewer'])));--> statement-breakpoint
CREATE POLICY att_insert ON attachments FOR INSERT TO crm_app WITH CHECK (workspace_id = (SELECT app_workspace_id()) AND (SELECT app_has_role(array['owner','admin','agent'])) AND direction = 'outbound' AND source = 'user_upload' AND status = 'ready' AND created_by = (SELECT app_user_id()));--> statement-breakpoint
CREATE POLICY att_update ON attachments FOR UPDATE TO crm_app USING (workspace_id = (SELECT app_workspace_id()) AND (SELECT app_has_role(array['owner','admin','agent']))) WITH CHECK (workspace_id = (SELECT app_workspace_id()) AND (SELECT app_has_role(array['owner','admin','agent'])));--> statement-breakpoint
CREATE POLICY att_worker_select ON attachments FOR SELECT TO crm_worker USING (workspace_id = (SELECT app_workspace_id()));--> statement-breakpoint
CREATE POLICY att_worker_insert ON attachments FOR INSERT TO crm_worker WITH CHECK (workspace_id = (SELECT app_workspace_id()) AND direction = 'inbound' AND source = 'channel_download' AND status = 'pending');--> statement-breakpoint
CREATE POLICY att_worker_update ON attachments FOR UPDATE TO crm_worker USING (workspace_id = (SELECT app_workspace_id())) WITH CHECK (workspace_id = (SELECT app_workspace_id()));--> statement-breakpoint
-- The worker lists work across workspaces BEFORE it knows a workspace (the claim query), like webhook_events: a narrow SECURITY DEFINER function returns only ids.
CREATE FUNCTION attachments_due(p_limit integer) RETURNS TABLE (workspace_id uuid, id uuid) LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT a.workspace_id, a.id FROM attachments a WHERE a.status = 'pending' AND a.source = 'channel_download' AND coalesce(a.next_attempt_at, now()) <= now() ORDER BY a.created_at LIMIT least(greatest(p_limit, 1), 200)
$$;--> statement-breakpoint
CREATE POLICY att_due_select ON attachments FOR SELECT TO crm_migrator USING (true);--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION attachments_due(integer) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION attachments_due(integer) TO crm_worker;--> statement-breakpoint
-- Identity and content are final. A state change is checked per role; delete rights live here so no code path can skip them.
CREATE FUNCTION attachments_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id <> OLD.id OR NEW.workspace_id <> OLD.workspace_id OR NEW.conversation_id <> OLD.conversation_id OR NEW.direction <> OLD.direction OR NEW.source <> OLD.source
     OR NEW.created_at <> OLD.created_at OR NEW.created_by IS DISTINCT FROM OLD.created_by OR NEW.provider_media_id IS DISTINCT FROM OLD.provider_media_id OR NEW.provider_url IS DISTINCT FROM OLD.provider_url
     OR NEW.original_filename IS DISTINCT FROM OLD.original_filename OR NEW.declared_mime IS DISTINCT FROM OLD.declared_mime THEN
    RAISE EXCEPTION 'an attachment cannot change its identity';
  END IF;
  IF OLD.message_id IS NOT NULL AND NEW.message_id IS DISTINCT FROM OLD.message_id THEN RAISE EXCEPTION 'an attachment cannot move to another message'; END IF;
  IF OLD.sha256 IS NOT NULL AND (NEW.sha256 IS DISTINCT FROM OLD.sha256 OR NEW.size_bytes IS DISTINCT FROM OLD.size_bytes OR NEW.storage_key IS DISTINCT FROM OLD.storage_key OR NEW.mime IS DISTINCT FROM OLD.mime OR NEW.kind <> OLD.kind) THEN
    RAISE EXCEPTION 'attachment content is immutable once stored';
  END IF;
  IF OLD.status = 'deleted' THEN RAISE EXCEPTION 'a deleted attachment is final'; END IF;
  IF NEW.status <> OLD.status THEN
    IF NEW.status = 'deleted' THEN
      IF current_user = 'crm_app' AND NOT ((SELECT app_has_role(array['owner','admin'])) OR (OLD.created_by = (SELECT app_user_id()) AND (SELECT app_has_role(array['agent'])))) THEN
        RAISE EXCEPTION 'only an owner, an admin or the uploader can delete an attachment';
      END IF;
    ELSIF current_user = 'crm_app' THEN
      -- a person can only ask for a new download of an inbound file that failed or went missing
      IF NOT (OLD.status IN ('failed','missing') AND NEW.status = 'pending' AND OLD.direction = 'inbound') THEN RAISE EXCEPTION 'attachment status change % -> % is not allowed', OLD.status, NEW.status; END IF;
    ELSIF NOT ((OLD.status, NEW.status) IN (('pending','ready'),('pending','failed'),('pending','missing'),('ready','missing'),('failed','pending'),('missing','pending'),('missing','ready'))) THEN
      RAISE EXCEPTION 'attachment status change % -> % is not allowed', OLD.status, NEW.status;
    END IF;
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER attachments_guard_trg BEFORE UPDATE ON attachments FOR EACH ROW EXECUTE FUNCTION attachments_guard();--> statement-breakpoint
CREATE FUNCTION attachments_no_delete() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'attachments are soft-deleted (status deleted), never removed'; END $$;--> statement-breakpoint
CREATE TRIGGER attachments_no_delete_trg BEFORE DELETE OR TRUNCATE ON attachments FOR EACH STATEMENT EXECUTE FUNCTION attachments_no_delete();--> statement-breakpoint
-- Deleting an attachment removes what was derived from it: knowledge sources that REFERENCE it (source_ref = 'attachment:<id>') are soft-deleted and their passages removed (decision D137).
-- It runs as the table owner so an agent who uploaded the file can delete it without holding knowledge rights; the owner needs explicit policies because RLS is forced.
CREATE POLICY ks_att_cascade_select ON knowledge_sources FOR SELECT TO crm_migrator USING (true);--> statement-breakpoint
CREATE POLICY ks_att_cascade_update ON knowledge_sources FOR UPDATE TO crm_migrator USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY kc_att_cascade_delete ON knowledge_chunks FOR DELETE TO crm_migrator USING (true);--> statement-breakpoint
CREATE POLICY kc_att_cascade_select ON knowledge_chunks FOR SELECT TO crm_migrator USING (true);--> statement-breakpoint
CREATE FUNCTION attachments_cascade_knowledge() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  DELETE FROM knowledge_chunks WHERE workspace_id = NEW.workspace_id AND source_id IN (SELECT id FROM knowledge_sources WHERE workspace_id = NEW.workspace_id AND source_ref = 'attachment:' || NEW.id AND deleted_at IS NULL);
  UPDATE knowledge_sources SET deleted_at = now(), body = NULL, updated_at = now() WHERE workspace_id = NEW.workspace_id AND source_ref = 'attachment:' || NEW.id AND deleted_at IS NULL;
  RETURN NEW;
END $$;--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION attachments_cascade_knowledge() FROM PUBLIC;--> statement-breakpoint
CREATE TRIGGER attachments_cascade_knowledge_trg AFTER UPDATE OF status ON attachments FOR EACH ROW WHEN (NEW.status = 'deleted' AND OLD.status <> 'deleted') EXECUTE FUNCTION attachments_cascade_knowledge();
