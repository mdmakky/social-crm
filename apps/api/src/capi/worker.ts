import { sql } from "drizzle-orm";
import { backoffMs, CapiEvent, CONSENT_PURPOSE, consentGate, MAX_ATTEMPTS, staleness, type CapiAdapter } from "@crm/capi";
import { withContext, type Db } from "@crm/db";
import type { SecretBox } from "@crm/integrations";

type Row = Record<string, unknown>;
const rowsOf = (r: unknown) => (r as { rows: Row[] }).rows;

export type CapiWorkerDeps = {
  /** Mock in slice 1. A dataset's mode must equal the adapter's mode, so a mock dataset can never reach Meta and a live one is never "delivered" by the mock. */
  adapter: CapiAdapter;
  box: SecretBox;
  now?: () => number;
  batch?: number;
  /** How long a claimed row stays invisible; if the process dies mid-send the row is picked up again after this. */
  leaseMs?: number;
};
export type CapiRunResult = { claimed: number; sent: number; retried: number; failed: number; skipped: number };

type Prepared = { kind: "final"; status: "failed" | "skipped_no_consent"; error: string; blank?: boolean } | { kind: "send"; datasetId: string; token: string; testEventCode: string | null; event: CapiEvent };

/**
 * Sends due events, as crm_worker. Per event: (1) claim under SKIP LOCKED and take a lease (attempts + 1, next_attempt_at pushed out), committed;
 * (2) read dataset, consent and sealed token in a short workspace-scoped transaction; (3) ONE adapter call with no transaction open; (4) record the outcome.
 * Idempotency: the event keeps one event_id for life, a row leaves `pending` exactly once (final states are guarded by a trigger), and two workers cannot hold the same row.
 */
export async function processCapiQueue(db: Db, deps: CapiWorkerDeps): Promise<CapiRunResult> {
  const now = deps.now ?? Date.now;
  const res: CapiRunResult = { claimed: 0, sent: 0, retried: 0, failed: 0, skipped: 0 };
  const lease = deps.leaseMs ?? 5 * 60_000;
  const t0 = new Date(now()).toISOString();
  const claimed = await db.transaction(async (tx) =>
    rowsOf(await tx.execute(sql`
      WITH due AS (SELECT id FROM capi_events WHERE status = 'pending' AND next_attempt_at <= ${t0}::timestamptz ORDER BY next_attempt_at, id LIMIT ${deps.batch ?? 50} FOR UPDATE SKIP LOCKED)
      UPDATE capi_events e SET attempts = e.attempts + 1, next_attempt_at = ${new Date(now() + lease).toISOString()}::timestamptz, updated_at = now()
      FROM due WHERE e.id = due.id RETURNING e.id, e.workspace_id, e.attempts`)),
  );
  res.claimed = claimed.length;
  for (const c of claimed) {
    const id = c.id as string;
    const workspaceId = c.workspace_id as string;
    const attempts = c.attempts as number;
    const ctx = { workspaceId };
    const prep = await withContext(db, ctx, (tx) => prepare(tx, deps, id, workspaceId, now()));
    if (!prep) continue; // no longer pending (a concurrent change): nothing to do
    if (prep.kind === "final") {
      await withContext(db, ctx, async (tx) => {
        if (prep.blank) await tx.execute(sql`UPDATE capi_events SET payload = jsonb_set(payload, '{user_data}', '{}'::jsonb) WHERE id = ${id} AND status = 'pending'`);
        await tx.execute(sql`UPDATE capi_events SET status = ${prep.status}, last_error = ${prep.error}, updated_at = now() WHERE id = ${id} AND status = 'pending'`);
      });
      res[prep.status === "failed" ? "failed" : "skipped"]++;
      continue;
    }
    let out: Awaited<ReturnType<CapiAdapter["send"]>>;
    try {
      out = await deps.adapter.send({ datasetId: prep.datasetId, accessToken: prep.token, testEventCode: prep.testEventCode, events: [prep.event] });
    } catch {
      out = { ok: false, retryable: true, code: "adapter_error" };
    }
    await withContext(db, ctx, async (tx) => {
      if (out.ok) {
        await tx.execute(sql`UPDATE capi_events SET status = 'sent', sent_at = now(), last_error = NULL, fbtrace_id = ${out.fbtraceId ?? null}, updated_at = now() WHERE id = ${id} AND status = 'pending'`);
        res.sent++;
      } else if (out.retryable && attempts < MAX_ATTEMPTS) {
        await tx.execute(sql`UPDATE capi_events SET next_attempt_at = ${new Date(now() + backoffMs(attempts)).toISOString()}::timestamptz, last_error = ${safe(out.code)}, fbtrace_id = ${out.fbtraceId ?? null}, updated_at = now() WHERE id = ${id} AND status = 'pending'`);
        res.retried++;
      } else {
        await tx.execute(sql`UPDATE capi_events SET status = 'failed', last_error = ${out.retryable ? safe(`max_attempts:${out.code}`) : safe(out.code)}, fbtrace_id = ${out.fbtraceId ?? null}, updated_at = now() WHERE id = ${id} AND status = 'pending'`);
        res.failed++;
      }
    });
  }
  return res;
}

