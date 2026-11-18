import { Hono } from "hono";
import { and, desc, eq, inArray, isNull, lt, sql } from "drizzle-orm";
import { AddContactTagBody, BulkContactStageBody, ContactListQuery, ContactOwnerCountsQuery, ContactStageCountsQuery, CreateContactBody, NoteBody, PageQuery, PutContactLeadBody, UpdateContactBody } from "@crm/contracts";
import { normalizeEmail, normalizePhone, toCsv, validateCustomValues, type BlobStore } from "@crm/core";
import { can } from "@crm/core/permissions";
import { schema, user, withContext, type Db, type Tx } from "@crm/db";
import { writeAudit } from "../audit.ts";
import { purgeContactCapi } from "../capi/enqueue.ts";
import { deleteAttachmentBlobs } from "../inbox/attachments.ts";
import { emitEvent } from "../events.ts";
import { activeMember, activeStages, customDefs, findDuplicates, loadContact, lockContactWrites, recordActivity, toDetail, toFieldDef, toSummaries } from "../crm-service.ts";
import { filters, type Q } from "../contact-query.ts";
import { firstStage, leadsFor, PRIMARY_LEAD_JOIN, Rollback, stageWhere, upsertContactLead, type FirstStage } from "../contact-lead.ts";
import { WindowCounter } from "../throttle.ts";
import { leadOps } from "./leads.ts";
import { actor, body, fail, forbidden, isUuid, query, wctx, type SC, type ScopedEnv } from "./scope.ts";

