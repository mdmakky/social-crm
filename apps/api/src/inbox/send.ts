import { Hono } from "hono";
import { sql } from "drizzle-orm";
import { DecideDeliveryBody, SendMessageBody, type MessageDto } from "@crm/contracts";
import { can } from "@crm/core/permissions";
import { withContext, type Db, type Tx } from "@crm/db";
import { SendError } from "@crm/integrations";
import { writeAudit } from "../audit.ts";
import { pgCode } from "../routes/pipelines.ts";
import { actor, body, fail, forbidden, isUuid, wctx, type ScopedEnv } from "../routes/scope.ts";
import { loadToken, type MetaConnectDeps } from "./meta-connect.ts";

type Row = Record<string, unknown>;
const rowsOf = (r: unknown) => (r as { rows: Row[] }).rows;
const iso = (v: unknown) => (v == null ? null : new Date(v as string | Date).toISOString());

/** A message that stays in "sending" longer than this lost its process (crash, redeploy) between the claim and the answer: it becomes "unknown", never "failed" and never re-sent. */
const STUCK_AFTER = "2 minutes";

/**
 * Failure codes shown to people (the web app turns them into sentences). Only the code is stored: Meta's error text is never kept because it can echo message content.
 * Meta's own documented codes (Send API guide, 2026-11-14): 10 permissions, 100 invalid parameter, 190 token, 551 / 1545041 person not available, 613 rate limit.
 * The remaining mappings (4, 17, 368 as throttling, 200-299 as permission) follow the existing Graph classifier and are UNVERIFIED for the Send API.
 */
export function failureCodeOf(e: SendError): string {
  const c = e.code;
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
export function sendRoutes(db: Db, deps?: MetaConnectDeps) {
  const r = new Hono<ScopedEnv>();

  r.post("/conversations/:conversationId/messages", async (c) => {
    if (!can(c.get("role"), "conversation.reply", {})) return forbidden(c);
    const conversationId = c.req.param("conversationId");
    if (!isUuid(conversationId)) return fail(c, 404, "not_found");
    const b = await body(c, SendMessageBody);
    if (!b.ok) return b.res;
    if (!deps) return fail(c, 503, "not_configured", "Messaging is not set up on this server.");
    const ws = c.get("workspaceId");
    const me = c.get("userId");
    const { clientMsgId, body: text } = b.data;

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
          SELECT c.integration_account_id, a.platform, a.status, a.external_account_id, pi.external_user_id,
                 (c.last_inbound_at IS NOT NULL AND now() - c.last_inbound_at < interval '24 hours') AS in_window
          FROM conversations c
          JOIN integration_accounts a ON a.workspace_id = c.workspace_id AND a.id = c.integration_account_id
          JOIN platform_identities pi ON pi.workspace_id = c.workspace_id AND pi.id = c.identity_id AND pi.integration_account_id = c.integration_account_id
          WHERE c.workspace_id = ${ws} AND c.id = ${conversationId}`),
      )[0];
      if (!conv) return { err: fail(c, 404, "not_found") };
      if (conv.platform !== "messenger") return { err: fail(c, 422, "unsupported_channel", "Replying is only available for Facebook Messenger conversations.") };
      if (conv.status !== "connected") return { err: fail(c, 409, "account_not_connected", "This Facebook Page connection needs attention. Reconnect it in Settings > Integrations.") };
      // Standard messaging window only. No message tag (HUMAN_AGENT or other) is ever sent.
      if (!conv.in_window) return { err: fail(c, 409, "window_closed", "More than 24 hours have passed since the contact last wrote, so Meta does not allow a reply.") };
      const row = rowsOf(
        await tx.execute(sql`
          INSERT INTO messages (workspace_id, conversation_id, integration_account_id, direction, delivery_state, sender_kind, sender_user_id, client_msg_id, body, attachments)
          VALUES (${ws}, ${conversationId}, ${conv.integration_account_id as string}, 'out', 'pending', 'user', ${me}, ${clientMsgId}, ${text}, '[]'::jsonb) RETURNING id`),
      )[0]!;
      // The text is not copied into the audit trail (customer conversation content).
      await writeAudit(tx, { ...actor(c), workspaceId: ws, action: "message.send_requested", entityType: "message", entityId: row.id as string, summary: { conversationId, length: [...text].length } });
      return { send: { messageId: row.id as string, accountId: conv.integration_account_id as string, pageId: conv.external_account_id as string, psid: conv.external_user_id as string } };
    });
    if ("err" in prep) return prep.err;
    if ("replay" in prep) return c.json({ message: prep.replay }, 200);

    // --- 2-4. send (worker role: the application role has no access to tokens or to the sending/sent transitions) ---
    await deliver(deps, { workspaceId: ws, conversationId, text, ...prep.send }).catch(() => undefined); // whatever happened is on the row; a crash here is handled by recoverStuckSends
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

type Delivery = { workspaceId: string; conversationId: string; messageId: string; accountId: string; pageId: string; psid: string; text: string };

async function deliver(deps: MetaConnectDeps, d: Delivery): Promise<void> {
  const wctxW = { workspaceId: d.workspaceId };
  // 2. claim + persist the attempt, committed before anything leaves the building
  const claimed = await withContext(deps.workerDb, wctxW, async (tx) => {
    const got = rowsOf(await tx.execute(sql`UPDATE messages SET delivery_state = 'sending' WHERE workspace_id = ${d.workspaceId} AND id = ${d.messageId} AND delivery_state = 'pending' RETURNING id`));
    if (got.length === 0) return null; // someone else owns it: never two senders for one message
    const token = await loadToken(tx, deps, d.workspaceId, d.accountId);
    const summary = JSON.stringify({ kind: "text", messagingType: "RESPONSE", length: [...d.text].length });
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
  let result: { messageId: string } | SendError;
  try {
    result = await deps.graph.sendText(d.pageId, claimed.token, d.psid, d.text);
  } catch (e) {
    result = e instanceof SendError ? e : new SendError("ambiguous", null, null, null);
  }

  // 4. record the result. If this write itself fails the row stays `sending` and recoverStuckSends makes it `unknown`.
  await withContext(deps.workerDb, wctxW, async (tx) => {
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

async function finish(tx: Tx, d: Delivery, attemptId: string, o: { outcome: "accepted" | "rejected" | "ambiguous"; status: number | null; platformCode: string | null; state?: "failed" | "unknown"; failureCode?: string }) {
  if (o.state) await tx.execute(sql`UPDATE messages SET delivery_state = ${o.state}, failure_code = ${o.failureCode!} WHERE workspace_id = ${d.workspaceId} AND id = ${d.messageId} AND delivery_state = 'sending'`);
  await tx.execute(sql`UPDATE outbound_attempts SET finished_at = now(), http_status = ${o.status}, platform_error_code = ${o.platformCode}, outcome = ${o.outcome} WHERE workspace_id = ${d.workspaceId} AND id = ${attemptId} AND outcome IS NULL`);
}

/**
 * Moves messages that sat in `sending` for 2+ minutes to `unknown` (the process died after claiming them). They are NEVER retried: a person decides after 10 minutes, or the echo webhook proves delivery.
 * ponytail: walks the connected accounts' workspaces (the worker role cannot see messages across workspaces); fine for tens of workspaces, move to a SECURITY DEFINER function if it grows.
 */
export async function recoverStuckSends(workerDb: Db): Promise<number> {
  const ws = rowsOf(await workerDb.execute(sql`SELECT DISTINCT workspace_id FROM integration_accounts WHERE platform = 'messenger' AND status <> 'disabled' LIMIT 500`));
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
