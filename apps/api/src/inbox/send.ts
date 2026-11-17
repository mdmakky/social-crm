import { Hono } from "hono";
import { sql } from "drizzle-orm";
import { DecideDeliveryBody, SendMessageBody, type MessageDto } from "@crm/contracts";
import { attachmentKey, type BlobStore } from "@crm/core";
import { can } from "@crm/core/permissions";
import { withContext, type Db, type Tx } from "@crm/db";
import { EmailSendError, newMessageId, replySubject, SendError, supportAddress } from "@crm/integrations";
import { writeAudit } from "../audit.ts";
import { pgCode } from "../routes/pipelines.ts";
import { actor, body, fail, forbidden, isUuid, wctx, type ScopedEnv } from "../routes/scope.ts";
import { loadToken, type MetaConnectDeps } from "./meta-connect.ts";
import type { EmailDeps } from "./email-connect.ts";

type Row = Record<string, unknown>;
const rowsOf = (r: unknown) => (r as { rows: Row[] }).rows;
const iso = (v: unknown) => (v == null ? null : new Date(v as string | Date).toISOString());

/** A message that stays in "sending" longer than this lost its process (crash, redeploy) between the claim and the answer: it becomes "unknown", never "failed" and never re-sent. */
/** Instagram send API text limit (send-message page, 2026-11-14). */
export const IG_MAX_BYTES = 1000;
const STUCK_AFTER = "2 minutes";

/**
 * Failure codes shown to people (the web app turns them into sentences). Only the code is stored: Meta's error text is never kept because it can echo message content.
 * Meta's own documented codes (Send API guide, 2026-11-14): 10 permissions, 100 invalid parameter, 190 token, 551 / 1545041 person not available, 613 rate limit.
 * The remaining mappings (4, 17, 368 as throttling, 200-299 as permission) follow the existing Graph classifier and are UNVERIFIED for the Send API.
 */
export function failureCodeOf(e: SendError): string {
  const c = e.code;
  const sub = e.subcode;
  // Messenger Platform error-codes page (2026-11-14), the Instagram range 2534xxx included.
  if (c === 10 && (sub === 2534022 || sub === 2018278 || sub === 2018065)) return "window_closed"; // "sent outside of allowed window"
  if (sub === 2018108 || sub === 1545041 || sub === 2534014) return "recipient_unavailable";
  if (sub === 2534041 || sub === 2534077 || sub === 2534013 || sub === 2534029 || sub === 2018028) return "channel_access";
  if (sub === 2534037 || sub === 2018300) return "thread_owned_elsewhere";
  if (sub === 1893063 || sub === 2534040) return "rate_limited";
  if (c === 190 || e.httpStatus === 401) return "token_invalid";
  if (c === 551 || c === 1545041) return "recipient_unavailable";
  if (c === 613 || c === 4 || c === 17 || c === 368 || e.httpStatus === 429) return "rate_limited";
  if (c === 10 || (c !== null && c >= 200 && c <= 299)) return "permission_denied";
  if (c === 100) return "invalid_request";
  return c !== null ? `meta_error_${c}` : "meta_error";
}

const MSG_COLS = sql`m.id, m.seq, m.direction, m.sender_kind, su.name AS sender_name, m.body, m.attachments, m.delivery_state, m.failure_code, m.occurred_at`;
const toDto = (m: Row): MessageDto => ({
  id: m.id as string, seq: Number(m.seq), direction: m.direction as "in" | "out", senderKind: m.sender_kind as MessageDto["senderKind"], senderName: (m.sender_name as string | null) ?? null,
  body: (m.body as string | null) ?? null, attachments: [], deliveryState: m.delivery_state as MessageDto["deliveryState"], failureCode: (m.failure_code as string | null) ?? null, occurredAt: iso(m.occurred_at)!,
});
const loadMessage = async (tx: Tx, ws: string, id: string) =>
  rowsOf(await tx.execute(sql`SELECT ${MSG_COLS} FROM messages m LEFT JOIN "user" su ON su.id = m.sender_user_id WHERE m.workspace_id = ${ws} AND m.id = ${id}`))[0];

