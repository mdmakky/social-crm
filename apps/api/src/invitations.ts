import { createHash, randomBytes } from "node:crypto";
import { Hono, type Context } from "hono";
import { and, count, desc, eq, sql } from "drizzle-orm";
import { AcceptInvitationBody, CreateInvitationBody, INVITATION_TTL_DAYS, MAX_PENDING_INVITATIONS, type InvitationDto } from "@crm/contracts";
import { can, type Mailer } from "@crm/core";
import { schema, user, withContext, type Db } from "@crm/db";
import { writeAudit } from "./audit.ts";
import { body, fail, isUuid, wctx, actor, forbidden, type ScopedEnv } from "./routes/scope.ts";
import { WindowCounter } from "./throttle.ts";
import type { Vars } from "./routes/workspaces.ts";

/** The raw token exists only in the create/resend response (and the optional email); the database and the audit log hold the SHA-256 only. */
const hashToken = (t: string) => createHash("sha256").update(t).digest("hex");
const newToken = () => randomBytes(32).toString("base64url");
const DAY = 86_400_000;
const I = schema.workspaceInvitations;

export type InvitationDeps = { mailer?: Mailer; webOrigin: string; limits?: { createPerUser?: number; acceptPerUser?: number; windowMs?: number } };

const maskEmail = (e: string) => {
  const [local = "", domain = ""] = e.split("@");
  return `${local.slice(0, 1)}***@${domain}`;
};
const pgCode = (e: unknown) => ((e as { cause?: { code?: string } }).cause?.code ?? (e as { code?: string }).code);

function dto(i: typeof I.$inferSelect, inviterName: string | null): InvitationDto {
  const lapsed = i.status === "pending" && i.expiresAt.getTime() <= Date.now();
  return { id: i.id, email: i.email, role: i.role as "admin" | "agent" | "viewer", status: lapsed ? "expired" : (i.status as InvitationDto["status"]), invitedByName: inviterName, expiresAt: i.expiresAt.toISOString(), createdAt: i.createdAt.toISOString(), acceptedAt: i.acceptedAt?.toISOString() ?? null };
}

const inviteEmail = (workspaceName: string, inviterName: string, link: string) => ({
  subject: `${inviterName} invited you to ${workspaceName}`,
  text: `${inviterName} invited you to join ${workspaceName} on Social CRM.\n\nOpen this link to accept (it expires in ${INVITATION_TTL_DAYS} days):\n${link}\n\nIf you weren't expecting this, ignore this email.`,
});

