import { sql } from "drizzle-orm";
import type { Db, Tx } from "@crm/db";
import { parseMetaWebhook, type MetaEvent } from "@crm/integrations";

/** After this many failed attempts an event stays `failed` (dead letter) until an admin replays it (failed -> received). */
export const MAX_ATTEMPTS = 5;
export type Outcome = "processed" | "orphan" | "failed" | "skipped";

type Row = Record<string, unknown>;
const rowsOf = (r: unknown) => (r as { rows: Row[] }).rows;
const msToIso = (ms: number) => new Date(ms).toISOString();

class EventError extends Error {
  constructor(readonly code: string, readonly retryable = true) {
    super(code);
  }
}

/** Short, payload-free error code (never message text: it could contain customer data). */
function codeOf(err: unknown): string {
  if (err instanceof EventError) return err.code;
  const pg = (err as { cause?: { code?: string }; code?: string } | null) ?? {};
  const c = pg.cause?.code ?? pg.code;
  return c ? `pg_${c}` : "processing_error";
}

/**
 * Processes one stored webhook event as crm_worker, in ONE transaction: claim (FOR UPDATE SKIP LOCKED), route by (platform, account),
 * apply every message / receipt idempotently, mark processed. Any error rolls the whole event back; a second transaction then records the failure.
 */
export async function processWebhookEvent(db: Db, eventId: string): Promise<Outcome> {
  try {
    return await db.transaction(async (tx) => {
      const claimed = rowsOf(
        await tx.execute(sql`SELECT id, platform, account_ref, raw_body FROM webhook_events WHERE id = ${eventId} AND (status = 'received' OR (status = 'failed' AND attempts < ${MAX_ATTEMPTS})) FOR UPDATE SKIP LOCKED`),
      )[0];
      if (!claimed) return "skipped";
      const platform = claimed.platform as string;
      const accountRef = claimed.account_ref as string | null;

      const account = accountRef
        ? rowsOf(await tx.execute(sql`SELECT id, workspace_id, status FROM integration_accounts WHERE platform = ${platform} AND external_account_id = ${accountRef}`))[0]
        : undefined;
      if (!account || account.status === "disabled") {
        // Unknown (or disconnected) Page: keep the raw event, do not create anything. It can be replayed once the account is connected.
        await tx.execute(sql`UPDATE webhook_events SET status = 'orphan', attempts = attempts + 1, last_error = ${account ? "account_disabled" : "unknown_account"} WHERE id = ${eventId}`);
        return "orphan";
      }
      const workspaceId = account.workspace_id as string;
      const accountId = account.id as string;
      // Routing is bound in the database too: the guard trigger rejects a workspace that does not own (platform, account_ref).
      await tx.execute(sql`UPDATE webhook_events SET workspace_id = ${workspaceId} WHERE id = ${eventId} AND workspace_id IS NULL`);
      await tx.execute(sql`SELECT set_config('app.workspace_id', ${workspaceId}, true)`);

      const body = claimed.raw_body as Buffer | null;
      if (!body) throw new EventError("body_purged", false);
      const parsed = parseMetaWebhook(body);
      if (!parsed.ok || parsed.platform !== platform) throw new EventError("unparseable", false);

      for (const entry of parsed.entries) {
        if (entry.accountId !== accountRef) continue; // a body can never write into an account other than the one it was routed to
        for (const ev of entry.events) await applyEvent(tx, { workspaceId, accountId, accountRef, platform }, ev);
      }
      await tx.execute(sql`UPDATE webhook_events SET status = 'processed', processed_at = now(), attempts = attempts + 1, last_error = NULL WHERE id = ${eventId}`);
      return "processed";
    });
  } catch (err) {
    const code = codeOf(err);
    const dead = err instanceof EventError && !err.retryable;
    // Separate transaction: the failed one rolled back everything, including its claim.
    await db.transaction(async (tx) => {
      await tx.execute(
        sql`UPDATE webhook_events SET status = 'failed', attempts = ${dead ? MAX_ATTEMPTS : sql`attempts + 1`}, last_error = ${code.slice(0, 100)} WHERE id = ${eventId} AND status IN ('received','failed')`,
      );
    });
    return "failed";
  }
}

type Ctx = { workspaceId: string; accountId: string; accountRef: string; platform: string };

