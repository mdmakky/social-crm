import { Hono } from "hono";
import { sql, type SQL } from "drizzle-orm";
import { ConversationListQuery, MarkReadBody, MessageListQuery, UpdateConversationBody, type ContactMethodDto, type ConversationDetail, type ConversationItem, type MessageDto } from "@crm/contracts";
import { can } from "@crm/core/permissions";
import { withContext, type Db, type Tx } from "@crm/db";
import { writeAudit } from "../audit.ts";
import { pgCode } from "./pipelines.ts";
import { actor, body, fail, forbidden, isUuid, query, wctx, type SC, type ScopedEnv } from "./scope.ts";

type Row = Record<string, unknown>;
const rowsOf = (r: unknown) => (r as { rows: Row[] }).rows;
const iso = (v: unknown) => (v == null ? null : new Date(v as string | Date).toISOString());
const WINDOW_MS = 24 * 3_600_000;
const likeEscape = (s: string) => s.replace(/[\\%_]/g, (m) => `\\${m}`);

/** Opaque keyset cursor. shortcut: not signed (it only carries a sort key the caller could already filter on); `t` is the full-precision UTC timestamp text so microseconds survive. */
const enc = (c: { t: string | null; id: string }) => Buffer.from(JSON.stringify(c)).toString("base64url");
const dec = (s: string): { t: string | null; id: string } | null => {
  try {
    const v = JSON.parse(Buffer.from(s, "base64url").toString("utf8"));
    return (v.t === null || (typeof v.t === "string" && !Number.isNaN(Date.parse(v.t)))) && isUuid(v.id) ? { t: v.t, id: v.id } : null;
  } catch {
    return null;
  }
};

/**
 * One SELECT shape for list and detail. Unread is derived per user by conversation_unread_count (inbound messages after THIS user's cursor, migration 0018),
 * never a shared counter. ponytail: the function runs once per listed row and once per conversation for totalUnread; add a measured cache only if a workspace outgrows it.
 */
const select = (where: SQL, tail: SQL = sql``) => sql`
  SELECT c.id, c.status, c.assignee_user_id, c.last_message_at, c.last_inbound_at, c.contact_delivered_at, c.contact_read_at, c.message_seq, c.version,
         to_char(c.last_message_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_t,
         a.platform, a.display_name AS account_name, ct.id AS contact_id, ct.name AS contact_name, pi.profile_pic_url AS contact_avatar, ct.email AS contact_email, ct.phone AS contact_phone, au.name AS assignee_name,
         left(lm.body, 120) AS preview, lm.direction AS preview_direction,
         conversation_unread_count(c.id) AS unread,
         coalesce((SELECT r.last_read_seq FROM conversation_reads r WHERE r.workspace_id = c.workspace_id AND r.conversation_id = c.id AND r.user_id = (SELECT app_user_id())), 0) AS last_read_seq
  FROM conversations c
  JOIN integration_accounts a ON a.workspace_id = c.workspace_id AND a.id = c.integration_account_id
  JOIN contacts ct ON ct.workspace_id = c.workspace_id AND ct.id = c.contact_id
  LEFT JOIN platform_identities pi ON pi.workspace_id = c.workspace_id AND pi.id = c.identity_id
  LEFT JOIN "user" au ON au.id = c.assignee_user_id
  LEFT JOIN LATERAL (SELECT m.body, m.direction FROM messages m WHERE m.workspace_id = c.workspace_id AND m.conversation_id = c.id ORDER BY m.seq DESC LIMIT 1) lm ON true
  WHERE ${where} ${tail}`;

