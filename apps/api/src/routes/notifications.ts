import { Hono } from "hono";
import { and, count, desc, eq, isNull, lt, sql } from "drizzle-orm";
import { NOTIFICATION_KINDS, NotificationListQuery, SetReadBody, UpdatePreferencesBody, type NotificationKind, type NotificationPreferences } from "@crm/contracts";
import { schema, withContext, type Db, type Tx } from "@crm/db";
import { body, fail, isUuid, query, wctx, type ScopedEnv } from "./scope.ts";

const dto = (n: typeof schema.notifications.$inferSelect) => ({
  id: n.id,
  kind: n.kind,
  title: n.title,
  body: n.body,
  entityType: n.entityType,
  entityId: n.entityId,
  data: n.data as Record<string, unknown>,
  createdAt: n.createdAt.toISOString(),
  readAt: n.readAt?.toISOString() ?? null,
});

/** Every active member (any role) manages only their own notifications; RLS (user_id = app_user_id()) enforces it again. */
export function notificationRoutes(db: Db) {
  const r = new Hono<ScopedEnv>();
  const N = schema.notifications;
  const mine = (c: Parameters<typeof wctx>[0]) => and(eq(N.workspaceId, wctx(c).workspaceId), eq(N.userId, wctx(c).userId));

  r.get("/notifications", async (c) => {
    const q = query(c, NotificationListQuery);
    if (!q.ok) return q.res;
    const limit = q.data.limit ?? 20;
    const rows = await withContext(db, wctx(c), (tx) =>
      tx
        .select()
        .from(N)
        .where(and(mine(c), q.data.unread === "true" ? isNull(N.readAt) : undefined, q.data.cursor ? lt(N.id, q.data.cursor) : undefined))
        .orderBy(desc(N.id))
        .limit(limit + 1),
    );
    const page = rows.slice(0, limit);
    return c.json({ items: page.map(dto), nextCursor: rows.length > limit ? page[page.length - 1]!.id : null });
  });

  r.get("/notifications/unread-count", async (c) => {
    const [row] = await withContext(db, wctx(c), (tx) => tx.select({ n: count() }).from(N).where(and(mine(c), isNull(N.readAt))));
    return c.json({ count: row!.n });
  });

  r.post("/notifications/read-all", async (c) => {
    const rows = await withContext(db, wctx(c), (tx) => tx.update(N).set({ readAt: sql`now()` }).where(and(mine(c), isNull(N.readAt))).returning({ id: N.id }));
    return c.json({ updated: rows.length });
  });

  r.patch("/notifications/:notificationId", async (c) => {
    const id = c.req.param("notificationId");
    if (!isUuid(id)) return fail(c, 404, "not_found");
    const b = await body(c, SetReadBody);
    if (!b.ok) return b.res;
    const [row] = await withContext(db, wctx(c), (tx) =>
      tx.update(N).set({ readAt: b.data.read ? sql`now()` : null }).where(and(mine(c), eq(N.id, id))).returning(),
    );
    return row ? c.json(dto(row)) : fail(c, 404, "not_found");
  });

  async function prefs(tx: Tx, workspaceId: string, userId: string): Promise<NotificationPreferences> {
    const rows = await tx.select().from(schema.notificationPreferences).where(and(eq(schema.notificationPreferences.workspaceId, workspaceId), eq(schema.notificationPreferences.userId, userId)));
    const by = new Map(rows.map((p) => [p.kind, p.inApp]));
    return { preferences: (Object.keys(NOTIFICATION_KINDS) as NotificationKind[]).map((kind) => ({ kind, label: NOTIFICATION_KINDS[kind].label, description: NOTIFICATION_KINDS[kind].description, inApp: by.get(kind) ?? true })) };
  }

  r.get("/notification-preferences", async (c) => c.json(await withContext(db, wctx(c), (tx) => prefs(tx, wctx(c).workspaceId, wctx(c).userId))));

  r.patch("/notification-preferences", async (c) => {
    const b = await body(c, UpdatePreferencesBody);
    if (!b.ok) return b.res;
    const { workspaceId, userId } = wctx(c);
    return c.json(
      await withContext(db, wctx(c), async (tx) => {
        for (const p of b.data.preferences) {
          await tx
            .insert(schema.notificationPreferences)
            .values({ workspaceId, userId, kind: p.kind, inApp: p.inApp })
            .onConflictDoUpdate({ target: [schema.notificationPreferences.workspaceId, schema.notificationPreferences.userId, schema.notificationPreferences.kind], set: { inApp: p.inApp, updatedAt: sql`now()` } });
        }
        return prefs(tx, workspaceId, userId);
      }),
    );
  });

  return r;
}
