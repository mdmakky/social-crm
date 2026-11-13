import { Hono } from "hono";
import { and, asc, count, eq, isNull, or, sql } from "drizzle-orm";
import { CreateCustomFieldBody, CreateStageBody, CreateTagBody, CreateViewBody, ReorderStagesBody, UpdateCustomFieldBody, UpdateStageBody, UpdateTagBody, UpdateViewBody, type SavedView } from "@crm/contracts";
import { can } from "@crm/core/permissions";
import { schema, withContext, type Db } from "@crm/db";
import { writeAudit } from "../audit.ts";
import { ensureDefaultStages } from "../crm-service.ts";
import { actor, body, fail, forbidden, isUuid, wctx, type ScopedEnv } from "./scope.ts";


const stageDto = (s: typeof schema.lifecycleStages.$inferSelect, n: number) => ({ id: s.id, name: s.name, position: s.position, archived: !!s.archivedAt, contactCount: n });

export function crmConfigRoutes(db: Db) {
  const r = new Hono<ScopedEnv>();

  // ----- lifecycle stages -----
  async function listStages(tx: Parameters<Parameters<typeof withContext>[2]>[0], workspaceId: string) {
    const rows = await tx.select().from(schema.lifecycleStages).where(eq(schema.lifecycleStages.workspaceId, workspaceId)).orderBy(asc(schema.lifecycleStages.position));
    const counts = await tx.select({ id: schema.contacts.lifecycleStageId, n: count() }).from(schema.contacts).where(and(eq(schema.contacts.workspaceId, workspaceId), isNull(schema.contacts.deletedAt))).groupBy(schema.contacts.lifecycleStageId);
    const by = new Map(counts.map((c) => [c.id, c.n]));
    return rows.map((s) => stageDto(s, by.get(s.id) ?? 0));
  }

  r.get("/lifecycle-stages", async (c) => {
    const { workspaceId } = wctx(c);
    const canSeed = can(c.get("role"), "schema.manage", {});
    return c.json(await withContext(db, wctx(c), async (tx) => {
      if (canSeed) await ensureDefaultStages(tx, workspaceId); // older workspaces get the defaults on first visit by an admin
      return listStages(tx, workspaceId);
    }));
  });

  r.post("/lifecycle-stages", async (c) => {
    if (!can(c.get("role"), "schema.manage", {})) return forbidden(c);
    const b = await body(c, CreateStageBody);
    if (!b.ok) return b.res;
    const { workspaceId } = wctx(c);
    return withContext(db, wctx(c), async (tx) => {
      const existing = await tx.select().from(schema.lifecycleStages).where(eq(schema.lifecycleStages.workspaceId, workspaceId));
      if (existing.some((s) => s.name.toLowerCase() === b.data.name.toLowerCase() && !s.archivedAt)) return fail(c, 409, "name_taken", "A stage with that name already exists.");
      const [row] = await tx.insert(schema.lifecycleStages).values({ workspaceId, name: b.data.name, position: Math.max(-1, ...existing.map((s) => s.position)) + 1 }).returning();
      await writeAudit(tx, { ...actor(c), workspaceId, action: "lifecycle_stage.created", entityType: "lifecycle_stage", entityId: row!.id, summary: { name: row!.name } });
      return c.json(stageDto(row!, 0), 201);
    });
  });

  r.patch("/lifecycle-stages/:stageId", async (c) => {
    if (!can(c.get("role"), "schema.manage", {})) return forbidden(c);
    const id = c.req.param("stageId");
    if (!isUuid(id)) return fail(c, 404, "not_found");
    const b = await body(c, UpdateStageBody);
    if (!b.ok) return b.res;
    const { workspaceId } = wctx(c);
    return withContext(db, wctx(c), async (tx) => {
      const all = await tx.select().from(schema.lifecycleStages).where(eq(schema.lifecycleStages.workspaceId, workspaceId));
      const stage = all.find((s) => s.id === id);
      if (!stage) return fail(c, 404, "not_found");
      const patch: Partial<typeof schema.lifecycleStages.$inferInsert> = {};
      if (b.data.name !== undefined) {
        if (all.some((s) => s.id !== id && !s.archivedAt && s.name.toLowerCase() === b.data.name!.toLowerCase())) return fail(c, 409, "name_taken", "A stage with that name already exists.");
        patch.name = b.data.name;
      }
      if (b.data.archived !== undefined) {
        if (b.data.archived && !stage.archivedAt && all.filter((s) => !s.archivedAt).length <= 1) return fail(c, 409, "last_stage", "A workspace needs at least one active lifecycle stage.");
        patch.archivedAt = b.data.archived ? new Date() : null;
      }
      await tx.update(schema.lifecycleStages).set(patch).where(and(eq(schema.lifecycleStages.workspaceId, workspaceId), eq(schema.lifecycleStages.id, id)));
      await writeAudit(tx, { ...actor(c), workspaceId, action: b.data.archived === undefined ? "lifecycle_stage.renamed" : b.data.archived ? "lifecycle_stage.archived" : "lifecycle_stage.restored", entityType: "lifecycle_stage", entityId: id, summary: { name: patch.name ?? stage.name } });
      return c.json((await listStages(tx, workspaceId)).find((s) => s.id === id)!);
    });
  });

  r.post("/lifecycle-stages/reorder", async (c) => {
    if (!can(c.get("role"), "schema.manage", {})) return forbidden(c);
    const b = await body(c, ReorderStagesBody);
    if (!b.ok) return b.res;
    const { workspaceId } = wctx(c);
    return withContext(db, wctx(c), async (tx) => {
      const all = await tx.select().from(schema.lifecycleStages).where(eq(schema.lifecycleStages.workspaceId, workspaceId));
      const ids = new Set(all.map((s) => s.id));
      if (new Set(b.data.ids).size !== b.data.ids.length || b.data.ids.some((i) => !ids.has(i)) || b.data.ids.length !== all.length) return fail(c, 400, "invalid_order", "Send every stage exactly once.");
      for (const [position, id] of b.data.ids.entries()) await tx.update(schema.lifecycleStages).set({ position }).where(and(eq(schema.lifecycleStages.workspaceId, workspaceId), eq(schema.lifecycleStages.id, id)));
      await writeAudit(tx, { ...actor(c), workspaceId, action: "lifecycle_stage.reordered", entityType: "lifecycle_stage" });
      return c.json(await listStages(tx, workspaceId));
    });
  });

  // ----- tags -----
  async function listTags(tx: Parameters<Parameters<typeof withContext>[2]>[0], workspaceId: string) {
    const rows = await tx.select().from(schema.tags).where(eq(schema.tags.workspaceId, workspaceId)).orderBy(asc(schema.tags.name));
    const counts = await tx.select({ id: schema.contactTags.tagId, n: count() }).from(schema.contactTags).where(eq(schema.contactTags.workspaceId, workspaceId)).groupBy(schema.contactTags.tagId);
    const by = new Map(counts.map((x) => [x.id, x.n]));
    return rows.map((t) => ({ id: t.id, name: t.name, color: t.color as "neutral", contactCount: by.get(t.id) ?? 0 }));
  }
  r.get("/tags", async (c) => c.json(await withContext(db, wctx(c), (tx) => listTags(tx, c.get("workspaceId")))));

  r.post("/tags", async (c) => {
    if (!can(c.get("role"), "contact.edit", {})) return forbidden(c);
    const b = await body(c, CreateTagBody);
    if (!b.ok) return b.res;
    const { workspaceId } = wctx(c);
    return withContext(db, wctx(c), async (tx) => {
      const dup = await tx.select().from(schema.tags).where(and(eq(schema.tags.workspaceId, workspaceId), sql`lower(${schema.tags.name}) = ${b.data.name.toLowerCase()}`));
      if (dup.length) return fail(c, 409, "name_taken", "A tag with that name already exists.");
      const [t] = await tx.insert(schema.tags).values({ workspaceId, name: b.data.name, color: b.data.color ?? "neutral" }).returning();
      return c.json({ id: t!.id, name: t!.name, color: t!.color as "neutral", contactCount: 0 }, 201);
    });
  });

  r.patch("/tags/:tagId", async (c) => {
    if (!can(c.get("role"), "schema.manage", {})) return forbidden(c);
    const id = c.req.param("tagId");
    if (!isUuid(id)) return fail(c, 404, "not_found");
    const b = await body(c, UpdateTagBody);
    if (!b.ok) return b.res;
    const { workspaceId } = wctx(c);
    return withContext(db, wctx(c), async (tx) => {
      if (b.data.name) {
        const dup = await tx.select().from(schema.tags).where(and(eq(schema.tags.workspaceId, workspaceId), sql`lower(${schema.tags.name}) = ${b.data.name.toLowerCase()}`, sql`${schema.tags.id} <> ${id}`));
        if (dup.length) return fail(c, 409, "name_taken", "A tag with that name already exists.");
      }
      const upd = await tx.update(schema.tags).set({ ...(b.data.name ? { name: b.data.name } : {}), ...(b.data.color ? { color: b.data.color } : {}) }).where(and(eq(schema.tags.workspaceId, workspaceId), eq(schema.tags.id, id))).returning();
      if (!upd.length) return fail(c, 404, "not_found");
      return c.json((await listTags(tx, workspaceId)).find((t) => t.id === id)!);
    });
  });

  r.delete("/tags/:tagId", async (c) => {
    if (!can(c.get("role"), "schema.manage", {})) return forbidden(c);
    const id = c.req.param("tagId");
    if (!isUuid(id)) return fail(c, 404, "not_found");
    const { workspaceId } = wctx(c);
    return withContext(db, wctx(c), async (tx) => {
      const del = await tx.delete(schema.tags).where(and(eq(schema.tags.workspaceId, workspaceId), eq(schema.tags.id, id))).returning();
      if (!del.length) return fail(c, 404, "not_found");
      await writeAudit(tx, { ...actor(c), workspaceId, action: "tag.deleted", entityType: "tag", entityId: id, summary: { name: del[0]!.name } });
      return c.body(null, 204);
    });
  });

  // ----- custom fields -----
  const fieldDto = (f: typeof schema.customFieldDefinitions.$inferSelect) => ({ id: f.id, key: f.key, label: f.label, type: f.type, options: (f.options as string[]) ?? [], required: f.required === 1, position: f.position, archived: !!f.archivedAt });

  r.get("/custom-fields", async (c) =>
    c.json(await withContext(db, wctx(c), async (tx) => (await tx.select().from(schema.customFieldDefinitions).where(eq(schema.customFieldDefinitions.workspaceId, c.get("workspaceId"))).orderBy(asc(schema.customFieldDefinitions.position), asc(schema.customFieldDefinitions.createdAt))).map(fieldDto))),
  );

  r.post("/custom-fields", async (c) => {
    if (!can(c.get("role"), "schema.manage", {})) return forbidden(c);
    const b = await body(c, CreateCustomFieldBody);
    if (!b.ok) return b.res;
    const { workspaceId } = wctx(c);
    return withContext(db, wctx(c), async (tx) => {
      const all = await tx.select().from(schema.customFieldDefinitions).where(eq(schema.customFieldDefinitions.workspaceId, workspaceId));
      if (all.some((f) => f.key === b.data.key)) return fail(c, 409, "key_taken", "A field with that key already exists.");
      const [f] = await tx.insert(schema.customFieldDefinitions).values({ workspaceId, key: b.data.key, label: b.data.label, type: b.data.type, options: b.data.options ?? [], required: b.data.required ? 1 : 0, position: all.length }).returning();
      await writeAudit(tx, { ...actor(c), workspaceId, action: "custom_field.created", entityType: "custom_field", entityId: f!.id, summary: { key: f!.key, type: f!.type } });
      return c.json(fieldDto(f!), 201);
    });
  });

  r.patch("/custom-fields/:fieldId", async (c) => {
    if (!can(c.get("role"), "schema.manage", {})) return forbidden(c);
    const id = c.req.param("fieldId");
    if (!isUuid(id)) return fail(c, 404, "not_found");
    const b = await body(c, UpdateCustomFieldBody);
    if (!b.ok) return b.res;
    const { workspaceId } = wctx(c);
    return withContext(db, wctx(c), async (tx) => {
      const [f] = await tx.select().from(schema.customFieldDefinitions).where(and(eq(schema.customFieldDefinitions.workspaceId, workspaceId), eq(schema.customFieldDefinitions.id, id)));
      if (!f) return fail(c, 404, "not_found");
      if (b.data.options && !["select", "multiselect"].includes(f.type)) return fail(c, 400, "invalid_body", "Only select fields have options.");
      const [u] = await tx.update(schema.customFieldDefinitions).set({ ...(b.data.label ? { label: b.data.label } : {}), ...(b.data.options ? { options: b.data.options } : {}), ...(b.data.required !== undefined ? { required: b.data.required ? 1 : 0 } : {}), ...(b.data.archived !== undefined ? { archivedAt: b.data.archived ? new Date() : null } : {}) }).where(and(eq(schema.customFieldDefinitions.workspaceId, workspaceId), eq(schema.customFieldDefinitions.id, id))).returning();
      await writeAudit(tx, { ...actor(c), workspaceId, action: "custom_field.updated", entityType: "custom_field", entityId: id, summary: { key: f.key, ...b.data } });
      return c.json(fieldDto(u!));
    });
  });

  // ----- saved views -----
  const viewDto = (v: typeof schema.savedViews.$inferSelect, me: string): SavedView => ({ id: v.id, name: v.name, shared: v.userId === null, mine: v.userId === me, config: v.config as SavedView["config"] });

  r.get("/views", async (c) => {
    const me = c.get("userId");
    return c.json(await withContext(db, wctx(c), async (tx) => (await tx.select().from(schema.savedViews).where(and(eq(schema.savedViews.workspaceId, c.get("workspaceId")), eq(schema.savedViews.entityType, "contact"), or(isNull(schema.savedViews.userId), eq(schema.savedViews.userId, me)))).orderBy(asc(schema.savedViews.name))).map((v) => viewDto(v, me))));
  });

  r.post("/views", async (c) => {
    const b = await body(c, CreateViewBody);
    if (!b.ok) return b.res;
    if (b.data.shared && !can(c.get("role"), "view.share", {})) return forbidden(c);
    const { workspaceId, userId } = wctx(c);
    return withContext(db, wctx(c), async (tx) => {
      const [v] = await tx.insert(schema.savedViews).values({ workspaceId, userId: b.data.shared ? null : userId, name: b.data.name, config: b.data.config }).returning();
      return c.json(viewDto(v!, userId), 201);
    });
  });

  r.patch("/views/:viewId", async (c) => {
    const id = c.req.param("viewId");
    if (!isUuid(id)) return fail(c, 404, "not_found");
    const b = await body(c, UpdateViewBody);
    if (!b.ok) return b.res;
    const { workspaceId, userId } = wctx(c);
    return withContext(db, wctx(c), async (tx) => {
      const upd = await tx.update(schema.savedViews).set({ ...(b.data.name ? { name: b.data.name } : {}), ...(b.data.config ? { config: b.data.config } : {}), updatedAt: new Date() }).where(and(eq(schema.savedViews.workspaceId, workspaceId), eq(schema.savedViews.id, id))).returning();
      if (!upd.length) return fail(c, 404, "not_found"); // not visible or not allowed: RLS hides other people's views
      return c.json(viewDto(upd[0]!, userId));
    });
  });

  r.delete("/views/:viewId", async (c) => {
    const id = c.req.param("viewId");
    if (!isUuid(id)) return fail(c, 404, "not_found");
    const { workspaceId } = wctx(c);
    return withContext(db, wctx(c), async (tx) => {
      const del = await tx.delete(schema.savedViews).where(and(eq(schema.savedViews.workspaceId, workspaceId), eq(schema.savedViews.id, id))).returning();
      return del.length ? c.body(null, 204) : fail(c, 404, "not_found");
    });
  });

  return r;
}
