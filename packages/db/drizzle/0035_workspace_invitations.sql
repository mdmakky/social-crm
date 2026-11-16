-- Member invitations (FR-46). Owner/admin invite by email; the raw token is shown/sent once and only its SHA-256 is stored.
-- Admin invitations need an owner (RLS). Acceptance happens before the invitee is a member, so it goes through the narrow
-- SECURITY DEFINER functions below (same pattern as attachments_due in 0033): fixed search_path, execute only for crm_app, a crm_migrator policy for the tables they touch.
CREATE TABLE "workspace_invitations" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"email" text NOT NULL,
	"role" "workspace_role" NOT NULL,
	"token_hash" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"invited_by" text NOT NULL,
	"expires_at" timestamp with time zone DEFAULT now() + interval '7 days' NOT NULL,
	"accepted_by" text,
	"accepted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspace_invitations_token_hash" UNIQUE("token_hash"),
	CONSTRAINT "workspace_invitations_role" CHECK ("role" <> 'owner'),
	CONSTRAINT "workspace_invitations_status" CHECK ("status" IN ('pending','accepted','revoked','expired')),
	CONSTRAINT "workspace_invitations_email" CHECK ("email" = lower("email") AND char_length("email") BETWEEN 3 AND 254),
	CONSTRAINT "workspace_invitations_hash" CHECK ("token_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "workspace_invitations_accepted" CHECK (("status" = 'accepted') = ("accepted_by" IS NOT NULL AND "accepted_at" IS NOT NULL))
);--> statement-breakpoint
ALTER TABLE "workspace_invitations" ADD CONSTRAINT "workspace_invitations_workspace_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_invitations" ADD CONSTRAINT "workspace_invitations_invited_by_fk" FOREIGN KEY ("invited_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_invitations" ADD CONSTRAINT "workspace_invitations_accepted_by_fk" FOREIGN KEY ("accepted_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_invitations_pending_uq" ON "workspace_invitations" USING btree ("workspace_id","email") WHERE "status" = 'pending';--> statement-breakpoint
CREATE INDEX "workspace_invitations_list_idx" ON "workspace_invitations" USING btree ("workspace_id","created_at" DESC,"id" DESC);--> statement-breakpoint
ALTER TABLE workspace_invitations ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE workspace_invitations FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON workspace_invitations FROM crm_app, crm_worker;--> statement-breakpoint
GRANT SELECT, INSERT ON workspace_invitations TO crm_app;--> statement-breakpoint
GRANT UPDATE (status, token_hash, expires_at) ON workspace_invitations TO crm_app;--> statement-breakpoint
-- Owner/admin see and manage invitations of the workspace in context; only an owner touches an admin invitation.
CREATE POLICY wi_select ON workspace_invitations FOR SELECT TO crm_app USING (workspace_id = (SELECT app_workspace_id()) AND (SELECT app_has_role(array['owner','admin'])));--> statement-breakpoint
CREATE POLICY wi_insert ON workspace_invitations FOR INSERT TO crm_app WITH CHECK (workspace_id = (SELECT app_workspace_id()) AND invited_by = (SELECT app_user_id()) AND status = 'pending'
  AND ((role IN ('agent','viewer') AND (SELECT app_has_role(array['owner','admin']))) OR (role = 'admin' AND (SELECT app_has_role(array['owner'])))));--> statement-breakpoint
CREATE POLICY wi_update ON workspace_invitations FOR UPDATE TO crm_app
  USING (workspace_id = (SELECT app_workspace_id()) AND ((role IN ('agent','viewer') AND (SELECT app_has_role(array['owner','admin']))) OR (role = 'admin' AND (SELECT app_has_role(array['owner'])))))
  WITH CHECK (workspace_id = (SELECT app_workspace_id()));--> statement-breakpoint
-- Policies for the definer functions (they run as the table owner crm_migrator, which FORCE RLS still binds).
CREATE POLICY wi_def_select ON workspace_invitations FOR SELECT TO crm_migrator USING (true);--> statement-breakpoint
CREATE POLICY wi_def_update ON workspace_invitations FOR UPDATE TO crm_migrator USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY ms_inv_select ON memberships FOR SELECT TO crm_migrator USING (true);--> statement-breakpoint
CREATE POLICY ms_inv_insert ON memberships FOR INSERT TO crm_migrator WITH CHECK (true);--> statement-breakpoint
CREATE POLICY ms_inv_update ON memberships FOR UPDATE TO crm_migrator USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY ws_inv_select ON workspaces FOR SELECT TO crm_migrator USING (true);--> statement-breakpoint
CREATE FUNCTION workspace_invitations_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- serialise creates per workspace so concurrent inserts cannot pass the cap together
    PERFORM pg_advisory_xact_lock(hashtextextended(NEW.workspace_id::text, 0));
    IF (SELECT count(*) FROM workspace_invitations WHERE workspace_id = NEW.workspace_id AND status = 'pending') >= 100 THEN
      RAISE EXCEPTION 'too many pending invitations' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.id <> OLD.id OR NEW.workspace_id <> OLD.workspace_id OR NEW.email <> OLD.email OR NEW.role <> OLD.role OR NEW.invited_by <> OLD.invited_by OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'an invitation cannot change its identity';
  END IF;
  IF OLD.status <> 'pending' THEN
    RAISE EXCEPTION 'an invitation that is % is final', OLD.status;
  END IF;
  IF NEW.status = 'accepted' THEN
    IF current_user = 'crm_app' THEN RAISE EXCEPTION 'an invitation is accepted through invitation_accept only'; END IF;
    IF NEW.token_hash <> OLD.token_hash OR OLD.expires_at <= now() THEN RAISE EXCEPTION 'invalid acceptance'; END IF;
  ELSIF NEW.status = 'expired' THEN
    IF OLD.expires_at > now() OR NEW.token_hash <> OLD.token_hash THEN RAISE EXCEPTION 'only a lapsed invitation can expire'; END IF;
  ELSIF NEW.status = 'revoked' THEN
    IF NEW.token_hash <> OLD.token_hash THEN RAISE EXCEPTION 'a revoked invitation keeps its token'; END IF;
  ELSE
    -- resend: the token is replaced and the expiry moves forward; nothing else
    IF NEW.token_hash <> OLD.token_hash AND NEW.expires_at <= OLD.expires_at THEN RAISE EXCEPTION 'a new token needs a later expiry'; END IF;
    IF NEW.accepted_by IS NOT NULL OR NEW.accepted_at IS NOT NULL THEN RAISE EXCEPTION 'invalid change'; END IF;
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER workspace_invitations_guard_trg BEFORE INSERT OR UPDATE ON workspace_invitations FOR EACH ROW EXECUTE FUNCTION workspace_invitations_guard();--> statement-breakpoint
-- Public preview by token hash: returns only what the invite page shows. Unknown hash returns no row.
CREATE FUNCTION invitation_preview(p_hash text) RETURNS TABLE (status text, role text, email text, expires_at timestamptz, workspace_name text, inviter_name text) LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT i.status, i.role::text, i.email, i.expires_at, w.name, u.name
  FROM workspace_invitations i JOIN workspaces w ON w.id = i.workspace_id JOIN "user" u ON u.id = i.invited_by WHERE i.token_hash = p_hash
$$;--> statement-breakpoint
-- Accept: one atomic step. outcome: accepted | already | expired | wrong_email | not_found. A used or revoked token of someone else is not_found (no probing).
CREATE FUNCTION invitation_accept(p_hash text, p_user text) RETURNS TABLE (outcome text, workspace_id uuid, role text) LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
#variable_conflict use_column
DECLARE i workspace_invitations%ROWTYPE; v_email text;
BEGIN
  SELECT * INTO i FROM workspace_invitations WHERE token_hash = p_hash FOR UPDATE;
  IF NOT FOUND THEN RETURN QUERY SELECT 'not_found'::text, NULL::uuid, NULL::text; RETURN; END IF;
  IF i.status = 'accepted' AND i.accepted_by = p_user THEN RETURN QUERY SELECT 'already'::text, i.workspace_id, i.role::text; RETURN; END IF;
  IF i.status IN ('accepted','revoked') THEN RETURN QUERY SELECT 'not_found'::text, NULL::uuid, NULL::text; RETURN; END IF;
  -- the email comes from the account, never from the caller
  SELECT u.email INTO v_email FROM "user" u WHERE u.id = p_user;
  IF v_email IS NULL OR lower(i.email) <> lower(v_email) THEN RETURN QUERY SELECT 'wrong_email'::text, NULL::uuid, NULL::text; RETURN; END IF;
  -- an invitation dies with its sender's authority
  IF NOT EXISTS (SELECT 1 FROM memberships m WHERE m.workspace_id = i.workspace_id AND m.user_id = i.invited_by AND m.status = 'active' AND m.role IN ('owner','admin')) THEN RETURN QUERY SELECT 'not_found'::text, NULL::uuid, NULL::text; RETURN; END IF;
  IF i.status = 'expired' OR i.expires_at <= now() THEN RETURN QUERY SELECT 'expired'::text, NULL::uuid, NULL::text; RETURN; END IF;
  INSERT INTO memberships (workspace_id, user_id, role, status) VALUES (i.workspace_id, p_user, i.role, 'active')
    ON CONFLICT (workspace_id, user_id) DO UPDATE SET role = EXCLUDED.role, status = 'active' WHERE memberships.status = 'deactivated';
  UPDATE workspace_invitations SET status = 'accepted', accepted_by = p_user, accepted_at = now() WHERE id = i.id;
  RETURN QUERY SELECT 'accepted'::text, i.workspace_id, i.role::text;
END $$;--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION invitation_preview(text), invitation_accept(text, text) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION invitation_preview(text), invitation_accept(text, text) TO crm_app;