const item = (r: Row): ConversationItem => {
  const lastInbound = r.last_inbound_at ? new Date(r.last_inbound_at as string).getTime() : null;
  return {
    id: r.id as string,
    platform: r.platform as ConversationItem["platform"],
    accountName: (r.account_name as string | null) ?? null,
    contact: { id: r.contact_id as string, name: r.contact_name as string, avatarUrl: (r.contact_avatar as string | null) ?? null },
    status: r.status as ConversationItem["status"],
    assignee: r.assignee_user_id ? { userId: r.assignee_user_id as string, name: (r.assignee_name as string | null) ?? "" } : null,
    lastMessageAt: iso(r.last_message_at),
    preview: (r.preview as string | null) ?? null,
    previewDirection: (r.preview_direction as "in" | "out" | null) ?? null,
    unreadCount: Number(r.unread),
    replyWindow: lastInbound === null ? "none" : Date.now() - lastInbound < WINDOW_MS ? "open" : "closed",
    version: Number(r.version),
  };
};
const detail = (r: Row): ConversationDetail => ({
  ...item(r),
  lastInboundAt: iso(r.last_inbound_at),
  contactDeliveredAt: iso(r.contact_delivered_at),
  contactReadAt: iso(r.contact_read_at),
  lastSeq: Number(r.message_seq),
  lastReadSeq: Number(r.last_read_seq),
  contactSummary: { id: r.contact_id as string, name: r.contact_name as string, avatarUrl: (r.contact_avatar as string | null) ?? null, email: (r.contact_email as string | null) ?? null, phone: (r.contact_phone as string | null) ?? null, methods: [] },
});

const loadDetail = async (tx: Tx, workspaceId: string, id: string) => {
  const r = rowsOf(await tx.execute(select(sql`c.workspace_id = ${workspaceId} AND c.id = ${id}`)))[0];
  if (!r) return null;
  const d = detail(r);
  // Provenance of the contact's phones and emails (one small query; at most 20 rows).
  d.contactSummary.methods = rowsOf(
    await tx.execute(sql`SELECT id, kind, value, source, confidence, verified, is_primary, extracted_at, corrected_at FROM contact_methods WHERE workspace_id = ${workspaceId} AND contact_id = ${d.contactSummary.id} ORDER BY is_primary DESC, extracted_at, id LIMIT 20`),
  ).map((m) => ({ id: m.id as string, kind: m.kind as "phone" | "email", value: m.value as string, source: m.source as ContactMethodDto["source"], confidence: Number(m.confidence), verified: m.verified as boolean, isPrimary: m.is_primary as boolean, extractedAt: iso(m.extracted_at) ?? "", correctedAt: iso(m.corrected_at) }));
  return d;
};