/** Error codes are stored and shown; only short machine words, never provider message text. */
const safe = (code: string) => (/^[a-z0-9_:]{1,80}$/.test(code) ? code : "unknown_error");

async function prepare(tx: Parameters<Parameters<Db["transaction"]>[0]>[0], deps: CapiWorkerDeps, id: string, workspaceId: string, nowMs: number): Promise<Prepared | null> {
  const e = rowsOf(await tx.execute(sql`
    SELECT e.status, e.dataset_id AS ds_uuid, e.contact_id, e.payload, d.dataset_id AS meta_dataset, d.status AS ds_status, d.mode, d.test_event_code
    FROM capi_events e JOIN capi_datasets d ON d.workspace_id = e.workspace_id AND d.id = e.dataset_id
    WHERE e.id = ${id} AND e.workspace_id = ${workspaceId}`))[0];
  if (!e || e.status !== "pending") return null;
  const parsed = CapiEvent.safeParse(e.payload);
  if (!parsed.success) return { kind: "final", status: "failed", error: "invalid_payload" };
  const event = parsed.data;
  if (e.ds_status !== "active") return { kind: "final", status: "failed", error: "dataset_inactive" };
  if (e.mode !== deps.adapter.mode) return { kind: "final", status: "failed", error: "mode_mismatch" };
  if (staleness(event.event_time, nowMs) === "too_old") return { kind: "final", status: "failed", error: "event_too_old" };
  if (e.contact_id) {
    const latest = rowsOf(await tx.execute(sql`SELECT status FROM consent_records WHERE workspace_id = ${workspaceId} AND contact_id = ${e.contact_id as string} AND purpose = ${CONSENT_PURPOSE} ORDER BY id DESC LIMIT 1`))[0] as { status: "granted" | "revoked" } | undefined;
    const gate = consentGate(latest);
    if (!gate.allow) return { kind: "final", status: "skipped_no_consent", error: gate.reason, blank: true }; // withdrawn after queueing: honoured, identifiers blanked
  }
  const s = rowsOf(await tx.execute(sql`SELECT ciphertext, nonce, key_id FROM capi_dataset_secrets WHERE workspace_id = ${workspaceId} AND dataset_id = ${e.ds_uuid as string}`))[0];
  let token: string;
  try {
    token = deps.box.open({ ciphertext: s!.ciphertext as Buffer, nonce: s!.nonce as Buffer, keyId: s!.key_id as string }, e.ds_uuid as string);
  } catch {
    return { kind: "final", status: "failed", error: "token_unavailable" };
  }
  return { kind: "send", datasetId: e.meta_dataset as string, token, testEventCode: (e.test_event_code as string | null) ?? null, event };
}

/** Simple in-process loop (same shortcut as the inbox worker: one API instance). Errors are logged by name only. */
export function startCapiWorker(db: Db, deps: CapiWorkerDeps, intervalMs = 15_000) {
  let running: Promise<unknown> | null = null;
  const timer = setInterval(() => {
    if (running) return;
    running = processCapiQueue(db, deps).catch((e) => console.error(JSON.stringify({ msg: "capi worker error", error: (e as Error).name }))).finally(() => { running = null; });
  }, intervalMs);
  return { stop: async () => { clearInterval(timer); await running; } };
}
