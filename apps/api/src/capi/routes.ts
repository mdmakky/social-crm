import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { and, desc, eq, lt, sql } from "drizzle-orm";
import { CapiEventsQuery, CreateCapiDatasetBody, SetAdConsentBody, type AdConsentDto, type CapiDatasetDto, type CapiEventDto, type CapiEventList } from "@crm/contracts";
import { CONSENT_PURPOSE } from "@crm/capi";
import { can } from "@crm/core/permissions";
import { schema, withContext, type Db } from "@crm/db";
import type { SecretBox } from "@crm/integrations";
import { writeAudit } from "../audit.ts";
import { actor, body, fail, forbidden, isUuid, query, wctx, type SC, type ScopedEnv } from "../routes/scope.ts";
import { WindowCounter } from "../throttle.ts";

export type CapiRouteDeps = { box?: SecretBox; createsPerUser?: number };
const iso = (d: Date | null) => (d ? d.toISOString() : null);
const uniqueViolation = (e: unknown) => (e as { cause?: { code?: string } })?.cause?.code === "23505";

const toDataset = (r: typeof schema.capiDatasets.$inferSelect): CapiDatasetDto => ({
  id: r.id, datasetId: r.datasetId, name: r.name, mode: r.mode as CapiDatasetDto["mode"], status: r.status as CapiDatasetDto["status"], testEventCode: r.testEventCode,
  events: r.events as CapiDatasetDto["events"], tokenLast4: r.tokenLast4, createdAt: r.createdAt.toISOString(),
});
const toEvent = (r: typeof schema.capiEvents.$inferSelect): CapiEventDto => ({
  id: r.id, datasetId: r.datasetId, eventName: r.eventName as CapiEventDto["eventName"], eventId: r.eventId, eventTime: r.eventTime.toISOString(), status: r.status as CapiEventDto["status"], attempts: r.attempts,
  nextAttemptAt: r.status === "pending" ? iso(r.nextAttemptAt) : null, lastError: r.lastError, fbtraceId: r.fbtraceId, sentAt: iso(r.sentAt), createdAt: r.createdAt.toISOString(),
}); // payload and contact are deliberately not part of the DTO

/**
 * Meta Conversions API configuration and history (slice 1, mock). Permissions: capi.manage (owner, admin) configures, capi.view reads history, consent.edit records contact consent.
 * The dataset token is write-once: sealed with the account-style SecretBox (dataset id as AAD), inserted by the app role, readable only by the worker. It is never returned or logged.
 */
