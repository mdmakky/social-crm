import { randomBytes } from "node:crypto";
import { Hono } from "hono";
import { and, desc, eq, sql } from "drizzle-orm";
import { CreateChatWidgetBody, UpdateChatWidgetBody, type ChatWidgetDto } from "@crm/contracts";
import { can } from "@crm/core/permissions";
import { schema, withContext, type Db } from "@crm/db";
import { writeAudit } from "../audit.ts";
import { signPreview } from "./preview.ts";
import { actor, body, fail, forbidden, isUuid, wctx, type SC, type ScopedEnv } from "../routes/scope.ts";

type Row = typeof schema.chatWidgets.$inferSelect;
const MAX_WIDGETS = 10;
const dto = (w: Row): ChatWidgetDto => ({
  id: w.id, name: w.name, publicKey: w.publicKey, allowedOrigins: w.allowedOrigins, enabled: w.enabled, greeting: w.greeting, offlineMessage: w.offlineMessage, color: w.color,
  prechatForm: w.prechatForm, createdAt: w.createdAt.toISOString(), updatedAt: w.updatedAt.toISOString(),
  avatarUrl: w.avatarUrl, subtitle: w.subtitle, position: w.position as "left" | "right", quickReplies: w.quickReplies, awayMode: w.awayMode, awayText: w.awayText, defaultLanguage: w.defaultLanguage as "en" | "bn",
});
/** Random 15 digit number (no leading zero): the external ids of every channel are digit strings. 64 random bits reduced modulo 9e14 (bias is negligible). */
export const randomDigits = () => String(100000000000000n + (BigInt(`0x${randomBytes(8).toString("hex")}`) % 900000000000000n));
const newKey = () => randomBytes(24).toString("base64url"); // 192 bits, 32 characters
const pgCode = (e: unknown) => (e as { cause?: { code?: string } })?.cause?.code;

/**
 * Widget management for owners and admins (integration.manage). A widget owns one integration account (platform "web_chat") so the Inbox, AI, tasks and leads treat its
 * conversations like any other channel's. The account is written by the worker role (the application role cannot insert accounts), the widget row by the user.
 */
