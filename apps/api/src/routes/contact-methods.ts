import { Hono } from "hono";
import { sql } from "drizzle-orm";
import { CorrectContactMethodBody, type ContactMethodDto } from "@crm/contracts";
import { can } from "@crm/core/permissions";
import { classifyPhone, normalizeEmail } from "@crm/core";
import { withContext, type Db, type Tx } from "@crm/db";
import { writeAudit } from "../audit.ts";
import { actor, body, fail, forbidden, isUuid, wctx, type SC, type ScopedEnv } from "./scope.ts";

type Row = Record<string, unknown>;
const rowsOf = (r: unknown) => (r as { rows: Row[] }).rows;
const iso = (v: unknown) => (v ? new Date(v as string).toISOString() : null);
const COLS = sql`id, kind, value, source, confidence, verified, is_primary, extracted_at, corrected_at`;
const dto = (m: Row): ContactMethodDto => ({
  id: m.id as string, kind: m.kind as "phone" | "email", value: m.value as string, source: m.source as ContactMethodDto["source"], confidence: Number(m.confidence),
  verified: m.verified as boolean, isPrimary: m.is_primary as boolean, extractedAt: iso(m.extracted_at) ?? "", correctedAt: iso(m.corrected_at),
});

/**
 * Detected phone numbers and emails of a contact (migrations 0022/0023). Reading needs contact.view; correcting or deleting needs contact.edit AND only ever touches rows that
 * were detected from a conversation and are unverified (enforced by RLS as well as here): a value a person entered or verified can never be changed through this workflow.
 * Audit entries carry kind, source and the method id, never the value.
 */