/**
 * Outbound Messenger text.
 * Order of events (each numbered step is its own transaction, so a crash leaves a truthful row behind):
 *  1. as the user: checks (role, conversation, Page, 24 hour window) and the message row in `pending`. A repeated client id returns the stored row and sends nothing.
 *  2. as the worker role: claim `pending -> sending` (exactly one claimer) and write the `outbound_attempts` row. Both are committed BEFORE the network call.
 *  3. the Send API call (no retry, ever).
 *  4. as the worker role: record the result: accepted -> `sent` (+ Meta message id), refused -> `failed`, anything we cannot be sure about -> `unknown`.
 * A process that dies after step 2 leaves `sending`; `recoverStuckSends` turns it into `unknown`. Nothing in this file sends a message a second time.
 */
export function sendRoutes(db: Db, deps?: MetaConnectDeps, blobs?: BlobStore, email?: EmailDeps) {
  const r = new Hono<ScopedEnv>();

  r.post("/conversations/:conversationId/messages", async (c) => {
    if (!can(c.get("role"), "conversation.reply", {})) return forbidden(c);
    const conversationId = c.req.param("conversationId");
    if (!isUuid(conversationId)) return fail(c, 404, "not_found");
    const b = await body(c, SendMessageBody);
    if (!b.ok) return b.res;
    if (!deps && !email) return fail(c, 503, "not_configured", "Messaging is not set up on this server.");
    const ws = c.get("workspaceId");
    const me = c.get("userId");
    const { clientMsgId, body: text } = b.data;
    const attachmentIds = b.data.attachmentIds ?? [];
    if (attachmentIds.length && !blobs) return fail(c, 503, "storage_not_configured", "File storage is not set up on this server, so files cannot be sent.");

    // --- 1. checks + pending row (user role, RLS applies) ---
    const prep = await withContext(db, wctx(c), async (tx) => {
      // Serialise concurrent submissions of the SAME client id so the loser sees the winner's row (and no sequence number is burned by a failed insert).
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`send:${ws}:${clientMsgId}`}, 0))`);
      const prior = rowsOf(await tx.execute(sql`SELECT id, conversation_id, sender_user_id FROM messages WHERE workspace_id = ${ws} AND client_msg_id = ${clientMsgId}`))[0];
      if (prior) {
        if (prior.conversation_id !== conversationId || prior.sender_user_id !== me) return { err: fail(c, 409, "client_msg_id_conflict", "This request id was already used for another message.") };
        return { replay: toDto((await loadMessage(tx, ws, prior.id as string))!) };
      }
      const conv = rowsOf(
        await tx.execute(sql`
          SELECT c.integration_account_id, a.platform, a.auth_method, a.status, a.external_account_id, pi.external_user_id,
                 (c.last_inbound_at IS NOT NULL AND now() - c.last_inbound_at < interval '24 hours') AS in_window
          FROM conversations c
          JOIN integration_accounts a ON a.workspace_id = c.workspace_id AND a.id = c.integration_account_id
          JOIN platform_identities pi ON pi.workspace_id = c.workspace_id AND pi.id = c.identity_id AND pi.integration_account_id = c.integration_account_id
          WHERE c.workspace_id = ${ws} AND c.id = ${conversationId}`),
      )[0];
      if (!conv) return { err: fail(c, 404, "not_found") };
      if (conv.platform !== "messenger" && conv.platform !== "instagram" && conv.platform !== "whatsapp" && conv.platform !== "email") return { err: fail(c, 422, "unsupported_channel", "Replying is not available for this channel.") };
      // Instagram's text limit is stated as 1,000 bytes (and, on the same page, "less than 1,000 characters"): the stricter reading is enforced. Messenger's limit is our own 2000 characters.
      if (conv.platform === "instagram" && Buffer.byteLength(text, "utf8") > IG_MAX_BYTES) return { err: fail(c, 422, "too_long", `Instagram messages can be at most ${IG_MAX_BYTES} bytes (about ${Math.floor(IG_MAX_BYTES / 3)} Bengali characters or ${IG_MAX_BYTES} English letters).`) };
      if (conv.platform === "email") {
        if (!email) return { err: fail(c, 503, "not_configured", "Email is not set up on this server.") };
        if (conv.status !== "connected") return { err: fail(c, 409, "account_not_connected", "Email is turned off. Turn it on in Settings > Channels > Integrations.") };
        if (attachmentIds.length) return { err: fail(c, 422, "unsupported_channel_media", "Sending files is not available for email yet.") };
        const to = await emailTarget(tx, ws, conversationId, conv.external_user_id as string, conv.external_account_id as string, email);
        if ("error" in to) return { err: fail(c, 422, to.error, to.message) };
        const row = rowsOf(
          await tx.execute(sql`
            INSERT INTO messages (workspace_id, conversation_id, integration_account_id, direction, delivery_state, sender_kind, sender_user_id, client_msg_id, body, attachments)
            VALUES (${ws}, ${conversationId}, ${conv.integration_account_id as string}, 'out', 'pending', 'user', ${me}, ${clientMsgId}, ${text === "" ? null : text}, '[]'::jsonb) RETURNING id`),
        )[0]!;
        await writeAudit(tx, { ...actor(c), workspaceId: ws, action: "message.send_requested", entityType: "message", entityId: row.id as string, summary: { conversationId, length: [...text].length, channel: "email" } });
        return { sendEmail: { messageId: row.id as string, accountId: conv.integration_account_id as string, token: conv.external_account_id as string, ...to } };
      }
      if (!deps) return { err: fail(c, 503, "not_configured", "Messaging is not set up on this server.") };
      if (conv.status !== "connected") return { err: fail(c, 409, "account_not_connected", conv.platform === "whatsapp" ? "This WhatsApp number needs attention. Reconnect it in Settings > Integrations." : "This Facebook Page connection needs attention. Reconnect it in Settings > Integrations.") };
      // Standard messaging window only. No message tag (HUMAN_AGENT or other) is ever sent.
      // WhatsApp: customer-service window, free-form text only inside it. Templates are out of scope (a later slice), so there is no way to reopen it from here. 422 per the slice spec; Messenger/Instagram keep 409.
      if (!conv.in_window) return { err: conv.platform === "whatsapp" ? fail(c, 422, "window_closed", "More than 24 hours have passed since the customer last wrote. WhatsApp only allows a free-form reply within 24 hours; a template message would be needed (not available yet).") : fail(c, 409, "window_closed", "More than 24 hours have passed since the contact last wrote, so Meta does not allow a reply.") };
      // A file goes out only where the channel send is implemented: WhatsApp (UNVERIFIED against the real Cloud API). Every other channel refuses; text sending is untouched.
      let media: { id: string; kind: MediaSend["kind"]; mime: string; filename: string | null } | null = null;
      if (attachmentIds.length) {
        if (conv.platform !== "whatsapp") return { err: fail(c, 422, "unsupported_channel_media", "Sending files is only available on WhatsApp for now. Send the text, or share the file another way.") };
        const a = rowsOf(await tx.execute(sql`SELECT id, kind, mime, original_filename FROM attachments WHERE workspace_id = ${ws} AND conversation_id = ${conversationId} AND id = ${attachmentIds[0]!} AND status = 'ready' AND direction = 'outbound' AND message_id IS NULL FOR UPDATE`))[0];
        if (!a) return { err: fail(c, 422, "attachment_unavailable", "That file is not available to send (it may have been sent or deleted).") };
        if (!WA_MEDIA_MIME[a.kind as MediaSend["kind"]]?.includes(a.mime as string)) return { err: fail(c, 422, "unsupported_channel_media", "WhatsApp cannot send this type of file. Images: jpeg, png. Audio: mp3, m4a, ogg. Video: mp4. Documents: pdf, docx, xlsx, pptx, txt.") };
        media = { id: a.id as string, kind: a.kind as MediaSend["kind"], mime: a.mime as string, filename: (a.original_filename as string | null) ?? null };
      }
      const row = rowsOf(
        await tx.execute(sql`
          INSERT INTO messages (workspace_id, conversation_id, integration_account_id, direction, delivery_state, sender_kind, sender_user_id, client_msg_id, body, attachments)
          VALUES (${ws}, ${conversationId}, ${conv.integration_account_id as string}, 'out', 'pending', 'user', ${me}, ${clientMsgId}, ${text === "" ? null : text}, ${JSON.stringify(media ? [{ type: media.kind === "document" ? "file" : media.kind, url: null, attachmentId: media.id }] : [])}::jsonb) RETURNING id`),
      )[0]!;
      if (media) await tx.execute(sql`UPDATE attachments SET message_id = ${row.id as string}, updated_at = now() WHERE workspace_id = ${ws} AND id = ${media.id} AND message_id IS NULL`);
      // The text is not copied into the audit trail (customer conversation content).
      await writeAudit(tx, { ...actor(c), workspaceId: ws, action: "message.send_requested", entityType: "message", entityId: row.id as string, summary: { conversationId, length: [...text].length, ...(media ? { attachmentId: media.id } : {}) } });
      return { send: { method: (conv.auth_method as string) === "unified" ? "unified" as const : "facebook" as const, channel: conv.platform as "messenger" | "instagram" | "whatsapp", messageId: row.id as string, accountId: conv.integration_account_id as string, pageId: conv.external_account_id as string, psid: conv.external_user_id as string, media } };
    });
    if ("err" in prep) return prep.err;
    if ("replay" in prep) return c.json({ message: prep.replay }, 200);
    const se = (prep as { sendEmail?: Omit<EmailDelivery, "workspaceId" | "text"> }).sendEmail;
    if (se) {
      await deliverEmail(email!, { workspaceId: ws, text, ...se }).catch(() => undefined); // whatever happened is on the row; a crash here is handled by recoverStuckSends
      const message = await withContext(db, wctx(c), async (tx) => loadMessage(tx, ws, se.messageId));
      return c.json({ message: toDto(message!) }, 201);
    }

    if (!prep.send) return fail(c, 500, "internal_error");
    // --- 2-4. send (worker role: the application role has no access to tokens or to the sending/sent transitions) ---
    await deliver(deps!, blobs, { workspaceId: ws, conversationId, text, ...prep.send }).catch(() => undefined); // whatever happened is on the row; a crash here is handled by recoverStuckSends
    const message = await withContext(db, wctx(c), async (tx) => loadMessage(tx, ws, prep.send.messageId));
    return c.json({ message: toDto(message!) }, 201);
  });

  /** A person's decision on a message that has been "unknown" for 10+ minutes (decision D-G). The database refuses it earlier and refuses every other transition for this role. */
  r.post("/conversations/:conversationId/messages/:messageId/delivery", async (c) => {
    if (!can(c.get("role"), "conversation.reply", {})) return forbidden(c);
    const conversationId = c.req.param("conversationId");
    const messageId = c.req.param("messageId");
    if (!isUuid(conversationId) || !isUuid(messageId)) return fail(c, 404, "not_found");
    const b = await body(c, DecideDeliveryBody);
    if (!b.ok) return b.res;
    const ws = c.get("workspaceId");
    try {
      return await withContext(db, wctx(c), async (tx) => {
        const m = rowsOf(await tx.execute(sql`SELECT delivery_state, now() - state_changed_at >= interval '10 minutes' AS old_enough FROM messages WHERE workspace_id = ${ws} AND conversation_id = ${conversationId} AND id = ${messageId} AND direction = 'out' FOR UPDATE`))[0];
        if (!m) return fail(c, 404, "not_found");
        if (m.delivery_state !== "unknown") return fail(c, 409, "not_unknown", "This message is not waiting for a decision.");
        if (!m.old_enough) return fail(c, 409, "too_early", "You can decide 10 minutes after the send, in case the delivery confirmation is still on its way.");
        const to = b.data.decision === "sent" ? "sent" : "failed";
        await tx.execute(sql`UPDATE messages SET delivery_state = ${to}, failure_code = ${to === "failed" ? "marked_not_sent" : null} WHERE workspace_id = ${ws} AND id = ${messageId} AND delivery_state = 'unknown'`);
        await writeAudit(tx, { ...actor(c), workspaceId: ws, action: "message.delivery_decided", entityType: "message", entityId: messageId, summary: { decision: b.data.decision } });
        return c.json({ message: toDto((await loadMessage(tx, ws, messageId))!) });
      });
    } catch (e) {
      if (pgCode(e) === "P0001") return fail(c, 409, "too_early", "You can decide 10 minutes after the send.");
      throw e;
    }
  });

  return r;
}

type MediaSend = { kind: "image" | "audio" | "video" | "document" };
/** WhatsApp's documented media types (Cloud API media page; UNVERIFIED here), intersected with what we accept as attachments. */
const WA_MEDIA_MIME: Record<MediaSend["kind"], string[]> = {
  image: ["image/jpeg", "image/png"], audio: ["audio/mpeg", "audio/mp4", "audio/ogg"], video: ["video/mp4"],
  document: ["application/pdf", "text/plain", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "application/vnd.openxmlformats-officedocument.presentationml.presentation"],
};
type Delivery = { method: "facebook" | "unified"; channel: "messenger" | "instagram" | "whatsapp"; workspaceId: string; conversationId: string; messageId: string; accountId: string; pageId: string; psid: string; text: string; media: { id: string; kind: MediaSend["kind"]; mime: string; filename: string | null } | null };

async function deliver(deps: MetaConnectDeps, blobs: BlobStore | undefined, d: Delivery): Promise<void> {
  const wctxW = { workspaceId: d.workspaceId };
  // 2. claim + persist the attempt, committed before anything leaves the building
  const claimed = await withContext(deps.workerDb, wctxW, async (tx) => {
    const got = rowsOf(await tx.execute(sql`UPDATE messages SET delivery_state = 'sending' WHERE workspace_id = ${d.workspaceId} AND id = ${d.messageId} AND delivery_state = 'pending' RETURNING id`));
    if (got.length === 0) return null; // someone else owns it: never two senders for one message
    const token = await loadToken(tx, deps, d.workspaceId, d.accountId);
    const summary = JSON.stringify({ kind: d.media ? "media" : "text", ...(d.media ? { mediaKind: d.media.kind, mime: d.media.mime } : {}), channel: d.channel, method: d.channel === "whatsapp" ? "whatsapp_cloud" : d.method, messagingType: d.channel === "messenger" ? "RESPONSE" : null, length: [...d.text].length });
    const attempt = rowsOf(await tx.execute(sql`INSERT INTO outbound_attempts (workspace_id, message_id, attempt, request_summary) VALUES (${d.workspaceId}, ${d.messageId}, 1, ${summary}::jsonb) RETURNING id`))[0]!.id as string;
    if (!token) {
      // Nothing was sent, so this is a definite failure and safe to show as such.
      await finish(tx, d, attempt, { outcome: "rejected", status: null, platformCode: "token_unavailable", state: "failed", failureCode: "token_unavailable" });
      return null;
    }
    await tx.execute(sql`UPDATE conversations SET last_message_at = GREATEST(coalesce(last_message_at, now()), now()) WHERE workspace_id = ${d.workspaceId} AND id = ${d.conversationId}`);
    return { token, attempt };
  });
  if (!claimed) return;

  // 3. the one and only network call
  let result: { messageId: string } | SendError | { localFailure: string };
  try {
    if (d.media) {
      // The file is read from the store first (no Meta contact yet): a missing file is a definite, safe-to-show failure.
      const file = await blobs!.get(attachmentKey(d.workspaceId, d.media.id)).catch(() => null);
      if (!file) result = { localFailure: "file_missing" };
      else result = await deps.graph.sendWhatsAppMedia(d.pageId, claimed.token, d.psid, { kind: d.media.kind, mime: d.media.mime, bytes: file.bytes, filename: d.media.filename, caption: d.text === "" ? null : d.text });
    } else result = await deps.graph.sendText(d.pageId, claimed.token, d.psid, d.text, d.method === "unified" ? "instagram_unified" : d.channel); // pageId holds the Instagram account id for Instagram accounts and the phone number id for WhatsApp; psid is the wa_id there
  } catch (e) {
    result = e instanceof SendError ? e : new SendError("ambiguous", null, null, null);
  }

  // 4. record the result. If this write itself fails the row stays `sending` and recoverStuckSends makes it `unknown`.
  await withContext(deps.workerDb, wctxW, async (tx) => {
    if ("localFailure" in result) {
      await finish(tx, d, claimed.attempt, { outcome: "rejected", status: null, platformCode: result.localFailure, state: "failed", failureCode: result.localFailure });
      return;
    }
    if (!(result instanceof SendError)) {
      const mid = result.messageId;
      try {
        // savepoint: the echo of this very message may already have been stored as a copy under the same Meta id (unique index); then we still record the truth
        await tx.transaction(async (sp) => {
          await sp.execute(sql`UPDATE messages SET external_id = ${mid}, delivery_state = 'sent', sent_at = now() WHERE workspace_id = ${d.workspaceId} AND id = ${d.messageId} AND delivery_state = 'sending'`);
        });
      } catch (e) {
        if (pgCode(e) !== "23505") throw e;
        await tx.execute(sql`UPDATE messages SET delivery_state = 'sent', sent_at = now() WHERE workspace_id = ${d.workspaceId} AND id = ${d.messageId} AND delivery_state = 'sending'`);
      }
      await finish(tx, d, claimed.attempt, { outcome: "accepted", status: 200, platformCode: null });
      return;
    }
    const platformCode = result.code === null ? null : `${result.code}${result.subcode === null ? "" : `/${result.subcode}`}`;
    if (result.outcome === "rejected") {
      await finish(tx, d, claimed.attempt, { outcome: "rejected", status: result.httpStatus, platformCode, state: "failed", failureCode: failureCodeOf(result) });
    } else {
      await finish(tx, d, claimed.attempt, { outcome: "ambiguous", status: result.httpStatus, platformCode, state: "unknown", failureCode: result.httpStatus === null ? "no_response" : "unreadable_response" });
    }
  });
}

async function finish(tx: Tx, d: { workspaceId: string; messageId: string }, attemptId: string, o: { outcome: "accepted" | "rejected" | "ambiguous"; status: number | null; platformCode: string | null; state?: "failed" | "unknown"; failureCode?: string }) {
  if (o.state) await tx.execute(sql`UPDATE messages SET delivery_state = ${o.state}, failure_code = ${o.failureCode!} WHERE workspace_id = ${d.workspaceId} AND id = ${d.messageId} AND delivery_state = 'sending'`);
  await tx.execute(sql`UPDATE outbound_attempts SET finished_at = now(), http_status = ${o.status}, platform_error_code = ${o.platformCode}, outcome = ${o.outcome} WHERE workspace_id = ${d.workspaceId} AND id = ${attemptId} AND outcome IS NULL`);
}

/**
 * Moves messages that sat in `sending` for 2+ minutes to `unknown` (the process died after claiming them). They are NEVER retried: a person decides after 10 minutes, or the echo webhook proves delivery.
 * ponytail: walks the connected accounts' workspaces (the worker role cannot see messages across workspaces); fine for tens of workspaces, move to a SECURITY DEFINER function if it grows.
 */
export async function recoverStuckSends(workerDb: Db): Promise<number> {
  const ws = rowsOf(await workerDb.execute(sql`SELECT DISTINCT workspace_id FROM integration_accounts WHERE platform IN ('messenger','instagram','whatsapp','telegram','email','web_chat') AND status <> 'disabled' LIMIT 500`));
  let n = 0;
  for (const w of ws) {
    n += await withContext(workerDb, { workspaceId: w.workspace_id as string }, async (tx) => {
      const rows = rowsOf(
        await tx.execute(sql.raw(`UPDATE messages SET delivery_state = 'unknown', failure_code = 'interrupted' WHERE direction = 'out' AND delivery_state = 'sending' AND state_changed_at < now() - interval '${STUCK_AFTER}' RETURNING id`)),
      );
      for (const m of rows) await tx.execute(sql`UPDATE outbound_attempts SET finished_at = now(), outcome = 'ambiguous', platform_error_code = 'interrupted' WHERE message_id = ${m.id as string} AND outcome IS NULL`);
      return rows.length;
    });
  }
  return n;
}

type EmailTarget = { to: string; replyTo: string; fromName: string; fromAddress: string; subject: string; inReplyTo: string | null; references: string[] };
/**
 * Works out who an email reply goes to and which headers it carries. The recipient is ALWAYS the conversation's own sender identity, never an address read from a message, so a forged From inside a thread cannot redirect a reply.
 * A sender whose SPF/DKIM did not pass has its own identity (email-unverified:) and cannot be answered: replying would send mail to whoever the forger named.
 */
async function emailTarget(tx: Tx, ws: string, conversationId: string, identity: string, token: string, email: EmailDeps): Promise<EmailTarget | { error: string; message: string }> {
  if (!identity.startsWith("email:")) return { error: "sender_unverified", message: "This sender could not be verified (their email failed the SPF/DKIM checks), so replying is turned off. Contact them another way." };
  const to = identity.slice("email:".length);
  const bad = rowsOf(await tx.execute(sql`SELECT 1 FROM contact_methods cm JOIN conversations c ON c.workspace_id = cm.workspace_id AND c.contact_id = cm.contact_id WHERE c.workspace_id = ${ws} AND c.id = ${conversationId} AND cm.kind = 'email' AND cm.value = ${to} AND cm.undeliverable_at IS NOT NULL`));
  if (bad.length) return { error: "address_undeliverable", message: "Email to this address bounced before, so it is not sent again. Update the contact's email or contact them another way." };
  const acct = rowsOf(await tx.execute(sql`SELECT from_address, display_name FROM email_accounts WHERE workspace_id = ${ws} AND inbound_token = ${token}`))[0];
  if (!acct) return { error: "email_account_missing", message: "Email is not set up for this inbox." };
  const conv = rowsOf(await tx.execute(sql`SELECT conv_token FROM email_threads WHERE workspace_id = ${ws} AND conversation_id = ${conversationId}`))[0];
  const chain = rowsOf(
    await tx.execute(sql`
      SELECT m.direction, em.header_message_id, em.subject FROM email_message_meta em JOIN messages m ON m.workspace_id = em.workspace_id AND m.id = em.message_id
      WHERE m.workspace_id = ${ws} AND m.conversation_id = ${conversationId} ORDER BY m.seq`),
  );
  const lastIn = [...chain].reverse().find((r) => r.direction === "in");
  const subject = replySubject((lastIn?.subject ?? [...chain].reverse().find((r) => r.subject)?.subject ?? null) as string | null);
  return {
    to, subject, fromName: acct.display_name as string, fromAddress: acct.from_address as string,
    replyTo: supportAddress(token, email.inboundDomain, (conv?.conv_token as string | undefined) ?? undefined),
    inReplyTo: (lastIn?.header_message_id as string | undefined) ?? null,
    references: chain.map((r) => r.header_message_id as string).slice(-20),
  };
}

type EmailDelivery = EmailTarget & { workspaceId: string; messageId: string; accountId: string; token: string; text: string };

/** Same four steps as `deliver`, through the EmailProvider port. The provider call is never inside a transaction (D72) and is never retried. MOCK unless the provider is Mailgun, and Mailgun is UNVERIFIED. */
async function deliverEmail(email: EmailDeps, d: EmailDelivery): Promise<void> {
  const w = { workspaceId: d.workspaceId };
  const headerId = newMessageId(d.token, email.sendingDomain);
  const claimed = await withContext(email.workerDb, w, async (tx) => {
    const got = rowsOf(await tx.execute(sql`UPDATE messages SET delivery_state = 'sending' WHERE workspace_id = ${d.workspaceId} AND id = ${d.messageId} AND delivery_state = 'pending' RETURNING id`));
    if (got.length === 0) return null;
    const summary = JSON.stringify({ kind: "text", channel: "email", method: `email_${email.provider.name}`, length: [...d.text].length });
    const attempt = rowsOf(await tx.execute(sql`INSERT INTO outbound_attempts (workspace_id, message_id, attempt, request_summary) VALUES (${d.workspaceId}, ${d.messageId}, 1, ${summary}::jsonb) RETURNING id`))[0]!.id as string;
    await tx.execute(sql`
      INSERT INTO email_message_meta (workspace_id, integration_account_id, message_id, header_message_id, in_reply_to, "references", subject, from_address, to_address)
      VALUES (${d.workspaceId}, ${d.accountId}, ${d.messageId}, ${headerId}, ${d.inReplyTo}, ${d.references}::text[], ${d.subject}, ${d.fromAddress}, ${d.to})`);
    await tx.execute(sql`UPDATE conversations SET last_message_at = GREATEST(coalesce(last_message_at, now()), now()) WHERE workspace_id = ${d.workspaceId} AND id = (SELECT conversation_id FROM messages WHERE workspace_id = ${d.workspaceId} AND id = ${d.messageId})`);
    return { attempt };
  });
  if (!claimed) return;

  let err: EmailSendError | null = null;
  try {
    await email.provider.send({ from: { name: d.fromName, address: d.fromAddress }, to: d.to, replyTo: d.replyTo, subject: d.subject, text: d.text, messageId: headerId, inReplyTo: d.inReplyTo, references: d.references, autoSubmitted: "no" });
  } catch (e) {
    err = e instanceof EmailSendError ? e : new EmailSendError("ambiguous", null, "no_response");
  }

  await withContext(email.workerDb, w, async (tx) => {
    if (!err) {
      await tx.execute(sql`UPDATE messages SET external_id = ${headerId}, delivery_state = 'sent', sent_at = now() WHERE workspace_id = ${d.workspaceId} AND id = ${d.messageId} AND delivery_state = 'sending'`);
      await finish(tx, d, claimed.attempt, { outcome: "accepted", status: 200, platformCode: null });
    } else if (err.outcome === "rejected") {
      await finish(tx, d, claimed.attempt, { outcome: "rejected", status: err.status, platformCode: err.code, state: "failed", failureCode: err.code });
    } else {
      await finish(tx, d, claimed.attempt, { outcome: "ambiguous", status: err.status, platformCode: err.code, state: "unknown", failureCode: err.code });
    }
  });
}