export function capiRoutes(db: Db, deps: CapiRouteDeps = {}) {
  const r = new Hono<ScopedEnv>();
  const creates = new WindowCounter(deps.createsPerUser ?? 10, 10 * 60_000);

  r.get("/capi/datasets", async (c) => {
    if (!can(c.get("role"), "capi.view", {})) return forbidden(c);
    const rows = await withContext(db, wctx(c), (tx) => tx.select().from(schema.capiDatasets).where(eq(schema.capiDatasets.workspaceId, c.get("workspaceId"))).orderBy(desc(schema.capiDatasets.id)));
    return c.json({ items: rows.map(toDataset) });
  });

  r.post("/capi/datasets", async (c) => {
    if (!can(c.get("role"), "capi.manage", {})) return forbidden(c);
    if (!deps.box) return fail(c, 503, "integration_not_configured", "Secret storage is not configured on this server.");
    if (!creates.allow(`${c.get("workspaceId")}:${c.get("userId")}`)) { c.header("Retry-After", "600"); return fail(c, 429, "rate_limited", "Too many attempts. Try again in a few minutes."); }
    const b = await body(c, CreateCapiDatasetBody);
    if (!b.ok) return b.res;
    const { workspaceId, userId } = wctx(c);
    const id = randomUUID();
    const sealed = deps.box.seal(b.data.accessToken, id);
    try {
      const row = await withContext(db, wctx(c), async (tx) => {
        // mode is always 'mock' in slice 1: no real send is possible until a real test event is recorded (docs/architecture/capi-architecture.md section 10).
        await tx.insert(schema.capiDatasets).values({ id, workspaceId, datasetId: b.data.datasetId, name: b.data.name, mode: "mock", testEventCode: b.data.testEventCode ?? null, events: b.data.events, tokenLast4: b.data.accessToken.slice(-4), createdBy: userId });
        await tx.insert(schema.capiDatasetSecrets).values({ workspaceId, datasetId: id, ciphertext: sealed.ciphertext, nonce: sealed.nonce, keyId: sealed.keyId });
        await writeAudit(tx, { ...actor(c), workspaceId, action: "capi.dataset.created", entityType: "capi_dataset", entityId: id, summary: { datasetId: b.data.datasetId, mode: "mock", events: b.data.events } });
        return (await tx.select().from(schema.capiDatasets).where(and(eq(schema.capiDatasets.workspaceId, workspaceId), eq(schema.capiDatasets.id, id))))[0]!;
      });
      return c.json(toDataset(row), 201);
    } catch (e) {
      if (uniqueViolation(e)) return fail(c, 409, "dataset_exists", "This dataset is already connected to this workspace.");
      throw e;
    }
  });

  r.post("/capi/datasets/:datasetId/disable", async (c) => {
    if (!can(c.get("role"), "capi.manage", {})) return forbidden(c);
    const id = c.req.param("datasetId");
    if (!isUuid(id)) return fail(c, 404, "not_found");
    const { workspaceId } = wctx(c);
    return withContext(db, wctx(c), async (tx) => {
      const [row] = await tx.update(schema.capiDatasets).set({ status: "disabled", updatedAt: new Date() }).where(and(eq(schema.capiDatasets.workspaceId, workspaceId), eq(schema.capiDatasets.id, id))).returning();
      if (!row) return fail(c, 404, "not_found");
      await writeAudit(tx, { ...actor(c), workspaceId, action: "capi.dataset.disabled", entityType: "capi_dataset", entityId: id, summary: { datasetId: row.datasetId } });
      return c.json(toDataset(row));
    });
  });

  r.get("/capi/events", async (c) => {
    if (!can(c.get("role"), "capi.view", {})) return forbidden(c);
    const q = query(c, CapiEventsQuery);
    if (!q.ok) return q.res;
    const { workspaceId } = wctx(c);
    const limit = q.data.limit ?? 50;
    const where = [eq(schema.capiEvents.workspaceId, workspaceId)];
    if (q.data.datasetId) where.push(eq(schema.capiEvents.datasetId, q.data.datasetId));
    if (q.data.status) where.push(eq(schema.capiEvents.status, q.data.status));
    if (q.data.cursor) where.push(lt(schema.capiEvents.id, q.data.cursor)); // ids are uuidv7: newest first by id
    const rows = await withContext(db, wctx(c), (tx) => tx.select().from(schema.capiEvents).where(and(...where)).orderBy(desc(schema.capiEvents.id)).limit(limit + 1));
    const page = rows.slice(0, limit);
    const out: CapiEventList = { items: page.map(toEvent), nextCursor: rows.length > limit ? page[page.length - 1]!.id : null };
    return c.json(out);
  });

  const consentOf = async (c: SC, contactId: string): Promise<AdConsentDto | null> =>
    withContext(db, wctx(c), async (tx) => {
      const [k] = await tx.select({ id: schema.contacts.id }).from(schema.contacts).where(and(eq(schema.contacts.workspaceId, c.get("workspaceId")), eq(schema.contacts.id, contactId), sql`${schema.contacts.deletedAt} IS NULL`));
      if (!k) return null;
      const rows = await tx.select().from(schema.consentRecords).where(and(eq(schema.consentRecords.workspaceId, c.get("workspaceId")), eq(schema.consentRecords.contactId, contactId), eq(schema.consentRecords.purpose, CONSENT_PURPOSE))).orderBy(desc(schema.consentRecords.id)).limit(20);
      const history = rows.map((x) => ({ status: x.status as "granted" | "revoked", source: x.source, recordedAt: x.recordedAt.toISOString(), recordedBy: x.recordedBy }));
      return history[0] ? { ...history[0], history } : { status: "none", source: null, recordedAt: null, recordedBy: null, history };
    });

  r.get("/contacts/:contactId/ad-consent", async (c) => {
    if (!can(c.get("role"), "consent.edit", {})) return forbidden(c);
    const id = c.req.param("contactId");
    if (!isUuid(id)) return fail(c, 404, "not_found");
    const out = await consentOf(c, id);
    return out ? c.json(out) : fail(c, 404, "not_found");
  });

  r.post("/contacts/:contactId/ad-consent", async (c) => {
    if (!can(c.get("role"), "consent.edit", {})) return forbidden(c);
    const id = c.req.param("contactId");
    if (!isUuid(id)) return fail(c, 404, "not_found");
    const b = await body(c, SetAdConsentBody);
    if (!b.ok) return b.res;
    const { workspaceId, userId } = wctx(c);
    const ok = await withContext(db, wctx(c), async (tx) => {
      const [k] = await tx.select({ id: schema.contacts.id }).from(schema.contacts).where(and(eq(schema.contacts.workspaceId, workspaceId), eq(schema.contacts.id, id), sql`${schema.contacts.deletedAt} IS NULL`));
      if (!k) return false;
      await tx.insert(schema.consentRecords).values({ workspaceId, contactId: id, purpose: CONSENT_PURPOSE, status: b.data.status, source: b.data.source, recordedBy: userId });
      await writeAudit(tx, { ...actor(c), workspaceId, action: `consent.ad_measurement.${b.data.status}`, entityType: "contact", entityId: id, summary: { source: b.data.source } });
      return true;
    });
    if (!ok) return fail(c, 404, "not_found");
    return c.json((await consentOf(c, id))!);
  });

  return r;
}