export function conversationRoutes(db: Db) {
  const r = new Hono<ScopedEnv>();
  const view = (c: SC) => can(c.get("role"), "conversation.view", {});
  const idOf = (c: SC) => c.req.param("conversationId");

  r.get("/conversations", async (c) => {
    if (!view(c)) return forbidden(c);
    const q = query(c, ConversationListQuery);
    if (!q.ok) return q.res;
    const { workspaceId, userId } = { workspaceId: c.get("workspaceId"), userId: c.get("userId") };
    const limit = q.data.limit ?? 30;
    const conds: SQL[] = [sql`c.workspace_id = ${workspaceId}`];
    if (q.data.status) conds.push(sql`c.status = ${q.data.status}`);
    if (q.data.assignee === "me") conds.push(sql`c.assignee_user_id = ${userId}`);
    else if (q.data.assignee === "unassigned") conds.push(sql`c.assignee_user_id IS NULL`);
    else if (q.data.assignee) conds.push(sql`c.assignee_user_id = ${q.data.assignee}`);
    if (q.data.unread) conds.push(sql`conversation_unread_count(c.id) > 0`);
    if (q.data.q) conds.push(sql`ct.name ILIKE ${`%${likeEscape(q.data.q)}%`} ESCAPE '\\'`);
    if (q.data.cursor) {
      const cur = dec(q.data.cursor);
      if (!cur) return fail(c, 400, "invalid_query", "The cursor is not valid");
      // last_message_at DESC NULLS LAST, id DESC
      conds.push(
        cur.t === null
          ? sql`(c.last_message_at IS NULL AND c.id < ${cur.id})`
          : sql`(c.last_message_at < ${cur.t}::timestamptz OR (c.last_message_at = ${cur.t}::timestamptz AND c.id < ${cur.id}) OR c.last_message_at IS NULL)`,
      );
    }
    return withContext(db, wctx(c), async (tx) => {
      const rows = rowsOf(await tx.execute(select(sql.join(conds, sql` AND `), sql`ORDER BY c.last_message_at DESC NULLS LAST, c.id DESC LIMIT ${limit + 1}`)));
      const page = rows.slice(0, limit);
      const last = page[page.length - 1];
      const total = rowsOf(await tx.execute(sql`SELECT coalesce(sum(conversation_unread_count(c.id)), 0)::bigint AS n FROM conversations c WHERE c.workspace_id = ${workspaceId}`))[0]!;
      return c.json({
        items: page.map(item),
        nextCursor: rows.length > limit && last ? enc({ t: (last.cursor_t as string | null) ?? null, id: last.id as string }) : null,
        totalUnread: Number(total.n),
      });
    });
  });

  r.get("/conversations/:conversationId", async (c) => {
    if (!view(c)) return forbidden(c);
    if (!isUuid(idOf(c))) return fail(c, 404, "not_found");
    const d = await withContext(db, wctx(c), (tx) => loadDetail(tx, c.get("workspaceId"), idOf(c)!));
    return d ? c.json(d) : fail(c, 404, "not_found");
  });

  r.get("/conversations/:conversationId/messages", async (c) => {
    if (!view(c)) return forbidden(c);
    if (!isUuid(idOf(c))) return fail(c, 404, "not_found");
    const q = query(c, MessageListQuery);
    if (!q.ok) return q.res;
    const limit = q.data.limit ?? 50;
    const ws = c.get("workspaceId");
    return withContext(db, wctx(c), async (tx) => {
      if (!rowsOf(await tx.execute(sql`SELECT 1 FROM conversations WHERE workspace_id = ${ws} AND id = ${idOf(c)!}`)).length) return fail(c, 404, "not_found");
      const rows = rowsOf(
        await tx.execute(sql`
          SELECT m.id, m.seq, m.direction, m.sender_kind, su.name AS sender_name, m.body, m.attachments, m.delivery_state, m.failure_code, m.occurred_at
          FROM messages m LEFT JOIN "user" su ON su.id = m.sender_user_id
          WHERE m.workspace_id = ${ws} AND m.conversation_id = ${idOf(c)!} ${q.data.before ? sql`AND m.seq < ${q.data.before}` : sql``}
          ORDER BY m.seq DESC LIMIT ${limit + 1}`),
      );
      const items: MessageDto[] = rows
        .slice(0, limit)
        .reverse()
        .map((m) => ({
          id: m.id as string, seq: Number(m.seq), direction: m.direction as "in" | "out", senderKind: m.sender_kind as MessageDto["senderKind"], senderName: (m.sender_name as string | null) ?? null,
          body: (m.body as string | null) ?? null,
          attachments: (Array.isArray(m.attachments) ? (m.attachments as { type?: unknown; url?: unknown }[]) : []).map((a) => ({ type: typeof a.type === "string" ? a.type : "file", url: typeof a.url === "string" ? a.url : null })),
          deliveryState: m.delivery_state as MessageDto["deliveryState"], failureCode: (m.failure_code as string | null) ?? null, occurredAt: iso(m.occurred_at)!,
        }));
      return c.json({ items, hasMore: rows.length > limit });
    });
  });

  r.post("/conversations/:conversationId/read", async (c) => {
    if (!view(c)) return forbidden(c);
    if (!isUuid(idOf(c))) return fail(c, 404, "not_found");
    const b = await body(c, MarkReadBody);
    if (!b.ok) return b.res;
    const ws = c.get("workspaceId");
    return withContext(db, wctx(c), async (tx) => {
      const conv = rowsOf(await tx.execute(sql`SELECT message_seq FROM conversations WHERE workspace_id = ${ws} AND id = ${idOf(c)!}`))[0];
      if (!conv) return fail(c, 404, "not_found");
      // Clamp to the last message: the guard trigger refuses a cursor past it. message_seq only grows, so a message arriving meanwhile can never be skipped.
      const upTo = Math.min(b.data.upToSeq, Number(conv.message_seq));
      // Forward-only and concurrent-safe: GREATEST in the upsert (and again in the guard trigger); one row per (conversation, user).
      const saved = rowsOf(
        await tx.execute(sql`
          INSERT INTO conversation_reads (workspace_id, conversation_id, user_id, last_read_seq) VALUES (${ws}, ${idOf(c)!}, ${c.get("userId")}, ${upTo})
          ON CONFLICT (conversation_id, user_id) DO UPDATE SET last_read_seq = GREATEST(conversation_reads.last_read_seq, EXCLUDED.last_read_seq), updated_at = now()
          RETURNING last_read_seq`),
      )[0]!;
      const unread = rowsOf(await tx.execute(sql`SELECT conversation_unread_count(${idOf(c)!}::uuid) AS n`))[0]!;
      return c.json({ lastReadSeq: Number(saved.last_read_seq), unreadCount: Number(unread.n) });
    });
  });

  r.patch("/conversations/:conversationId", async (c) => {
    if (!view(c)) return forbidden(c);
    if (!isUuid(idOf(c))) return fail(c, 404, "not_found");
    const b = await body(c, UpdateConversationBody);
    if (!b.ok) return b.res;
    const d = b.data;
    const ws = c.get("workspaceId");
    const me = c.get("userId");
    try {
      return await withContext(db, wctx(c), async (tx) => {
        const cur = rowsOf(await tx.execute(sql`SELECT status, assignee_user_id, version FROM conversations WHERE workspace_id = ${ws} AND id = ${idOf(c)!}`))[0];
        if (!cur) return fail(c, 404, "not_found");
        if (Number(cur.version) !== d.expectedVersion) return fail(c, 409, "version_conflict", "This conversation was changed by someone else.");
        const statusChange = d.status !== undefined && d.status !== cur.status;
        const target = d.assigneeUserId; // undefined = unchanged, null = unassign
        const assignChange = target !== undefined && target !== (cur.assignee_user_id ?? null);
        // Matrix: any status change needs reply rights (owner/admin/agent); assignment follows conversation.assign, where an agent may only take it for themselves or release their own.
        if (statusChange && !can(c.get("role"), "conversation.reply", {})) return forbidden(c);
        if (assignChange) {
          const isSelf = target === me || (target === null && cur.assignee_user_id === me);
          if (!can(c.get("role"), "conversation.assign", { isSelf })) return forbidden(c);
        }
        if (!statusChange && !assignChange) return c.json(await loadDetail(tx, ws, idOf(c)!));
        const upd = rowsOf(
          await tx.execute(sql`
            UPDATE conversations SET ${statusChange ? sql`status = ${d.status!},` : sql``} ${assignChange ? sql`assignee_user_id = ${target ?? null},` : sql``} version = version + 1, updated_at = now()
            WHERE workspace_id = ${ws} AND id = ${idOf(c)!} AND version = ${d.expectedVersion} RETURNING id`),
        );
        if (!upd.length) return fail(c, 409, "version_conflict", "This conversation was changed by someone else.");
        const a = { ...actor(c), workspaceId: ws, entityType: "conversation", entityId: idOf(c)! };
        if (statusChange) await writeAudit(tx, { ...a, action: "conversation.status_changed", summary: { from: cur.status, to: d.status } });
        if (assignChange) await writeAudit(tx, { ...a, action: "conversation.assigned", summary: { from: cur.assignee_user_id ?? null, to: target ?? null } });
        return c.json(await loadDetail(tx, ws, idOf(c)!));
      });
    } catch (e) {
      if (pgCode(e) === "23503") return fail(c, 422, "invalid_assignee", "That person is not a member of this workspace.");
      throw e;
    }
  });

  return r;
}
