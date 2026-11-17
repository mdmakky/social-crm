import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import type { Tx } from "@crm/db";
import { randomToken, type BounceEvent, type InboundEmail } from "@crm/integrations";
import { writeAudit } from "../audit.ts";
import { saveExtracted } from "./extract.ts";

type Row = Record<string, unknown>;
const rowsOf = (r: unknown) => (r as { rows: Row[] }).rows;
export type EmailCtx = { workspaceId: string; accountId: string; accountRef: string };

/** Per conversation: more inbound mail than this in an hour is stored as ignored (a mail loop or a flood), not shown. */
export const CONVERSATION_PER_HOUR = 60;

/**
 * Applies one stored, signature-verified email event as crm_worker inside the event's transaction. Returns a short reason when the event was deliberately not turned into a message (shown as `ignored:<reason>` on the webhook row).
 * The workspace comes from the account the recipient token resolved to (process.ts); nothing in the message can choose or change it.
 * Threading, in this order and never by subject: In-Reply-To / References against Message-IDs we stored for THIS account, then the conversation token in the recipient address (also checked against this account),
 * else the sender identity. A sender whose SPF/DKIM did not pass gets its own identity, so a forged From can never reach the real customer's conversation by From alone.
 */
export async function applyEmailEvent(tx: Tx, ctx: EmailCtx, ev: InboundEmail | BounceEvent): Promise<string | null> {
  return ev.kind === "bounce" ? applyBounce(tx, ctx, ev) : applyInbound(tx, ctx, ev);
}

async function applyBounce(tx: Tx, ctx: EmailCtx, ev: BounceEvent): Promise<string | null> {
  const m = rowsOf(
    await tx.execute(sql`
      SELECT em.to_address, c.contact_id, c.id AS conversation_id FROM email_message_meta em
      JOIN messages m ON m.workspace_id = em.workspace_id AND m.id = em.message_id AND m.direction = 'out'
      JOIN conversations c ON c.workspace_id = m.workspace_id AND c.id = m.conversation_id
      WHERE em.workspace_id = ${ctx.workspaceId} AND em.integration_account_id = ${ctx.accountId} AND em.header_message_id = ${ev.messageId}`),
  )[0];
  if (!m || !m.to_address) return "unknown_message"; // the address is read from OUR stored message, never from the event
  const n = rowsOf(
    await tx.execute(sql`
      UPDATE contact_methods SET undeliverable_at = coalesce(undeliverable_at, now()), undeliverable_reason = ${ev.event}, updated_at = now()
      WHERE workspace_id = ${ctx.workspaceId} AND contact_id = ${m.contact_id as string} AND kind = 'email' AND value = ${m.to_address as string} RETURNING id`),
  );
  await writeAudit(tx, { workspaceId: ctx.workspaceId, actorUserId: null, action: "contact.email_undeliverable", entityType: "contact", entityId: m.contact_id as string, summary: { reason: ev.event, methodsMarked: n.length, conversationId: m.conversation_id as string } });
  return null;
}