async function applyEvent(tx: Tx, ctx: Ctx, ev: MetaEvent): Promise<void> {
  if (ev.kind === "ignored") return;
  if (ev.kind === "message") {
    // Direction sanity: an inbound message is addressed to the Page, an echo is sent by it. Anything else is not for this account.
    const userId = ev.isEcho ? ev.recipientId : ev.senderId;
    if (ev.isEcho ? ev.senderId !== ctx.accountRef : ev.recipientId !== ctx.accountRef) return;
    const conv = await ensureConversation(tx, ctx, userId);
    const at = msToIso(ev.timestampMs);
    const inbound = !ev.isEcho;
    // Pre-check under the per-thread lock: the seq trigger runs before ON CONFLICT is evaluated, so a duplicate insert would burn a sequence number. The unique index stays as the backstop.
    if (rowsOf(await tx.execute(sql`SELECT 1 FROM messages WHERE integration_account_id = ${ctx.accountId} AND external_id = ${ev.mid}`)).length > 0) return;
    const inserted = rowsOf(
      await tx.execute(sql`
        INSERT INTO messages (workspace_id, conversation_id, integration_account_id, direction, external_id, sender_kind, body, attachments, delivery_state, occurred_at, sent_at)
        VALUES (${ctx.workspaceId}, ${conv.id}, ${ctx.accountId}, ${inbound ? "in" : "out"}, ${ev.mid}, ${inbound ? "contact" : "external"}, ${ev.text}, ${JSON.stringify(ev.attachments)}::jsonb, ${inbound ? "received" : "sent"}, ${at}, ${inbound ? null : at})
        ON CONFLICT (integration_account_id, external_id) WHERE external_id IS NOT NULL DO NOTHING
        RETURNING id`),
    );
    if (inserted.length === 0) return; // duplicate delivery: nothing else changes (unread, timestamps, events)
    // Forward-only: a late older message never moves the conversation backwards. A new inbound message reopens a resolved conversation.
    await tx.execute(sql`
      UPDATE conversations SET
        last_message_at = GREATEST(coalesce(last_message_at, ${at}::timestamptz), ${at}::timestamptz),
        last_inbound_at = ${inbound ? sql`GREATEST(coalesce(last_inbound_at, ${at}::timestamptz), ${at}::timestamptz)` : sql`last_inbound_at`},
        status = ${inbound ? sql`CASE WHEN status = 'resolved' THEN 'open' ELSE status END` : sql`status`},
        version = version + 1, updated_at = now()
      WHERE workspace_id = ${ctx.workspaceId} AND id = ${conv.id}`);
    await tx.execute(sql`UPDATE contacts SET last_activity_at = GREATEST(last_activity_at, ${at}::timestamptz) WHERE workspace_id = ${ctx.workspaceId} AND id = ${conv.contactId}`);
    return;
  }
  // read / delivery receipts: watermark moves forward only, for a conversation that already exists
  const col = ev.kind === "read" ? sql`contact_read_at` : sql`contact_delivered_at`;
  const at = msToIso(ev.watermarkMs);
  await tx.execute(sql`
    UPDATE conversations SET ${col} = GREATEST(coalesce(${col}, ${at}::timestamptz), ${at}::timestamptz), version = version + 1, updated_at = now()
    WHERE workspace_id = ${ctx.workspaceId} AND integration_account_id = ${ctx.accountId}
      AND identity_id = (SELECT id FROM platform_identities WHERE workspace_id = ${ctx.workspaceId} AND integration_account_id = ${ctx.accountId} AND external_user_id = ${ev.userId})
      AND ${col} IS DISTINCT FROM GREATEST(coalesce(${col}, ${at}::timestamptz), ${at}::timestamptz)`);
}