export function webChatAdminRoutes(db: Db, workerDb?: Db, previewKey?: Buffer) {
  const r = new Hono<ScopedEnv>();
  const allowed = (c: SC) => can(c.get("role"), "integration.manage", {});

  r.get("/web-chat/widgets", async (c) => {
    if (!allowed(c)) return forbidden(c);
    const ws = c.get("workspaceId");
    const rows = await withContext(db, wctx(c), (tx) => tx.select().from(schema.chatWidgets).where(eq(schema.chatWidgets.workspaceId, ws)).orderBy(desc(schema.chatWidgets.createdAt), desc(schema.chatWidgets.id)));
    return c.json({ items: rows.map(dto) });
  });

  r.post("/web-chat/widgets", async (c) => {
    if (!allowed(c)) return forbidden(c);
    const b = await body(c, CreateChatWidgetBody);
    if (!b.ok) return b.res;
    if (!workerDb) return fail(c, 503, "not_configured", "Web chat is not set up on this server.");
    const ws = c.get("workspaceId");
    const count = await withContext(db, wctx(c), async (tx) => Number((await tx.execute(sql`SELECT count(*) AS n FROM chat_widgets WHERE workspace_id = ${ws}`)).rows[0]!.n));
    if (count >= MAX_WIDGETS) return fail(c, 409, "too_many_widgets", `A workspace can have up to ${MAX_WIDGETS} chat widgets.`);
    // 1. the integration account (worker role). Its external id is a random 15 digit number: unique per platform, never shown to visitors.
    let accountId: string | null = null;
    for (let i = 0; i < 5 && !accountId; i++) {
      try {
        accountId = await withContext(workerDb, { workspaceId: ws }, async (tx) => String((await tx.execute(sql`INSERT INTO integration_accounts (workspace_id, platform, external_account_id, display_name, status, connected_by) VALUES (${ws}, 'web_chat', ${randomDigits()}, ${b.data.name}, 'connected', ${c.get("userId")}) RETURNING id`)).rows[0]!.id));
      } catch (e) {
        if (pgCode(e) !== "23505") throw e;
      }
    }
    if (!accountId) return fail(c, 500, "internal_error", "Could not create the widget. Try again.");
    // 2. the widget (user role, RLS: owner/admin only)
    const row = await withContext(db, wctx(c), async (tx) => {
      const [w] = await tx.insert(schema.chatWidgets).values({ workspaceId: ws, integrationAccountId: accountId!, publicKey: newKey(), name: b.data.name, allowedOrigins: b.data.allowedOrigins, color: b.data.color, greeting: b.data.greeting, offlineMessage: b.data.offlineMessage, prechatForm: b.data.prechatForm, avatarUrl: b.data.avatarUrl, subtitle: b.data.subtitle, position: b.data.position, quickReplies: b.data.quickReplies, awayMode: b.data.awayMode, awayText: b.data.awayText, defaultLanguage: b.data.defaultLanguage, createdBy: c.get("userId") }).returning();
      await writeAudit(tx, { ...actor(c), workspaceId: ws, action: "widget.created", entityType: "chat_widget", entityId: w!.id, summary: { name: w!.name, origins: w!.allowedOrigins.length } });
      return w!;
    });
    return c.json(dto(row), 201);
  });

  r.patch("/web-chat/widgets/:widgetId", async (c) => {
    if (!allowed(c)) return forbidden(c);
    const id = c.req.param("widgetId");
    if (!isUuid(id)) return fail(c, 404, "not_found");
    const b = await body(c, UpdateChatWidgetBody);
    if (!b.ok) return b.res;
    const ws = c.get("workspaceId");
    const d = b.data;
    const row = await withContext(db, wctx(c), async (tx) => {
      const [w] = await tx.update(schema.chatWidgets).set({ ...d, updatedAt: new Date() }).where(and(eq(schema.chatWidgets.workspaceId, ws), eq(schema.chatWidgets.id, id))).returning();
      if (!w) return null;
      if (d.name !== undefined) await tx.execute(sql`UPDATE integration_accounts SET display_name = ${w.name}, updated_at = now() WHERE workspace_id = ${ws} AND id = ${w.integrationAccountId}`);
      await writeAudit(tx, { ...actor(c), workspaceId: ws, action: "widget.updated", entityType: "chat_widget", entityId: id, summary: { fields: Object.keys(d), ...(d.enabled !== undefined ? { enabled: d.enabled } : {}) } });
      return w;
    });
    return row ? c.json(dto(row)) : fail(c, 404, "not_found");
  });

  /** A new key makes every copy of the old install snippet stop working (existing visitor sessions are tied to the widget, not the key, and keep working only for pages that load the new snippet). */
  r.post("/web-chat/widgets/:widgetId/rotate-key", async (c) => {
    if (!allowed(c)) return forbidden(c);
    const id = c.req.param("widgetId");
    if (!isUuid(id)) return fail(c, 404, "not_found");
    const ws = c.get("workspaceId");
    const row = await withContext(db, wctx(c), async (tx) => {
      const [w] = await tx.update(schema.chatWidgets).set({ publicKey: newKey(), updatedAt: new Date() }).where(and(eq(schema.chatWidgets.workspaceId, ws), eq(schema.chatWidgets.id, id))).returning();
      if (!w) return null;
      await writeAudit(tx, { ...actor(c), workspaceId: ws, action: "widget.key_rotated", entityType: "chat_widget", entityId: id });
      return w;
    });
    return row ? c.json(dto(row)) : fail(c, 404, "not_found");
  });

  /** Mints a preview grant (D270): signed, bound to this widget, workspace and user, valid 10 minutes. It only works from our own web origin; it never changes the widget's allowed sites. */
  r.post("/web-chat/widgets/:widgetId/preview", async (c) => {
    if (!allowed(c)) return forbidden(c);
    const id = c.req.param("widgetId");
    if (!isUuid(id)) return fail(c, 404, "not_found");
    if (!previewKey) return fail(c, 503, "not_configured", "Web chat is not set up on this server.");
    const ws = c.get("workspaceId");
    const w = await withContext(db, wctx(c), async (tx) => (await tx.select().from(schema.chatWidgets).where(and(eq(schema.chatWidgets.workspaceId, ws), eq(schema.chatWidgets.id, id))))[0]);
    if (!w) return fail(c, 404, "not_found");
    if (!w.enabled) return fail(c, 409, "widget_disabled", "Turn the chat on to preview it.");
    return c.json(signPreview(previewKey, { w: w.id, ws, u: c.get("userId") }));
  });

  return r;
}