async function applyInbound(tx: Tx, ctx: EmailCtx, ev: InboundEmail): Promise<string | null> {
  if (ev.ignoreReason) return ev.ignoreReason;
  const from = ev.fromAddress!; // ignoreReason "no_sender" covers null
  const acct = rowsOf(await tx.execute(sql`SELECT from_address FROM email_accounts WHERE workspace_id = ${ctx.workspaceId} AND integration_account_id = ${ctx.accountId}`))[0];
  if (acct && acct.from_address === from) return "own_address"; // our own mail looping back
  const messageId = ev.messageId || `nomid:${createHash("sha256").update(`${from}\n${ev.subject}\n${ev.timestamp}\n${ev.text}`).digest("hex").slice(0, 40)}`;
  if (rowsOf(await tx.execute(sql`SELECT 1 FROM email_message_meta WHERE integration_account_id = ${ctx.accountId} AND header_message_id = ${messageId}`)).length > 0) return "duplicate";

  // 1. In-Reply-To, then References from the newest
  let conversationId: string | null = null;
  const ids = [ev.inReplyTo, ...[...ev.references].reverse()].filter((x): x is string => !!x);
  if (ids.length) {
    const hits = rowsOf(
      await tx.execute(sql`
        SELECT em.header_message_id, m.conversation_id FROM email_message_meta em JOIN messages m ON m.workspace_id = em.workspace_id AND m.id = em.message_id
        WHERE em.workspace_id = ${ctx.workspaceId} AND em.integration_account_id = ${ctx.accountId} AND em.header_message_id IN (${sql.join(ids.map((i) => sql`${i}`), sql`, `)})`),
    );
    for (const id of ids) {
      const h = hits.find((x) => x.header_message_id === id);
      if (h) { conversationId = h.conversation_id as string; break; }
    }
  }
  // 2. the opaque conversation token of the Reply-To address (same account only)
  if (!conversationId && ev.convToken) {
    const t = rowsOf(
      await tx.execute(sql`
        SELECT t.conversation_id FROM email_threads t JOIN conversations c ON c.workspace_id = t.workspace_id AND c.id = t.conversation_id
        WHERE t.workspace_id = ${ctx.workspaceId} AND t.conv_token = ${ev.convToken} AND c.integration_account_id = ${ctx.accountId}`),
    )[0];
    if (t) conversationId = t.conversation_id as string;
  }
  // 3. the sender identity
  let contactId: string;
  if (conversationId) {
    contactId = rowsOf(await tx.execute(sql`SELECT contact_id FROM conversations WHERE workspace_id = ${ctx.workspaceId} AND id = ${conversationId}`))[0]!.contact_id as string;
  } else {
    const conv = await ensureEmailConversation(tx, ctx, ev, from);
    conversationId = conv.id;
    contactId = conv.contactId;
  }

  const recent = Number(rowsOf(await tx.execute(sql`SELECT count(*) AS n FROM messages WHERE workspace_id = ${ctx.workspaceId} AND conversation_id = ${conversationId} AND direction = 'in' AND created_at > now() - interval '1 hour'`))[0]!.n);
  if (recent >= CONVERSATION_PER_HOUR) return "conversation_rate_limited";

  const at = ev.timestamp > 0 && Math.abs(Date.now() - ev.timestamp * 1000) < 7 * 86_400_000 ? new Date(ev.timestamp * 1000).toISOString() : new Date().toISOString();
  const inserted = rowsOf(
    await tx.execute(sql`
      INSERT INTO messages (workspace_id, conversation_id, integration_account_id, direction, external_id, sender_kind, body, attachments, delivery_state, occurred_at)
      VALUES (${ctx.workspaceId}, ${conversationId}, ${ctx.accountId}, 'in', ${messageId}, 'contact', ${ev.text}, '[]'::jsonb, 'received', ${at})
      ON CONFLICT (integration_account_id, external_id) WHERE external_id IS NOT NULL DO NOTHING RETURNING id`),
  )[0];
  if (!inserted) return "duplicate";
  const named = ev.attachments.map((a) => ({ name: a.name, size: a.size }));
  while (named.length < Math.min(ev.attachmentCount, 20)) named.push({ name: "attachment", size: null });
  await tx.execute(sql`
    INSERT INTO email_message_meta (workspace_id, integration_account_id, message_id, header_message_id, in_reply_to, "references", subject, from_address, unverified_sender, attachments_skipped)
    VALUES (${ctx.workspaceId}, ${ctx.accountId}, ${inserted.id as string}, ${messageId}, ${ev.inReplyTo}, ${ev.references}::text[], ${ev.subject}, ${from}, ${!ev.senderVerified}, ${JSON.stringify(named)}::jsonb)`);
  await tx.execute(sql`
    UPDATE conversations SET last_message_at = GREATEST(coalesce(last_message_at, ${at}::timestamptz), ${at}::timestamptz), last_inbound_at = GREATEST(coalesce(last_inbound_at, ${at}::timestamptz), ${at}::timestamptz),
      status = CASE WHEN status = 'resolved' THEN 'open' ELSE status END, version = version + 1, updated_at = now()
    WHERE workspace_id = ${ctx.workspaceId} AND id = ${conversationId}`);
  await tx.execute(sql`UPDATE contacts SET last_activity_at = GREATEST(last_activity_at, ${at}::timestamptz) WHERE workspace_id = ${ctx.workspaceId} AND id = ${contactId}`);
  if (ev.hasText && ev.senderVerified) await saveExtracted(tx, { workspaceId: ctx.workspaceId, platform: "email", contactId, conversationId, messageId: inserted.id as string, text: ev.text });
  return null;
}

