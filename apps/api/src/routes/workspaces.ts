import { Hono, type Context } from "hono";
import { and, count, desc, eq, lt } from "drizzle-orm";
import { CreateWorkspaceBody, UpdateMemberBody, UpdateWorkspaceBody } from "@crm/contracts";
import { can, memberChangeAllowed, type Role } from "@crm/core";
import { schema, user, withContext, type Db, type Tx } from "@crm/db";
import { writeAudit } from "../audit.ts";
import { ensureDefaultPipeline, ensureDefaultStages } from "../crm-service.ts";
import type { ScopedEnv } from "./scope.ts";
import { contactRoutes } from "./contacts.ts";
import { conversationRoutes } from "./conversations.ts";
import type { MetaConnectDeps } from "../inbox/meta-connect.ts";
import { sendRoutes } from "../inbox/send.ts";
import { contactMethodRoutes } from "./contact-methods.ts";
import { crmConfigRoutes } from "./crm-config.ts";
import { searchRoutes } from "../search/routes.ts"; // track:search
import type { SearchProvider } from "../search/types.ts"; // track:search
// --- track:tasks ---
import { leadReportRoutes } from "./lead-reports.ts";
import { leadRoutes } from "./leads.ts";
import { pipelineRoutes } from "./pipelines.ts";
import { taskRoutes } from "./tasks.ts";
import { importRoutes, type ImportHooks } from "./imports.ts";
import { notificationRoutes } from "./notifications.ts"; // track:notifications
import { automationRoutes } from "./automation.ts"; // track:automation

export type Vars = { userId: string; requestId: string };
type Ctx = Context<{ Variables: Vars }>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const err = (c: Ctx, status: 400 | 403 | 404 | 409, code: string, message?: string) => c.json({ error: { code, message } }, status);

function slugify(name: string): string {
  const base = name.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "workspace";
  const suffix = Array.from(crypto.getRandomValues(new Uint8Array(5)), (b) => (b % 36).toString(36)).join("");
  return `${base}-${suffix}`;
}

async function roleIn(tx: Tx, workspaceId: string, userId: string): Promise<Role | null> {
  const [m] = await tx
    .select({ role: schema.memberships.role })
    .from(schema.memberships)
    .where(and(eq(schema.memberships.workspaceId, workspaceId), eq(schema.memberships.userId, userId), eq(schema.memberships.status, "active")));
  return m?.role ?? null;
}