export function invitationRoutes(db: Db, deps: InvitationDeps) {
  const lim = deps.limits ?? {};
  const windowMs = lim.windowMs ?? 3_600_000;
  const issues = new WindowCounter(lim.createPerUser ?? 30, windowMs);
  const accepts = new WindowCounter(lim.acceptPerUser ?? 20, 10 * 60_000);
  const clientIp = (c: Context) => c.req.header("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
  const link = (token: string) => `${deps.webOrigin.replace(/\/$/, "")}/invite/${token}`;

  /** Mail goes out after the transaction commits (no network inside a transaction). Never throws; the link is shown to the inviter either way. */
  async function mail(to: string, workspaceName: string, inviterName: string, token: string): Promise<boolean> {
    if (!deps.mailer) return false;
    try {
      await deps.mailer.send({ to, ...inviteEmail(workspaceName, inviterName, link(token)) });
      return true;
    } catch (e) {
      console.error("invitation email failed", e instanceof Error ? e.name : "error");
      return false;
    }
  }

  const scoped = new Hono<ScopedEnv>();
  const tooMany = (c: Context<ScopedEnv>) => fail(c, 429, "rate_limited", "Too many invitations. Try again later.");

  scoped.get("/invitations", async (c) => {
    if (!can(c.get("role"), "member.invite", {})) return forbidden(c);
    const rows = await withContext(db, wctx(c), (tx) =>
      tx.select({ i: I, inviter: user.name }).from(I).leftJoin(user, eq(user.id, I.invitedBy)).where(eq(I.workspaceId, c.get("workspaceId"))).orderBy(desc(I.createdAt), desc(I.id)).limit(100),
    );
    return c.json(rows.map((r) => dto(r.i, r.inviter)));
  });

  scoped.post("/invitations", async (c) => {
    if (!can(c.get("role"), "member.invite", {})) return forbidden(c);
    const b = await body(c, CreateInvitationBody);
    if (!b.ok) return b.res;
    if (b.data.role === "admin" && c.get("role") !== "owner") return fail(c, 403, "admin_invite_needs_owner", "Only an owner can invite an admin.");
    if (!issues.allow(`u:${c.get("userId")}`)) return tooMany(c);
    const { email, role } = b.data;
    const workspaceId = c.get("workspaceId");
    const token = newToken();
    try {
      const out = await withContext(db, wctx(c), async (tx) => {
        const [member] = await tx.select({ id: user.id }).from(schema.memberships).innerJoin(user, eq(user.id, schema.memberships.userId)).where(and(eq(schema.memberships.workspaceId, workspaceId), sql`lower(${user.email}) = ${email}`));
        if (member) return { err: fail(c, 409, "already_member", "That person is already a member.") };
        const [pending] = await tx.select().from(I).where(and(eq(I.workspaceId, workspaceId), eq(I.email, email), eq(I.status, "pending")));
        if (pending) {
          if (pending.expiresAt.getTime() > Date.now()) return { err: fail(c, 409, "duplicate_pending", "An invitation is already pending for this email. Resend it instead.") };
          await tx.update(I).set({ status: "expired" }).where(eq(I.id, pending.id));
        }
        const [n] = await tx.select({ n: count() }).from(I).where(and(eq(I.workspaceId, workspaceId), eq(I.status, "pending")));
        if (n!.n >= MAX_PENDING_INVITATIONS) return { err: fail(c, 409, "too_many_pending", `A workspace can have ${MAX_PENDING_INVITATIONS} pending invitations. Revoke some first.`) };
        const [row] = await tx.insert(I).values({ workspaceId, email, role, tokenHash: hashToken(token), invitedBy: c.get("userId"), expiresAt: new Date(Date.now() + INVITATION_TTL_DAYS * DAY) }).returning();
        const [w] = await tx.select({ name: schema.workspaces.name }).from(schema.workspaces).where(eq(schema.workspaces.id, workspaceId));
        const [me] = await tx.select({ name: user.name }).from(user).where(eq(user.id, c.get("userId")));
        await writeAudit(tx, { ...actor(c), workspaceId, action: "invitation.created", entityType: "invitation", entityId: row!.id, summary: { email, role } });
        return { row: row!, workspaceName: w?.name ?? "", inviterName: me?.name ?? "" };
      });
      if ("err" in out) return out.err;
      const emailSent = await mail(email, out.workspaceName, out.inviterName, token);
      return c.json({ invitation: dto(out.row, out.inviterName), link: link(token), emailSent }, 201);
    } catch (e) {
      if (pgCode(e) === "23514") return fail(c, 409, "too_many_pending", `A workspace can have ${MAX_PENDING_INVITATIONS} pending invitations. Revoke some first.`);
      if (pgCode(e) === "23505") return fail(c, 409, "duplicate_pending", "An invitation is already pending for this email. Resend it instead.");
      throw e;
    }
  });

  /** Owner/admin may act on agent/viewer invitations; an admin invitation needs an owner (RLS says the same). */
  const load = async (c: Context<ScopedEnv>) => {
    const id = c.req.param("invitationId");
    if (!isUuid(id)) return { err: fail(c, 404, "not_found") };
    if (!can(c.get("role"), "member.invite", {})) return { err: forbidden(c) };
    return { id };
  };

  scoped.post("/invitations/:invitationId/revoke", async (c) => {
    const l = await load(c);
    if ("err" in l) return l.err;
    const workspaceId = c.get("workspaceId");
    const out = await withContext(db, wctx(c), async (tx) => {
      const [r] = await tx.select({ i: I, inviter: user.name }).from(I).leftJoin(user, eq(user.id, I.invitedBy)).where(and(eq(I.workspaceId, workspaceId), eq(I.id, l.id)));
      if (!r) return { err: fail(c, 404, "not_found") };
      if (r.i.role === "admin" && c.get("role") !== "owner") return { err: fail(c, 403, "admin_invite_needs_owner", "Only an owner can manage an admin invitation.") };
      if (r.i.status === "revoked") return { out: dto(r.i, r.inviter) };
      if (r.i.status !== "pending") return { err: fail(c, 409, "not_pending", "This invitation is no longer pending.") };
      const [u] = await tx.update(I).set({ status: "revoked" }).where(eq(I.id, l.id)).returning();
      await writeAudit(tx, { ...actor(c), workspaceId, action: "invitation.revoked", entityType: "invitation", entityId: l.id, summary: { email: r.i.email, role: r.i.role } });
      return { out: dto(u!, r.inviter) };
    });
    return "err" in out ? out.err : c.json(out.out);
  });

  scoped.post("/invitations/:invitationId/resend", async (c) => {
    const l = await load(c);
    if ("err" in l) return l.err;
    if (!issues.allow(`u:${c.get("userId")}`)) return tooMany(c);
    const workspaceId = c.get("workspaceId");
    const token = newToken();
    const out = await withContext(db, wctx(c), async (tx) => {
      const [r] = await tx.select({ i: I, inviter: user.name }).from(I).leftJoin(user, eq(user.id, I.invitedBy)).where(and(eq(I.workspaceId, workspaceId), eq(I.id, l.id)));
      if (!r) return { err: fail(c, 404, "not_found") };
      if (r.i.role === "admin" && c.get("role") !== "owner") return { err: fail(c, 403, "admin_invite_needs_owner", "Only an owner can manage an admin invitation.") };
      if (r.i.status !== "pending") return { err: fail(c, 409, "not_pending", "This invitation is no longer pending. Send a new one.") };
      const [u] = await tx.update(I).set({ tokenHash: hashToken(token), expiresAt: new Date(Date.now() + INVITATION_TTL_DAYS * DAY) }).where(eq(I.id, l.id)).returning();
      const [w] = await tx.select({ name: schema.workspaces.name }).from(schema.workspaces).where(eq(schema.workspaces.id, workspaceId));
      const [me] = await tx.select({ name: user.name }).from(user).where(eq(user.id, c.get("userId")));
      await writeAudit(tx, { ...actor(c), workspaceId, action: "invitation.resent", entityType: "invitation", entityId: l.id, summary: { email: r.i.email, role: r.i.role } });
      return { row: u!, inviter: r.inviter, workspaceName: w?.name ?? "", senderName: me?.name ?? "" };
    });
    if ("err" in out) return out.err;
    const emailSent = await mail(out.row.email, out.workspaceName, out.senderName, token);
    return c.json({ invitation: dto(out.row, out.inviter), link: link(token), emailSent });
  });

  // Public by token: no session. Unknown, expired, revoked and used tokens are indistinguishable (one generic 404). Not rate limited: the token has 256 bits, and the invite page calls this from the Next server where every visitor shares one IP.
  const preview = new Hono<{ Variables: Vars }>();
  preview.get("/invitations/preview", async (c) => {
    const token = c.req.query("token") ?? "";
    if (token.length < 20 || token.length > 200) return c.json({ error: { code: "not_found" } }, 404);
    const rows = (await withContext(db, {}, (tx) => tx.execute(sql`SELECT * FROM invitation_preview(${hashToken(token)})`))).rows as { status: string; role: string; email: string; expires_at: Date | string; workspace_name: string; inviter_name: string }[];
    const r = rows[0];
    const exp = r ? new Date(r.expires_at) : null;
    if (!r || r.status !== "pending" || !exp || exp.getTime() <= Date.now()) return c.json({ error: { code: "not_found" } }, 404);
    return c.json({ workspaceName: r.workspace_name, role: r.role, inviterName: r.inviter_name, emailMasked: maskEmail(r.email), expiresAt: exp.toISOString() });
  });

  // Needs a session. The invitation token is the secret, the signed-in email must also equal the invited email (checked inside invitation_accept).
  const accept = new Hono<{ Variables: Vars }>();
  accept.post("/invitations/accept", async (c) => {
    const userId = c.get("userId");
    if (!accepts.allow(`u:${userId}`)) return c.json({ error: { code: "rate_limited", message: "Too many attempts. Try again later." } }, 429);
    const parsed = AcceptInvitationBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: { code: "invalid_body" } }, 400);
    const out = await withContext(db, { userId }, async (tx) => {
      const [r] = (await tx.execute(sql`SELECT * FROM invitation_accept(${hashToken(parsed.data.token)}, ${userId})`)).rows as { outcome: string; workspace_id: string | null; role: string | null }[];
      if (r?.outcome === "accepted") {
        // The new membership now exists in this transaction, so the audit insert passes its own RLS.
        await tx.execute(sql`SELECT set_config('app.workspace_id', ${r.workspace_id}, true)`);
        await writeAudit(tx, { workspaceId: r.workspace_id!, actorUserId: userId, requestId: c.get("requestId"), ip: clientIp(c), action: "invitation.accepted", entityType: "membership", entityId: userId, summary: { role: r.role } });
      }
      return r;
    });
    if (!out || out.outcome === "not_found") return c.json({ error: { code: "not_found", message: "This invitation is no longer valid." } }, 404);
    if (out.outcome === "wrong_email") return c.json({ error: { code: "wrong_email", message: "This invitation was sent to another email." } }, 403);
    if (out.outcome === "expired") return c.json({ error: { code: "expired", message: "This invitation has expired. Ask for a new one." } }, 410);
    return c.json({ workspaceId: out.workspace_id, role: out.role });
  });

  return { scoped, preview, accept };
}