/** Finds or creates identity, contact and conversation for one sender. Verified senders (`email:<address>`) and unverified ones (`email-unverified:<address>`) are separate identities. */
async function ensureEmailConversation(tx: Tx, ctx: EmailCtx, ev: InboundEmail, from: string): Promise<{ id: string; contactId: string }> {
  const key = `${ev.senderVerified ? "email" : "email-unverified"}:${from}`;
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${ctx.accountId}:${key}`}, 0))`);
  const find = async () => rowsOf(await tx.execute(sql`SELECT c.id, c.contact_id FROM conversations c JOIN platform_identities i ON i.id = c.identity_id WHERE c.workspace_id = ${ctx.workspaceId} AND c.integration_account_id = ${ctx.accountId} AND i.external_user_id = ${key}`))[0];
  const existing = await find();
  if (existing) return { id: existing.id as string, contactId: existing.contact_id as string };

  let identity = rowsOf(await tx.execute(sql`SELECT id, contact_id FROM platform_identities WHERE integration_account_id = ${ctx.accountId} AND external_user_id = ${key}`))[0];
  if (!identity) {
    const stage = rowsOf(await tx.execute(sql`SELECT id FROM lifecycle_stages WHERE workspace_id = ${ctx.workspaceId} AND archived_at IS NULL ORDER BY position LIMIT 1`))[0];
    if (!stage) throw new Error("no_lifecycle_stage");
    const name = (ev.fromName || from.split("@")[0]!).slice(0, 80);
    const contact = rowsOf(await tx.execute(sql`INSERT INTO contacts (workspace_id, name, lifecycle_stage_id, source) VALUES (${ctx.workspaceId}, ${name}, ${stage.id as string}, 'email') RETURNING id`))[0]!;
    identity = rowsOf(await tx.execute(sql`INSERT INTO platform_identities (workspace_id, integration_account_id, external_user_id, contact_id) VALUES (${ctx.workspaceId}, ${ctx.accountId}, ${key}, ${contact.id as string}) RETURNING id, contact_id`))[0]!;
    if (ev.senderVerified) {
      // Only a sender that passed SPF/DKIM becomes an email contact method; it is unverified (a person has not confirmed it) and never replaces a value someone entered.
      await tx.execute(sql`
        INSERT INTO contact_methods (workspace_id, contact_id, kind, value, raw_value, source, confidence, verified, is_primary)
        VALUES (${ctx.workspaceId}, ${contact.id as string}, 'email', ${from}, NULL, 'email', 0.9, false, true) ON CONFLICT (workspace_id, contact_id, kind, value) DO NOTHING`);
      await tx.execute(sql`UPDATE contacts SET email = ${from}, email_normalized = ${from}, version = version + 1, updated_at = now() WHERE workspace_id = ${ctx.workspaceId} AND id = ${contact.id as string} AND email IS NULL AND email_normalized IS NULL`);
    }
  }
  await tx.execute(sql`INSERT INTO conversations (workspace_id, integration_account_id, identity_id, contact_id) VALUES (${ctx.workspaceId}, ${ctx.accountId}, ${identity.id as string}, ${identity.contact_id as string}) ON CONFLICT (integration_account_id, identity_id) DO NOTHING`);
  const conv = (await find())!;
  await tx.execute(sql`INSERT INTO email_threads (workspace_id, conversation_id, conv_token) VALUES (${ctx.workspaceId}, ${conv.id as string}, ${randomToken(16)}) ON CONFLICT (conversation_id) DO NOTHING`);
  return { id: conv.id as string, contactId: conv.contact_id as string };
}