export function contactMethodRoutes(db: Db) {
  const r = new Hono<ScopedEnv>();
  const contactOf = async (tx: Tx, workspaceId: string, id: string) =>
    rowsOf(await tx.execute(sql`SELECT id, phone, phone_normalized, email, email_normalized FROM contacts WHERE workspace_id = ${workspaceId} AND id = ${id} AND deleted_at IS NULL`))[0];

  r.get("/contacts/:contactId/methods", async (c) => {
    if (!can(c.get("role"), "contact.view", {})) return forbidden(c);
    const id = c.req.param("contactId");
    if (!isUuid(id)) return fail(c, 404, "not_found");
    const { workspaceId } = wctx(c);
    return withContext(db, wctx(c), async (tx) => {
      if (!(await contactOf(tx, workspaceId, id))) return fail(c, 404, "not_found");
      const items = rowsOf(await tx.execute(sql`SELECT ${COLS} FROM contact_methods WHERE workspace_id = ${workspaceId} AND contact_id = ${id} ORDER BY kind, is_primary DESC, extracted_at, id LIMIT 100`)).map(dto);
      return c.json({ items });
    });
  });

  const load = async (c: SC, tx: Tx) => {
    const { workspaceId } = wctx(c);
    const id = c.req.param("contactId");
    const mid = c.req.param("methodId");
    if (!isUuid(id) || !isUuid(mid)) return fail(c, 404, "not_found");
    const contact = await contactOf(tx, workspaceId, id);
    if (!contact) return fail(c, 404, "not_found");
    const m = rowsOf(await tx.execute(sql`SELECT ${COLS} FROM contact_methods WHERE workspace_id = ${workspaceId} AND contact_id = ${id} AND id = ${mid}`))[0];
    if (!m) return fail(c, 404, "not_found");
    // Entered or verified values are out of reach of this workflow.
    if (m.verified || !["messenger", "instagram"].includes(m.source as string)) return fail(c, 409, "not_detected", "Only values detected from a conversation can be corrected or removed here.");
    return { contact, m, id, mid, workspaceId };
  };

  r.patch("/contacts/:contactId/methods/:methodId", async (c) => {
    if (!can(c.get("role"), "contact.edit", {})) return forbidden(c);
    const b = await body(c, CorrectContactMethodBody);
    if (!b.ok) return b.res;
    return withContext(db, wctx(c), async (tx) => {
      const l = await load(c, tx);
      if (l instanceof Response) return l;
      const kind = l.m.kind as "phone" | "email";
      const value = kind === "phone" ? classifyPhone(b.data.value)?.value : normalizeEmail(b.data.value);
      if (!value) return fail(c, 400, "invalid_value", kind === "phone" ? "Enter a Bangladeshi mobile number or an international number starting with +country code." : "Enter a valid email address.");
      if (value === l.m.value) return c.json(dto(l.m));
      const legacy = kind === "phone" ? l.contact.phone_normalized : l.contact.email_normalized;
      const sameAsEntered = legacy !== l.m.value && (kind === "phone" ? classifyPhone(String(legacy ?? ""))?.value === value : normalizeEmail(String(legacy ?? "")) === value);
      const sameAsOther = rowsOf(await tx.execute(sql`SELECT 1 FROM contact_methods WHERE workspace_id = ${l.workspaceId} AND contact_id = ${l.id} AND kind = ${kind} AND value = ${value}`)).length > 0;
      const clash = sameAsEntered || sameAsOther;
      if (clash) return fail(c, 409, "duplicate", "This contact already has that value.");
      const { userId } = wctx(c);
      const [u] = rowsOf(await tx.execute(sql`UPDATE contact_methods SET value = ${value}, raw_value = NULL, corrected_at = now(), corrected_by = ${userId}, updated_at = now() WHERE workspace_id = ${l.workspaceId} AND id = ${l.mid} RETURNING ${COLS}`));
      // If this value had been auto-filled into the contact's primary field, keep the two in step; a different, entered value is never touched.
      if (l.m.is_primary && legacy === l.m.value) {
        if (kind === "phone") await tx.execute(sql`UPDATE contacts SET phone = ${value}, phone_normalized = ${value}, version = version + 1, updated_at = now() WHERE workspace_id = ${l.workspaceId} AND id = ${l.id}`);
        else await tx.execute(sql`UPDATE contacts SET email = ${value}, email_normalized = ${value}, version = version + 1, updated_at = now() WHERE workspace_id = ${l.workspaceId} AND id = ${l.id}`);
      }
      await writeAudit(tx, { ...actor(c), workspaceId: l.workspaceId, action: "contact.method_corrected", entityType: "contact", entityId: l.id, summary: { kind, source: l.m.source, methodId: l.mid } });
      return c.json(dto(u!));
    });
  });

  r.delete("/contacts/:contactId/methods/:methodId", async (c) => {
    if (!can(c.get("role"), "contact.edit", {})) return forbidden(c);
    return withContext(db, wctx(c), async (tx) => {
      const l = await load(c, tx);
      if (l instanceof Response) return l;
      const kind = l.m.kind as "phone" | "email";
      await tx.execute(sql`DELETE FROM contact_methods WHERE workspace_id = ${l.workspaceId} AND id = ${l.mid}`);
      // Removing the wrong auto-fill clears it from the contact too, but only while the contact still shows exactly that detected value.
      const legacy = kind === "phone" ? l.contact.phone_normalized : l.contact.email_normalized;
      if (l.m.is_primary && legacy === l.m.value) {
        if (kind === "phone") await tx.execute(sql`UPDATE contacts SET phone = NULL, phone_normalized = NULL, version = version + 1, updated_at = now() WHERE workspace_id = ${l.workspaceId} AND id = ${l.id}`);
        else await tx.execute(sql`UPDATE contacts SET email = NULL, email_normalized = NULL, version = version + 1, updated_at = now() WHERE workspace_id = ${l.workspaceId} AND id = ${l.id}`);
      }
      await writeAudit(tx, { ...actor(c), workspaceId: l.workspaceId, action: "contact.method_deleted", entityType: "contact", entityId: l.id, summary: { kind, source: l.m.source, methodId: l.mid } });
      return c.body(null, 204);
    });
  });
  return r;
}