const EXPORT_LIMIT = 10_000;
const TS = (col: string) => `to_char(${col} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
const CURSOR_TS_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
const SORT_EXPR = { name: "c.name", created: "c.created_at", lastActivity: "c.last_activity_at" } as const;
const NUM_CURSOR_RE = /^-?\d{1,16}$/;
type SortName = keyof typeof SORT_EXPR | "stage" | "value";
/** stage: position of the lead's stage (a contact without a lead sits in the default pipeline's first stage); value: lead value in minor units, 0 when none. Both need PRIMARY_LEAD_JOIN. */
const sortExpr = (sort: SortName, first: FirstStage | null) => (sort === "stage" ? `coalesce(ps.position, ${Number(first?.position ?? 0)})` : sort === "value" ? "coalesce(pl.value_minor, 0)" : SORT_EXPR[sort]);

const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
const dec = (s: string): { k: string; id: string; sort: string; dir: string } | null => {
  try {
    const o = JSON.parse(Buffer.from(s, "base64url").toString("utf8"));
    return typeof o?.k === "string" && isUuid(o?.id) ? o : null;
  } catch {
    return null;
  }
};

export function contactRoutes(db: Db, hooks: { blobs?: BlobStore } = {}) {
  const r = new Hono<ScopedEnv>();

  const ops = leadOps();
  const bulkCalls = new WindowCounter(30, 60_000);

  /** Filters of the list and the stage counts. A lead join is only added when the stage filter or a stage/value sort needs it, so the plain list stays as fast as before. */
  async function listFilters(c: SC, tx: Tx, q: Q, withStage: boolean) {
    const { workspaceId, userId } = wctx(c);
    const f = filters(workspaceId, userId, q);
    if (f.error) return { error: f.error } as const;
    const sort = (q.sort as SortName) ?? "lastActivity";
    if ((sort === "value") && !can(c.get("role"), "lead.value.view", {})) return { forbidden: true } as const;
    const needJoin = withStage && (!!q.stageId || sort === "stage" || sort === "value");
    const first = needJoin || !withStage ? await firstStage(tx, workspaceId) : null;
    const where = [...f.where];
    if (withStage && q.stageId) where.push(stageWhere(String(q.stageId), first));
    return { where, needJoin, first, sort } as const;
  }

  async function page(c: SC, tx: Tx, q: Q) {
    const { workspaceId } = wctx(c);
    const lf = await listFilters(c, tx, q, true);
    if ("error" in lf) return { error: lf.error } as const;
    if ("forbidden" in lf) return { forbidden: true } as const;
    const { sort, first } = lf;
    const dir = q.dir === "asc" ? "asc" : "desc";
    const limit = Math.min(Number(q.limit ?? 25) || 25, 100);
    const expr = sortExpr(sort, first);
    const numeric = sort === "stage" || sort === "value";
    const keyExpr = sql.raw(expr);
    const keySel = sql.raw(sort === "name" ? "c.name" : numeric ? `(${expr})::text` : TS(expr));
    const from = lf.needJoin ? sql`contacts c ${PRIMARY_LEAD_JOIN}` : sql`contacts c`;
    const where = [...lf.where];
    if (q.cursor) {
      const cur = dec(String(q.cursor));
      if (!cur || cur.sort !== sort || cur.dir !== dir) return { error: "The cursor does not match this query" } as const;
      // A tampered key must be a 400, never reach a ::timestamptz or ::bigint cast (22007 -> 500).
      if (sort === "name" ? cur.k.length > 300 || cur.k.includes("\u0000") : numeric ? !NUM_CURSOR_RE.test(cur.k) : !CURSOR_TS_RE.test(cur.k) || Number.isNaN(Date.parse(cur.k))) return { error: "The cursor does not match this query" } as const;
      const cmp = sql.raw(dir === "desc" ? "<" : ">");
      where.push(sort === "name" ? sql`(${keyExpr}, c.id) ${cmp} (${cur.k}, ${cur.id}::uuid)` : numeric ? sql`(${keyExpr}, c.id) ${cmp} (${cur.k}::bigint, ${cur.id}::uuid)` : sql`(${keyExpr}, c.id) ${cmp} (${cur.k}::timestamptz, ${cur.id}::uuid)`);
    }
    const order = sql.raw(`${expr} ${dir}, c.id ${dir}`);
    const rows = (await tx.execute(sql`SELECT c.id, ${keySel} AS k FROM ${from} WHERE ${sql.join(where, sql` AND `)} ORDER BY ${order} LIMIT ${limit + 1}`)).rows as { id: string; k: string }[];
    const total = ((await tx.execute(sql`SELECT count(*)::int AS n FROM ${from} WHERE ${sql.join(lf.where, sql` AND `)}`)).rows[0] as { n: number }).n;
    const pageRows = rows.slice(0, limit);
    const full = pageRows.length ? await tx.select().from(schema.contacts).where(and(eq(schema.contacts.workspaceId, workspaceId), inArray(schema.contacts.id, pageRows.map((x) => x.id)))) : [];
    const byId = new Map(full.map((x) => [x.id, x]));
    const summaries = await toSummaries(tx, workspaceId, pageRows.map((x) => byId.get(x.id)!).filter(Boolean));
    const leads = await leadsFor(tx, c, ops, summaries.map((x) => x.id));
    const items = summaries.map((x) => ({ ...x, lead: leads.get(x.id) ?? null }));
    const last = pageRows[pageRows.length - 1];
    return { items, total, nextCursor: rows.length > limit && last ? enc({ k: last.k, id: last.id, sort, dir }) : null } as const;
  }

  r.get("/contacts", async (c) => {
    const q = query(c, ContactListQuery);
    if (!q.ok) return q.res;
    return withContext(db, wctx(c), async (tx) => {
      const res = await page(c, tx, q.data as Q);
      return "error" in res ? fail(c, 400, "invalid_query", res.error) : "forbidden" in res ? forbidden(c) : c.json(res);
    });
  });

  // ----- one contact = one lead in the UI (D260): stage counts, bulk stage, stage/value/owner of one contact. Registered before /contacts/:contactId. -----
  r.get("/contacts/stage-counts", async (c) => {
    const q = query(c, ContactStageCountsQuery);
    if (!q.ok) return q.res;
    return withContext(db, wctx(c), async (tx) => {
      const lf = await listFilters(c, tx, q.data as Q, false);
      if ("error" in lf) return fail(c, 400, "invalid_query", lf.error);
      if ("forbidden" in lf) return forbidden(c);
      // Same lateral join and same where as the list, so the numbers add up to the list's totals. No lead counts under the default pipeline's first stage.
      const rows = (await tx.execute(sql`SELECT ${lf.first ? sql`coalesce(pl.stage_id, ${lf.first.id}::uuid)` : sql`pl.stage_id`} AS stage_id, count(*)::int AS n FROM contacts c ${PRIMARY_LEAD_JOIN} WHERE ${sql.join(lf.where, sql` AND `)} GROUP BY 1`)).rows as { stage_id: string | null; n: number }[];
      return c.json({ items: rows.filter((x) => x.stage_id).map((x) => ({ stageId: x.stage_id!, count: x.n })), total: rows.reduce((t, x) => t + x.n, 0) });
    });
  });

  r.get("/contacts/owner-counts", async (c) => {
    const q = query(c, ContactOwnerCountsQuery);
    if (!q.ok) return q.res;
    return withContext(db, wctx(c), async (tx) => {
      const { workspaceId, userId } = wctx(c);
      const f = filters(workspaceId, userId, q.data as Q);
      if (f.error) return fail(c, 400, "invalid_query", f.error);
      const rows = (await tx.execute(sql`SELECT c.owner_user_id AS owner_id, count(*)::int AS n FROM contacts c WHERE ${sql.join(f.where, sql` AND `)} GROUP BY 1`)).rows as { owner_id: string | null; n: number }[];
      return c.json({ items: rows.map((x) => ({ ownerId: x.owner_id, count: x.n })) });
    });
  });

  r.post("/contacts/bulk-stage", async (c) => {
    if (!ops.writer(c)) return forbidden(c);
    if (!bulkCalls.allow(`${c.get("workspaceId")}:${c.get("userId")}`)) { c.header("Retry-After", "60"); return fail(c, 429, "rate_limited", "Too many bulk moves. Try again in a minute."); }
    const b = await body(c, BulkContactStageBody);
    if (!b.ok) return b.res;
    const results: { id: string; ok: boolean; code: string }[] = [];
    // ponytail: one transaction per contact, sequential (max 100), like /leads/bulk-stage; one shared transaction would let one bad contact undo the rest.
    for (const id of [...new Set(b.data.contactIds)]) {
      try {
        const out = await withContext(db, wctx(c), (tx) => upsertContactLead(tx, c, ops, id, { stageId: b.data.stageId, lostReasonId: b.data.lostReasonId }, true));
        results.push({ id, ok: out.ok, code: out.ok ? (out.created ? "created" : out.changed ? "ok" : "unchanged") : out.code });
      } catch (e) {
        results.push({ id, ok: false, code: e instanceof Rollback ? e.code : "internal_error" });
      }
    }
    return c.json({ results });
  });

  r.get("/contacts/:contactId/lead", async (c) => {
    const id = c.req.param("contactId");
    if (!isUuid(id)) return fail(c, 404, "not_found");
    const { workspaceId } = wctx(c);
    return withContext(db, wctx(c), async (tx) => {
      if (!(await loadContact(tx, workspaceId, id))) return fail(c, 404, "not_found");
      return c.json({ lead: (await leadsFor(tx, c, ops, [id])).get(id) ?? null });
    });
  });

  r.put("/contacts/:contactId/lead", async (c) => {
    if (!ops.writer(c)) return forbidden(c);
    const id = c.req.param("contactId");
    if (!isUuid(id)) return fail(c, 404, "not_found");
    const b = await body(c, PutContactLeadBody);
    if (!b.ok) return b.res;
    try {
      return await withContext(db, wctx(c), async (tx) => {
        const out = await upsertContactLead(tx, c, ops, id, b.data);
        return out.ok ? c.json({ lead: out.lead, created: out.created }, out.created ? 201 : 200) : fail(c, out.status, out.code, out.message, out.details);
      });
    } catch (e) {
      if (e instanceof Rollback) return fail(c, e.status, e.code, e.message || undefined, e.details);
      throw e;
    }
  });

  r.get("/contacts/export", async (c) => {
    if (!can(c.get("role"), "data.export", {})) return forbidden(c);
    const q = query(c, ContactListQuery);
    if (!q.ok) return q.res;
    const { workspaceId, userId } = wctx(c);
    return withContext(db, wctx(c), async (tx) => {
      const f = filters(workspaceId, userId, q.data as Q);
      if (f.error) return fail(c, 400, "invalid_query", f.error);
      const stageId = q.data.stageId;
      const from = stageId ? sql`contacts c ${PRIMARY_LEAD_JOIN}` : sql`contacts c`;
      if (stageId) f.where.push(stageWhere(stageId, await firstStage(tx, workspaceId)));
      const total = ((await tx.execute(sql`SELECT count(*)::int AS n FROM ${from} WHERE ${sql.join(f.where, sql` AND `)}`)).rows[0] as { n: number }).n;
      if (total > EXPORT_LIMIT) return fail(c, 413, "too_many_rows", `Export up to ${EXPORT_LIMIT} contacts at a time. Narrow the filters.`);
      const ids = ((await tx.execute(sql`SELECT c.id FROM ${from} WHERE ${sql.join(f.where, sql` AND `)} ORDER BY c.name, c.id`)).rows as { id: string }[]).map((x) => x.id);
      const rows = ids.length ? await tx.select().from(schema.contacts).where(and(eq(schema.contacts.workspaceId, workspaceId), inArray(schema.contacts.id, ids))) : [];
      const order = new Map(ids.map((id, i) => [id, i]));
      rows.sort((a, b) => order.get(a.id)! - order.get(b.id)!);
      const summaries = await toSummaries(tx, workspaceId, rows);
      const ownerIds = Array.from(new Set(summaries.map((s) => s.owner?.id).filter((x): x is string => !!x)));
      // Only current members: a former member's email is not exported.
      const ownerEmail = new Map((ownerIds.length ? await tx.select({ id: user.id, email: user.email }).from(user).innerJoin(schema.memberships, and(eq(schema.memberships.userId, user.id), eq(schema.memberships.workspaceId, workspaceId), eq(schema.memberships.status, "active"))).where(inArray(user.id, ownerIds)) : []).map((u) => [u.id, u.email]));
      const defs = await customDefs(tx, workspaceId);
      const headers = ["Name", "Email", "Phone", "Company", "Lifecycle stage", "Owner email", "Tags", "Source", "Last activity", "Created", ...defs.map((d) => d.label)];
      const data = summaries.map((s, i) => {
        const custom = (rows[i]!.custom as Record<string, unknown>) ?? {};
        return [s.name, s.email ?? "", s.phone ?? "", s.company ?? "", s.lifecycleStage.name, s.owner ? ownerEmail.get(s.owner.id) ?? "" : "", s.tags.map((t) => t.name).join("; "), s.source, s.lastActivityAt ?? "", s.createdAt, ...defs.map((d) => { const v = custom[d.key]; return v === undefined ? "" : Array.isArray(v) ? v.join("; ") : String(v); })];
      });
      await writeAudit(tx, { ...actor(c), workspaceId, action: "data.exported", entityType: "contact", summary: { count: data.length } });
      return new Response(toCsv(headers, data), { status: 200, headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": 'attachment; filename="contacts.csv"', "cache-control": "no-store" } });
    });
  });

  // ----- create -----
  r.post("/contacts", async (c) => {
    if (!can(c.get("role"), "contact.edit", {})) return forbidden(c);
    const b = await body(c, CreateContactBody);
    if (!b.ok) return b.res;
    const d = b.data;
    const { workspaceId, userId } = wctx(c);
    const email = d.email ? normalizeEmail(d.email) : null;
    const phone = d.phone ? normalizePhone(d.phone) : null;
    if (d.email && !email) return fail(c, 400, "invalid_body", "Enter a valid email address.");
    if (d.phone && !phone) return fail(c, 400, "invalid_body", "Enter a valid phone number (7 to 15 digits).");
    return withContext(db, wctx(c), async (tx) => {
      const stages = await activeStages(tx, workspaceId);
      const stageId = d.lifecycleStageId ?? stages[0]?.id;
      if (!stageId || !stages.some((s) => s.id === stageId)) return fail(c, 400, "invalid_stage", "Choose an active lifecycle stage.");
      if (d.ownerUserId && !(await activeMember(tx, workspaceId, d.ownerUserId))) return fail(c, 400, "invalid_owner", "The owner must be a member of this workspace.");
      const defs = await customDefs(tx, workspaceId);
      const custom = validateCustomValues(defs.map(toFieldDef), d.custom ?? {});
      if (!custom.ok) return fail(c, 422, "invalid_custom_fields", "Some custom fields are not valid.", custom.errors);
      if (!d.allowDuplicate) {
        await lockContactWrites(tx, workspaceId, [email && `email:${email}`, phone && `phone:${phone}`]);
        const dupes = await findDuplicates(tx, workspaceId, { email, phone });
        if (dupes.length) return fail(c, 409, "duplicate_contact", "A lead with the same email or phone already exists.", { candidates: dupes });
      }
      const tagIds = Array.from(new Set(d.tagIds ?? []));
      if (tagIds.length) {
        const found = await tx.select({ id: schema.tags.id }).from(schema.tags).where(and(eq(schema.tags.workspaceId, workspaceId), inArray(schema.tags.id, tagIds)));
        if (found.length !== tagIds.length) return fail(c, 400, "invalid_tag", "One of the tags does not exist.");
      }
      const now = new Date();
      const [row] = await tx.insert(schema.contacts).values({ workspaceId, name: d.name, email, emailNormalized: email, phone: d.phone ?? null, phoneNormalized: phone, company: d.company ?? null, ownerUserId: d.ownerUserId ?? null, lifecycleStageId: stageId, source: d.source ?? "manual", custom: custom.values, createdBy: userId, lastActivityAt: now }).returning();
      if (tagIds.length) await tx.insert(schema.contactTags).values(tagIds.map((tagId) => ({ workspaceId, contactId: row!.id, tagId })));
      await recordActivity(tx, { workspaceId, contactId: row!.id, kind: "contact.created", actorUserId: userId, data: { source: row!.source } });
      await emitEvent(tx, { workspaceId, type: "contact.created", entityType: "contact", entityId: row!.id, actorUserId: userId, payload: { source: row!.source, contactName: row!.name, lifecycleStageId: row!.lifecycleStageId, ownerUserId: row!.ownerUserId ?? null } });
      if (row!.ownerUserId) await emitEvent(tx, { workspaceId, type: "contact.owner_assigned", entityType: "contact", entityId: row!.id, actorUserId: userId, payload: { ownerUserId: row!.ownerUserId, previousOwnerUserId: null, contactName: row!.name } });
      return c.json(await toDetail(tx, workspaceId, (await loadContact(tx, workspaceId, row!.id))!), 201);
    });
  });

  r.get("/contacts/:contactId", async (c) => {
    const id = c.req.param("contactId");
    if (!isUuid(id)) return fail(c, 404, "not_found");
    const { workspaceId } = wctx(c);
    return withContext(db, wctx(c), async (tx) => {
      const row = await loadContact(tx, workspaceId, id);
      return row ? c.json(await toDetail(tx, workspaceId, row)) : fail(c, 404, "not_found");
    });
  });

  // ----- update with optimistic concurrency -----
  r.patch("/contacts/:contactId", async (c) => {
    if (!can(c.get("role"), "contact.edit", {})) return forbidden(c);
    const id = c.req.param("contactId");
    if (!isUuid(id)) return fail(c, 404, "not_found");
    const b = await body(c, UpdateContactBody);
    if (!b.ok) return b.res;
    const d = b.data;
    const { workspaceId, userId } = wctx(c);
    return withContext(db, wctx(c), async (tx) => {
      const cur = await loadContact(tx, workspaceId, id);
      if (!cur) return fail(c, 404, "not_found");
      if (cur.version !== d.expectedVersion) return fail(c, 409, "version_conflict", "This contact was changed by someone else. Review the latest version and try again.", { current: await toDetail(tx, workspaceId, cur) });

      const patch: Partial<typeof schema.contacts.$inferInsert> = {};
      const changed: string[] = [];
      const set = <K extends keyof typeof patch>(k: K, v: (typeof patch)[K], label: string, before: unknown) => { if (before !== v) { patch[k] = v; changed.push(label); } };
      if (d.name !== undefined) set("name", d.name, "name", cur.name);
      if (d.company !== undefined) set("company", d.company, "company", cur.company);
      if (d.source !== undefined) set("source", d.source, "source", cur.source);
      let emailN = cur.emailNormalized;
      let phoneN = cur.phoneNormalized;
      if (d.email !== undefined) {
        emailN = d.email ? normalizeEmail(d.email) : null;
        if (d.email && !emailN) return fail(c, 400, "invalid_body", "Enter a valid email address.");
        if (emailN !== cur.emailNormalized) { patch.email = emailN; patch.emailNormalized = emailN; changed.push("email"); }
      }
      if (d.phone !== undefined) {
        phoneN = d.phone ? normalizePhone(d.phone) : null;
        if (d.phone && !phoneN) return fail(c, 400, "invalid_body", "Enter a valid phone number (7 to 15 digits).");
        // A display-only change (formatting) is saved too; only a change of the normalized number counts for duplicate checks.
        if (phoneN !== cur.phoneNormalized || (d.phone ?? null) !== cur.phone) { patch.phone = d.phone ?? null; patch.phoneNormalized = phoneN; changed.push("phone"); }
      }
      const emailKeyChanged = patch.emailNormalized !== undefined && emailN !== cur.emailNormalized;
      const phoneKeyChanged = patch.phoneNormalized !== undefined && phoneN !== cur.phoneNormalized;
      if ((emailKeyChanged || phoneKeyChanged) && !d.allowDuplicate) {
        await lockContactWrites(tx, workspaceId, [emailKeyChanged && emailN ? `email:${emailN}` : null, phoneKeyChanged && phoneN ? `phone:${phoneN}` : null]);
        const dupes = await findDuplicates(tx, workspaceId, { email: emailKeyChanged ? emailN : null, phone: phoneKeyChanged ? phoneN : null }, id);
        if (dupes.length) return fail(c, 409, "duplicate_contact", "Another contact already has that email or phone.", { candidates: dupes });
      }
      let ownerChange: { from: string | null; to: string | null } | null = null;
      if (d.ownerUserId !== undefined && (d.ownerUserId ?? null) !== cur.ownerUserId) {
        if (d.ownerUserId && !(await activeMember(tx, workspaceId, d.ownerUserId))) return fail(c, 400, "invalid_owner", "The owner must be a member of this workspace.");
        patch.ownerUserId = d.ownerUserId ?? null;
        ownerChange = { from: cur.ownerUserId, to: d.ownerUserId ?? null };
      }
      let stageChange: { from: string; to: string } | null = null;
      if (d.lifecycleStageId !== undefined && d.lifecycleStageId !== cur.lifecycleStageId) {
        const stages = await tx.select().from(schema.lifecycleStages).where(eq(schema.lifecycleStages.workspaceId, workspaceId));
        const to = stages.find((s) => s.id === d.lifecycleStageId);
        if (!to || to.archivedAt) return fail(c, 400, "invalid_stage", "Choose an active lifecycle stage.");
        patch.lifecycleStageId = to.id;
        stageChange = { from: stages.find((s) => s.id === cur.lifecycleStageId)?.name ?? "", to: to.name };
      }
      if (d.custom !== undefined) {
        const defs = await customDefs(tx, workspaceId, { includeArchived: true });
        const active = defs.filter((x) => !x.archivedAt);
        const existing = (cur.custom as Record<string, unknown>) ?? {};
        const activeKeys = new Set(active.map((x) => x.key));
        // Only the fields in this request are validated: a stale stored value or a newly required field must not block editing something else (integrity m9).
        const removed = Object.entries(d.custom).filter(([k, v]) => (v === null || v === "") && activeKeys.has(k)).map(([k]) => k);
        const incoming = Object.fromEntries(Object.entries(d.custom).filter(([k, v]) => v !== null && v !== "" && activeKeys.has(k)));
        const check = validateCustomValues(active.map(toFieldDef), incoming, { partial: true });
        const errors: Record<string, string> = check.ok ? {} : { ...check.errors };
        for (const k of removed) { const def = active.find((x) => x.key === k)!; if (def.required === 1) errors[k] = `${def.label} is required`; }
        if (Object.keys(errors).length) return fail(c, 422, "invalid_custom_fields", "Some custom fields are not valid.", errors);
        const next: Record<string, unknown> = { ...existing };
        for (const k of removed) delete next[k];
        Object.assign(next, check.ok ? check.values : {});
        if (JSON.stringify(next) !== JSON.stringify(existing)) { patch.custom = next; changed.push("custom fields"); }
      }
      if (Object.keys(patch).length === 0) return c.json(await toDetail(tx, workspaceId, cur));
      const upd = await tx.update(schema.contacts).set({ ...patch, version: sql`${schema.contacts.version} + 1`, updatedAt: new Date() }).where(and(eq(schema.contacts.workspaceId, workspaceId), eq(schema.contacts.id, id), eq(schema.contacts.version, d.expectedVersion))).returning();
      if (!upd.length) return fail(c, 409, "version_conflict", "This contact was changed by someone else. Review the latest version and try again.");
      const names = async (ids: (string | null)[]) => { const real = ids.filter((x): x is string => !!x); const rows = real.length ? await tx.select({ id: user.id, name: user.name }).from(user).where(inArray(user.id, real)) : []; return new Map(rows.map((x) => [x.id, x.name])); };
      if (changed.length) await recordActivity(tx, { workspaceId, contactId: id, kind: "contact.updated", actorUserId: userId, data: { fields: changed } });
      if (ownerChange) { const n = await names([ownerChange.from, ownerChange.to]); await recordActivity(tx, { workspaceId, contactId: id, kind: "contact.owner_changed", actorUserId: userId, data: { from: ownerChange.from ? n.get(ownerChange.from) ?? null : null, to: ownerChange.to ? n.get(ownerChange.to) ?? null : null } }); }
      if (ownerChange?.to) await emitEvent(tx, { workspaceId, type: "contact.owner_assigned", entityType: "contact", entityId: id, actorUserId: userId, payload: { ownerUserId: ownerChange.to, previousOwnerUserId: ownerChange.from, contactName: upd[0]!.name } });
      if (stageChange) await recordActivity(tx, { workspaceId, contactId: id, kind: "contact.lifecycle_changed", actorUserId: userId, data: stageChange });
      return c.json(await toDetail(tx, workspaceId, (await loadContact(tx, workspaceId, id))!));
    });
  });

  r.delete("/contacts/:contactId", async (c) => {
    if (!can(c.get("role"), "contact.delete", {})) return forbidden(c);
    const id = c.req.param("contactId");
    if (!isUuid(id)) return fail(c, 404, "not_found");
    const { workspaceId } = wctx(c);
    let purged: string[] = [];
    const res = await withContext(db, wctx(c), async (tx) => {
      const cur = await loadContact(tx, workspaceId, id);
      if (!cur) return fail(c, 404, "not_found");
      await tx.update(schema.contacts).set({ deletedAt: new Date(), updatedAt: new Date(), version: sql`${schema.contacts.version} + 1` }).where(and(eq(schema.contacts.workspaceId, workspaceId), eq(schema.contacts.id, id)));
      await purgeContactCapi(tx, workspaceId, id);
      // Files of this contact's conversations go with the contact: rows are soft-deleted here (which also removes knowledge sources derived from them), the blobs right after the commit.
      const gone = await tx.execute(sql`UPDATE attachments SET status = 'deleted', deleted_at = now(), updated_at = now() WHERE workspace_id = ${workspaceId} AND status <> 'deleted' AND conversation_id IN (SELECT id FROM conversations WHERE workspace_id = ${workspaceId} AND contact_id = ${id}) RETURNING id`);
      purged = (gone.rows as { id: string }[]).map((x) => x.id);
      await writeAudit(tx, { ...actor(c), workspaceId, action: "contact.deleted", entityType: "contact", entityId: id, summary: { name: cur.name, attachments: purged.length } });
      return c.body(null, 204);
    });
    await deleteAttachmentBlobs(hooks.blobs, workspaceId, purged);
    return res;
  });

  // ----- tags on a contact -----
  r.post("/contacts/:contactId/tags", async (c) => {
    if (!can(c.get("role"), "contact.edit", {})) return forbidden(c);
    const id = c.req.param("contactId");
    if (!isUuid(id)) return fail(c, 404, "not_found");
    const b = await body(c, AddContactTagBody);
    if (!b.ok) return b.res;
    const { workspaceId, userId } = wctx(c);
    return withContext(db, wctx(c), async (tx) => {
      const cur = await loadContact(tx, workspaceId, id);
      if (!cur) return fail(c, 404, "not_found");
      let tag: typeof schema.tags.$inferSelect | undefined;
      if (b.data.tagId) [tag] = await tx.select().from(schema.tags).where(and(eq(schema.tags.workspaceId, workspaceId), eq(schema.tags.id, b.data.tagId)));
      else {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`tag:${workspaceId}:${b.data.name!.toLowerCase()}`}, 0))`); // parallel "add VIP" must not race to a unique violation
        [tag] = await tx.select().from(schema.tags).where(and(eq(schema.tags.workspaceId, workspaceId), sql`lower(${schema.tags.name}) = ${b.data.name!.toLowerCase()}`));
        tag ??= (await tx.insert(schema.tags).values({ workspaceId, name: b.data.name! }).returning())[0];
      }
      if (!tag) return fail(c, 404, "not_found", "That tag does not exist.");
      const ins = await tx.insert(schema.contactTags).values({ workspaceId, contactId: id, tagId: tag.id }).onConflictDoNothing().returning();
      if (ins.length) await recordActivity(tx, { workspaceId, contactId: id, kind: "contact.tag_added", actorUserId: userId, data: { tag: tag.name } });
      return c.json(await toDetail(tx, workspaceId, (await loadContact(tx, workspaceId, id))!));
    });
  });

  r.delete("/contacts/:contactId/tags/:tagId", async (c) => {
    if (!can(c.get("role"), "contact.edit", {})) return forbidden(c);
    const id = c.req.param("contactId");
    const tagId = c.req.param("tagId");
    if (!isUuid(id) || !isUuid(tagId)) return fail(c, 404, "not_found");
    const { workspaceId, userId } = wctx(c);
    return withContext(db, wctx(c), async (tx) => {
      const cur = await loadContact(tx, workspaceId, id);
      if (!cur) return fail(c, 404, "not_found");
      const [tag] = await tx.select().from(schema.tags).where(and(eq(schema.tags.workspaceId, workspaceId), eq(schema.tags.id, tagId)));
      const del = await tx.delete(schema.contactTags).where(and(eq(schema.contactTags.workspaceId, workspaceId), eq(schema.contactTags.contactId, id), eq(schema.contactTags.tagId, tagId))).returning();
      if (del.length) await recordActivity(tx, { workspaceId, contactId: id, kind: "contact.tag_removed", actorUserId: userId, data: { tag: tag?.name ?? "" } });
      return c.json(await toDetail(tx, workspaceId, (await loadContact(tx, workspaceId, id))!));
    });
  });

  // ----- notes -----
  const noteDto = (n: typeof schema.notes.$inferSelect, name: string) => ({ id: n.id, body: n.body, author: { id: n.authorUserId, name }, createdAt: n.createdAt.toISOString(), updatedAt: n.updatedAt.toISOString() });

  r.get("/contacts/:contactId/notes", async (c) => {
    const id = c.req.param("contactId");
    if (!isUuid(id)) return fail(c, 404, "not_found");
    const { workspaceId } = wctx(c);
    return withContext(db, wctx(c), async (tx) => {
      if (!(await loadContact(tx, workspaceId, id))) return fail(c, 404, "not_found");
      const rows = await tx.select({ n: schema.notes, name: user.name }).from(schema.notes).innerJoin(user, eq(user.id, schema.notes.authorUserId)).where(and(eq(schema.notes.workspaceId, workspaceId), eq(schema.notes.contactId, id), isNull(schema.notes.deletedAt))).orderBy(desc(schema.notes.id)).limit(200);
      return c.json(rows.map((x) => noteDto(x.n, x.name)));
    });
  });

  r.post("/contacts/:contactId/notes", async (c) => {
    if (!can(c.get("role"), "contact.edit", {})) return forbidden(c);
    const id = c.req.param("contactId");
    if (!isUuid(id)) return fail(c, 404, "not_found");
    const b = await body(c, NoteBody);
    if (!b.ok) return b.res;
    const { workspaceId, userId } = wctx(c);
    return withContext(db, wctx(c), async (tx) => {
      if (!(await loadContact(tx, workspaceId, id))) return fail(c, 404, "not_found");
      const [n] = await tx.insert(schema.notes).values({ workspaceId, contactId: id, authorUserId: userId, body: b.data.body }).returning();
      const [me] = await tx.select({ name: user.name }).from(user).where(eq(user.id, userId));
      await recordActivity(tx, { workspaceId, contactId: id, kind: "note.added", actorUserId: userId, data: { noteId: n!.id, preview: b.data.body.slice(0, 120) } });
      return c.json(noteDto(n!, me?.name ?? ""), 201);
    });
  });

  const noteWrite = async (c: SC, mode: "update" | "delete") => {
    const id = c.req.param("contactId");
    const noteId = c.req.param("noteId");
    if (!isUuid(id) || !isUuid(noteId)) return fail(c, 404, "not_found");
    const b = mode === "update" ? await body(c, NoteBody) : null;
    if (b && !b.ok) return b.res;
    const { workspaceId, userId } = wctx(c);
    return withContext(db, wctx(c), async (tx) => {
      if (!(await loadContact(tx, workspaceId, id))) return fail(c, 404, "not_found"); // a deleted contact's notes are read-only history
      const [n] = await tx.select().from(schema.notes).where(and(eq(schema.notes.workspaceId, workspaceId), eq(schema.notes.contactId, id), eq(schema.notes.id, noteId), isNull(schema.notes.deletedAt)));
      if (!n) return fail(c, 404, "not_found");
      if (!can(c.get("role"), "note.edit", { isOwn: n.authorUserId === userId })) return forbidden(c);
      // Own notes are covered by the contact timeline. Changing or removing SOMEONE ELSE'S note (owner/admin only) is a privileged action over another person's content, so it also
      // goes to the audit log, with actor and references but never the note text (decision: docs/project/decisions.md D-notes-audit).
      const byOther = n.authorUserId !== userId;
      if (byOther) await writeAudit(tx, { ...actor(c), workspaceId, action: mode === "delete" ? "note.deleted_by_other" : "note.edited_by_other", entityType: "note", entityId: noteId, summary: { contactId: id, authorUserId: n.authorUserId } });
      if (mode === "delete") {
        await tx.update(schema.notes).set({ deletedAt: new Date() }).where(and(eq(schema.notes.workspaceId, workspaceId), eq(schema.notes.id, noteId)));
        await recordActivity(tx, { workspaceId, contactId: id, kind: "note.deleted", actorUserId: userId, data: { noteId } });
        return c.body(null, 204);
      }
      const [u] = await tx.update(schema.notes).set({ body: b && b.ok ? b.data.body : n.body, updatedAt: new Date() }).where(and(eq(schema.notes.workspaceId, workspaceId), eq(schema.notes.id, noteId))).returning();
      const [author] = await tx.select({ name: user.name }).from(user).where(eq(user.id, n.authorUserId));
      return c.json(noteDto(u!, author?.name ?? ""));
    });
  };
  r.patch("/contacts/:contactId/notes/:noteId", (c) => noteWrite(c, "update"));
  r.delete("/contacts/:contactId/notes/:noteId", (c) => noteWrite(c, "delete"));

  // ----- timeline -----
  r.get("/contacts/:contactId/activity", async (c) => {
    const id = c.req.param("contactId");
    if (!isUuid(id)) return fail(c, 404, "not_found");
    const q = query(c, PageQuery);
    if (!q.ok) return q.res;
    const limit = q.data.limit ?? 30;
    const { workspaceId } = wctx(c);
    return withContext(db, wctx(c), async (tx) => {
      if (!(await loadContact(tx, workspaceId, id))) return fail(c, 404, "not_found");
      const rows = await tx
        .select({ a: schema.activities, name: user.name })
        .from(schema.activities)
        .leftJoin(user, eq(user.id, schema.activities.actorUserId))
        .where(and(eq(schema.activities.workspaceId, workspaceId), eq(schema.activities.contactId, id), q.data.cursor ? lt(schema.activities.id, q.data.cursor) : undefined))
        .orderBy(desc(schema.activities.id))
        .limit(limit + 1);
      const pageRows = rows.slice(0, limit);
      return c.json({ items: pageRows.map(({ a, name }) => ({ id: a.id, kind: a.kind, actorName: name, data: a.data as Record<string, unknown>, occurredAt: a.occurredAt.toISOString() })), nextCursor: rows.length > limit ? pageRows[pageRows.length - 1]!.a.id : null });
    });
  });

  return r;
}
