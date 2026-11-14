import { sql } from "drizzle-orm";
import { classifyPhone, extractContactData, normalizeEmail, type ExtractedMethod } from "@crm/core";
import type { Tx } from "@crm/db";
import { writeAudit } from "../audit.ts";

type Row = Record<string, unknown>;
const rowsOf = (r: unknown) => (r as { rows: Row[] }).rows;

export type ExtractTarget = { workspaceId: string; platform: string; contactId: string; conversationId: string; messageId: string; text: string };

/**
 * Saves phone numbers and email addresses found in one inbound message as contact methods. Runs inside the message transaction, AFTER the message row exists, so a
 * duplicate webhook delivery (which stops before this call) never extracts twice. It is wrapped in a savepoint: any failure here rolls back only the extraction,
 * never the message. Rules: extracted data is stored unverified with its source and confidence; it never replaces a value a person entered (database trigger enforces
 * this for the worker role); the same value is stored once per contact. Audit entries carry kind, source and confidence, never the value itself.
 */
export async function saveExtracted(tx: Tx, t: ExtractTarget): Promise<number> {
  const found: ExtractedMethod[] = extractContactData(t.text);
  if (found.length === 0) return 0;
  try {
    return await tx.transaction(async (sp) => {
      const c = rowsOf(await sp.execute(sql`SELECT phone, phone_normalized, email, email_normalized FROM contacts WHERE workspace_id = ${t.workspaceId} AND id = ${t.contactId}`))[0];
      if (!c) return 0;
      const legacyPhone = classifyPhone(String(c.phone ?? c.phone_normalized ?? ""))?.value ?? null;
      let saved = 0;
      const legacyEmail = normalizeEmail(String(c.email ?? c.email_normalized ?? ""));
      let phoneEmpty = c.phone == null && c.phone_normalized == null;
      let emailEmpty = c.email == null && c.email_normalized == null;
      for (const m of found) {
        if (m.kind === "phone" && legacyPhone === m.value) continue; // already the contact's own number: the entered value stays the record
        if (m.kind === "email" && legacyEmail === m.value) continue;
        const ins = rowsOf(
          await sp.execute(sql`
            INSERT INTO contact_methods (workspace_id, contact_id, kind, value, raw_value, source, source_conversation_id, source_message_id, confidence, verified, is_primary)
            VALUES (${t.workspaceId}, ${t.contactId}, ${m.kind}, ${m.value}, ${m.raw}, ${t.platform}, ${t.conversationId}, ${t.messageId}, ${m.confidence}, false, ${m.kind === "phone" ? phoneEmpty : emailEmpty})
            ON CONFLICT (workspace_id, contact_id, kind, value) DO NOTHING
            RETURNING id`),
        )[0];
        if (!ins) continue; // seen before for this contact
        const primary = m.kind === "phone" ? phoneEmpty : emailEmpty;
        if (primary && m.kind === "phone") {
          // The first extracted number fills the contact's empty phone (guarded by the trigger and the IS NULL check) and is its primary.
          await sp.execute(sql`UPDATE contacts SET phone = ${m.value}, phone_normalized = ${m.value}, version = version + 1, updated_at = now() WHERE workspace_id = ${t.workspaceId} AND id = ${t.contactId} AND phone IS NULL AND phone_normalized IS NULL`);
          phoneEmpty = false;
        } else if (primary) {
          await sp.execute(sql`UPDATE contacts SET email = ${m.value}, email_normalized = ${m.value}, version = version + 1, updated_at = now() WHERE workspace_id = ${t.workspaceId} AND id = ${t.contactId} AND email IS NULL AND email_normalized IS NULL`);
          emailEmpty = false;
        }
        await writeAudit(sp, { workspaceId: t.workspaceId, actorUserId: null, action: "contact.method_extracted", entityType: "contact", entityId: t.contactId, summary: { kind: m.kind, source: t.platform, confidence: m.confidence, methodId: ins.id as string, primary } });
        saved++;
      }
      return saved;
    });
  } catch (e) {
    console.error(JSON.stringify({ msg: "contact extraction failed", code: (e as { cause?: { code?: string } }).cause?.code ?? "unknown" })); // code only: no message text, no values
    return 0; // extraction is best effort; the message is already safe
  }
}