/** Finds or creates identity, contact and conversation for one platform user. Serialised per (account, user) so two events for one thread cannot create two. */
async function ensureConversation(tx: Tx, ctx: Ctx, userId: string): Promise<{ id: string; contactId: string }> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${ctx.accountId}:${userId}`}, 0))`);
  const find = async () =>
    rowsOf(
      await tx.execute(sql`
        SELECT c.id, c.contact_id FROM conversations c JOIN platform_identities i ON i.id = c.identity_id
        WHERE c.workspace_id = ${ctx.workspaceId} AND c.integration_account_id = ${ctx.accountId} AND i.external_user_id = ${userId}`),
    )[0];
  const existing = await find();
  if (existing) return { id: existing.id as string, contactId: existing.contact_id as string };

  let identity = rowsOf(await tx.execute(sql`SELECT id, contact_id FROM platform_identities WHERE integration_account_id = ${ctx.accountId} AND external_user_id = ${userId}`))[0];
  if (!identity) {
    const stage = rowsOf(await tx.execute(sql`SELECT id FROM lifecycle_stages WHERE workspace_id = ${ctx.workspaceId} AND archived_at IS NULL ORDER BY position LIMIT 1`))[0];
    if (!stage) throw new EventError("no_lifecycle_stage");
    // Placeholder name until profile enrichment exists; deliberately contains no platform-provided text.
    const label = ctx.platform === "instagram" ? "Instagram" : "Messenger";
    const contact = rowsOf(
      await tx.execute(sql`INSERT INTO contacts (workspace_id, name, lifecycle_stage_id, source) VALUES (${ctx.workspaceId}, ${`${label} user ${userId.slice(-4)}`}, ${stage.id}, ${ctx.platform}) RETURNING id`),
    )[0]!;
    identity = rowsOf(
      await tx.execute(sql`INSERT INTO platform_identities (workspace_id, integration_account_id, external_user_id, contact_id) VALUES (${ctx.workspaceId}, ${ctx.accountId}, ${userId}, ${contact.id}) RETURNING id, contact_id`),
    )[0]!;
  }
  // The advisory lock above serialises creators; DO NOTHING + re-read keeps the worker's column grants minimal (no UPDATE on identity columns).
  await tx.execute(sql`
    INSERT INTO conversations (workspace_id, integration_account_id, identity_id, contact_id) VALUES (${ctx.workspaceId}, ${ctx.accountId}, ${identity.id}, ${identity.contact_id})
    ON CONFLICT (integration_account_id, identity_id) DO NOTHING`);
  const conv = (await find())!;
  return { id: conv.id as string, contactId: conv.contact_id as string };
}

/** Processes up to `limit` claimable events, oldest first. Safe to run from several workers at once (per-event SKIP LOCKED). */
export async function processPending(db: Db, limit = 50): Promise<Record<Outcome, number>> {
  const ids = rowsOf(
    await db.execute(sql`SELECT id FROM webhook_events WHERE status = 'received' OR (status = 'failed' AND attempts < ${MAX_ATTEMPTS}) ORDER BY received_at, id LIMIT ${limit}`),
  ).map((r) => r.id as string);
  const out: Record<Outcome, number> = { processed: 0, orphan: 0, failed: 0, skipped: 0 };
  for (const id of ids) out[await processWebhookEvent(db, id)] += 1;
  return out;
}

/** Deletes raw bodies older than 30 days (decision D-E). Executes the database function; only crm_worker may. */
export async function purgeRawBodies(db: Db): Promise<number> {
  return Number(rowsOf(await db.execute(sql`SELECT purge_webhook_event_bodies() AS n`))[0]!.n);
}

export type InboxWorker = { stop(): Promise<void>; tick(): Promise<void> };

/** In-process loop (same pattern as the event dispatcher, decision D7). Purge runs at start and then every purgeEveryMs. */
export function startInboxWorker(db: Db, opts: { intervalMs: number; purgeEveryMs?: number; onError?: (e: unknown) => void }): InboxWorker {
  const purgeEvery = opts.purgeEveryMs ?? 6 * 3_600_000;
  let lastPurge = 0;
  let running: Promise<void> | null = null;
  let stopped = false;
  const tick = async () => {
    if (running) return running;
    running = (async () => {
      try {
        if (Date.now() - lastPurge >= purgeEvery) {
          await purgeRawBodies(db);
          lastPurge = Date.now();
        }
        await processPending(db);
      } catch (e) {
        opts.onError?.(e);
      } finally {
        running = null;
      }
    })();
    return running;
  };
  const timer = setInterval(() => void tick(), opts.intervalMs);
  timer.unref();
  void tick();
  return {
    tick,
    async stop() {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      await running;
    },
  };
}