export function workspaceRoutes(db: Db, hooks: { import?: ImportHooks; extraSearchProviders?: SearchProvider[]; metaScoped?: Hono<ScopedEnv>; sendDeps?: MetaConnectDeps } = {}) {
  const r = new Hono<{ Variables: Vars }>();
  const audit = (c: Ctx) => ({ actorUserId: c.get("userId"), requestId: c.get("requestId"), ip: c.req.header("x-forwarded-for")?.split(",")[0]?.trim() });

  r.get("/", async (c) => {
    const userId = c.get("userId");
    const rows = await withContext(db, { userId }, (tx) =>
      tx
        .select({ id: schema.workspaces.id, name: schema.workspaces.name, slug: schema.workspaces.slug, role: schema.memberships.role })
        .from(schema.memberships)
        .innerJoin(schema.workspaces, eq(schema.workspaces.id, schema.memberships.workspaceId))
        .where(and(eq(schema.memberships.userId, userId), eq(schema.memberships.status, "active")))
        .orderBy(schema.workspaces.createdAt),
    );
    return c.json(rows);
  });

  r.post("/", async (c) => {
    const body = CreateWorkspaceBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return err(c, 400, "invalid_body", body.error.issues[0]?.message);
    const userId = c.get("userId");
    const created = await withContext(db, { userId }, async (tx) => {
      const [w] = await tx.insert(schema.workspaces).values({ name: body.data.name, slug: slugify(body.data.name), ownerUserId: userId }).returning();
      await tx.insert(schema.memberships).values({ workspaceId: w!.id, userId, role: "owner" });
      return w!;
    });
    await withContext(db, { userId, workspaceId: created.id }, (tx) =>
      Promise.all([ensureDefaultStages(tx, created.id), ensureDefaultPipeline(tx, created.id), writeAudit(tx, { ...audit(c), workspaceId: created.id, action: "workspace.created", entityType: "workspace", entityId: created.id, summary: { name: created.name } })]).then(() => undefined),
    );
    return c.json({ id: created.id, name: created.name, slug: created.slug, role: "owner" as const }, 201);
  });

  /** Everything below is scoped to one workspace; non-members get 404 so existence does not leak. */
  const scoped = new Hono<{ Variables: Vars & { workspaceId: string; role: Role } }>();
  scoped.use("*", async (c, next) => {
    const id = c.req.param("id") ?? "";
    if (!UUID.test(id)) return c.json({ error: { code: "not_found" } }, 404);
    // Membership is proven with only the user in context. app.workspace_id is never set for a workspace the caller is not a member of.
    const role = await withContext(db, { userId: c.get("userId") }, (tx) => roleIn(tx, id, c.get("userId")));
    if (!role) return c.json({ error: { code: "not_found" } }, 404);
    c.set("workspaceId", id);
    c.set("role", role);
    await next();
  });
  const sctx = (c: { get: (k: "userId" | "workspaceId") => string }) => ({ userId: c.get("userId"), workspaceId: c.get("workspaceId") });
  const forbid = (c: Context) => c.json({ error: { code: "forbidden" } }, 403);

  scoped.get("/", async (c) => {
    const { workspaceId, role } = { workspaceId: c.get("workspaceId"), role: c.get("role") };
    const out = await withContext(db, sctx(c), async (tx) => {
      const [w] = await tx.select().from(schema.workspaces).where(eq(schema.workspaces.id, workspaceId));
      const [n] = await tx.select({ n: count() }).from(schema.memberships).where(and(eq(schema.memberships.workspaceId, workspaceId), eq(schema.memberships.status, "active")));
      return { w: w!, n: n!.n };
    });
    return c.json({ id: out.w.id, name: out.w.name, slug: out.w.slug, role, timezone: out.w.timezone, memberCount: out.n, createdAt: out.w.createdAt.toISOString() });
  });

  scoped.patch("/", async (c) => {
    if (!can(c.get("role"), "workspace.settings", {})) return forbid(c);
    const body = UpdateWorkspaceBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: { code: "invalid_body", message: body.error.issues[0]?.message } }, 400);
    const workspaceId = c.get("workspaceId");
    await withContext(db, sctx(c), async (tx) => {
      await tx.update(schema.workspaces).set({ ...body.data, updatedAt: new Date() }).where(eq(schema.workspaces.id, workspaceId));
      await writeAudit(tx, { ...audit(c as unknown as Ctx), workspaceId, action: "workspace.updated", entityType: "workspace", entityId: workspaceId, summary: body.data });
    });
    return c.json({ ok: true });
  });

  scoped.get("/members", async (c) => {
    const workspaceId = c.get("workspaceId");
    const rows = await withContext(db, sctx(c), (tx) =>
      tx
        .select({ userId: schema.memberships.userId, name: user.name, email: user.email, role: schema.memberships.role, status: schema.memberships.status, joinedAt: schema.memberships.createdAt })
        .from(schema.memberships)
        .innerJoin(user, eq(user.id, schema.memberships.userId))
        .where(eq(schema.memberships.workspaceId, workspaceId))
        .orderBy(schema.memberships.createdAt),
    );
    return c.json(rows.map((m) => ({ ...m, joinedAt: m.joinedAt.toISOString() })));
  });

  const changeMember = async (c: Context<{ Variables: Vars & { workspaceId: string; role: Role } }>, change: "role" | "remove") => {
    const targetId = c.req.param("userId") ?? "";
    const workspaceId = c.get("workspaceId");
    let newRole: Role | undefined;
    if (change === "role") {
      const body = UpdateMemberBody.safeParse(await c.req.json().catch(() => null));
      if (!body.success) return c.json({ error: { code: "invalid_body" } }, 400);
      newRole = body.data.role;
    }
    if (!can(c.get("role"), "member.manage", {})) return c.json({ error: { code: "forbidden" } }, 403);
    return withContext(db, sctx(c), async (tx) => {
      const [target] = await tx.select().from(schema.memberships).where(and(eq(schema.memberships.workspaceId, workspaceId), eq(schema.memberships.userId, targetId)));
      if (!target) return c.json({ error: { code: "not_found" } }, 404);
      const [owners] = await tx.select({ n: count() }).from(schema.memberships).where(and(eq(schema.memberships.workspaceId, workspaceId), eq(schema.memberships.role, "owner"), eq(schema.memberships.status, "active")));
      const decision = memberChangeAllowed({ actor: c.get("role"), target: target.role, change: newRole ? { role: newRole } : { remove: true }, ownerCount: owners!.n });
      if (!decision.ok) return c.json({ error: { code: decision.reason } }, 403);
      const [who] = await tx.select({ name: user.name }).from(user).where(eq(user.id, targetId));
      const base = { ...audit(c as unknown as Ctx), workspaceId, entityType: "membership", entityId: targetId };
      if (newRole) {
        await tx.update(schema.memberships).set({ role: newRole }).where(and(eq(schema.memberships.workspaceId, workspaceId), eq(schema.memberships.userId, targetId)));
        await writeAudit(tx, { ...base, action: "member.role_changed", summary: { from: target.role, to: newRole, name: who?.name } });
        return c.json({ userId: targetId, role: newRole });
      }
      await tx.delete(schema.memberships).where(and(eq(schema.memberships.workspaceId, workspaceId), eq(schema.memberships.userId, targetId)));
      await writeAudit(tx, { ...base, action: "member.removed", summary: { role: target.role, name: who?.name } });
      return c.body(null, 204);
    });
  };
  scoped.patch("/members/:userId", (c) => changeMember(c, "role"));
  scoped.delete("/members/:userId", (c) => changeMember(c, "remove"));

  scoped.get("/audit-log", async (c) => {
    if (!can(c.get("role"), "audit.view", {})) return forbid(c);
    const workspaceId = c.get("workspaceId");
    const limit = Math.min(Math.max(Number(c.req.query("limit") ?? 25) || 25, 1), 100);
    const cursor = c.req.query("cursor");
    if (cursor && !UUID.test(cursor)) return c.json({ error: { code: "invalid_cursor" } }, 400);
    const rows = await withContext(db, sctx(c), (tx) =>
      tx
        .select({ e: schema.auditLog, actorName: user.name })
        .from(schema.auditLog)
        .leftJoin(user, eq(user.id, schema.auditLog.actorUserId))
        .where(cursor ? and(eq(schema.auditLog.workspaceId, workspaceId), lt(schema.auditLog.id, cursor)) : eq(schema.auditLog.workspaceId, workspaceId))
        .orderBy(desc(schema.auditLog.id))
        .limit(limit + 1),
    );
    const page = rows.slice(0, limit);
    return c.json({
      items: page.map(({ e, actorName }) => ({ id: e.id, action: e.action, actorUserId: e.actorUserId, actorName, entityType: e.entityType, entityId: e.entityId, summary: e.summary as Record<string, unknown>, createdAt: e.createdAt.toISOString() })),
      nextCursor: rows.length > limit ? page[page.length - 1]!.e.id : null,
    });
  });

  scoped.route("/", crmConfigRoutes(db));
  scoped.route("/", contactRoutes(db));
  scoped.route("/", importRoutes(db, hooks.import));
  scoped.route("/", searchRoutes(db, hooks.extraSearchProviders)); // track:search
  // --- track:tasks ---
  scoped.route("/", pipelineRoutes(db));
  scoped.route("/", leadRoutes(db));
  scoped.route("/", leadReportRoutes(db));
  scoped.route("/", taskRoutes(db));
  scoped.route("/", notificationRoutes(db)); // track:notifications
  scoped.route("/", automationRoutes(db)); // track:automation
  scoped.route("/", conversationRoutes(db)); // track:inbox
  scoped.route("/", contactMethodRoutes(db));
  scoped.route("/", sendRoutes(db, hooks.sendDeps)); // track:inbox
  if (hooks.metaScoped) scoped.route("/", hooks.metaScoped); // track:inbox
  r.route("/:id", scoped as unknown as Hono<{ Variables: Vars }>);
  return r;
}
