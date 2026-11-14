import { sql } from "drizzle-orm";
import { withContext, type Db } from "@crm/db";
import { GraphError, type MetaGraph, type SecretBox } from "@crm/integrations";
import { loadToken, type MetaConnectDeps } from "./meta-connect.ts";

type Row = Record<string, unknown>;
const rowsOf = (r: unknown) => (r as { rows: Row[] }).rows;

export type ProfileStats = { enriched: number; unavailable: number; failed: number; skipped: number };

/** Backoff after a miss: 10 minutes doubling with each attempt, capped at a day, so a missing permission is retried daily and a flaky network within minutes. */
export const retryDelayMs = (attempts: number, baseMs = 600_000) => Math.min(86_400_000, baseMs * 2 ** Math.min(attempts, 8));

/**
 * Fetches Messenger sender profiles (name, picture) for identities that have none yet, and refreshes a picture URL (they expire) at most weekly for people who wrote since.
 * Runs AFTER ingestion has committed and never throws into it: every outcome is recorded on the identity and the placeholder contact name stays when nothing usable came back.
 * Never logs tokens or profile data. Email and phone are not requested (Messenger does not provide them).
 * ponytail: scans connected Messenger accounts (<=100) each pass; add a pending-queue table if one workspace ever has thousands of unfetched contacts.
 */
export function createProfileEnricher(deps: { workerDb: Db; graph: MetaGraph; box: SecretBox; budget?: number; throttleCooldownMs?: number; now?: () => number }) {
  const budget = deps.budget ?? 10;
  const now = deps.now ?? Date.now;
  let pausedUntil = 0;
  const tokenDeps = { box: deps.box } as unknown as MetaConnectDeps; // loadToken only uses the secret box

  return async function enrich(): Promise<ProfileStats> {
    const stats: ProfileStats = { enriched: 0, unavailable: 0, failed: 0, skipped: 0 };
    if (now() < pausedUntil) return stats;
    let left = budget;
    const accounts = rowsOf(await deps.workerDb.execute(sql`SELECT id, workspace_id FROM integration_accounts WHERE platform = 'messenger' AND status = 'connected' ORDER BY created_at LIMIT 100`));
    for (const a of accounts) {
      if (left <= 0) break;
      const workspaceId = a.workspace_id as string;
      const accountId = a.id as string;
      const { token, due } = await withContext(deps.workerDb, { workspaceId }, async (tx) => ({
        token: await loadToken(tx, tokenDeps, workspaceId, accountId),
        due: rowsOf(
          await tx.execute(sql`
            SELECT pi.id, pi.external_user_id, pi.contact_id, pi.profile_attempts, pi.profile_status
            FROM platform_identities pi
            WHERE pi.workspace_id = ${workspaceId} AND pi.integration_account_id = ${accountId}
              AND (
                (pi.profile_status IS NULL AND (pi.profile_retry_at IS NULL OR pi.profile_retry_at <= now()))
                OR (pi.profile_status IN ('unavailable','denied','error') AND pi.profile_retry_at <= now())
                OR (pi.profile_status = 'ok' AND pi.profile_fetched_at < now() - interval '7 days'
                    AND EXISTS (SELECT 1 FROM conversations c WHERE c.workspace_id = pi.workspace_id AND c.identity_id = pi.id AND c.last_inbound_at > pi.profile_fetched_at)))
            ORDER BY pi.created_at LIMIT ${left}`),
        ),
      }));
      if (due.length === 0) continue;
      if (!token) { stats.skipped += due.length; continue; } // no usable token: the token check moves the account to reauth_required
      for (const p of due) {
        if (left <= 0) break;
        left--;
        const attempts = Number(p.profile_attempts);
        let status: "ok" | "unavailable" | "denied" | "error";
        let profile: Awaited<ReturnType<MetaGraph["getUserProfile"]>> = null;
        try {
          profile = await deps.graph.getUserProfile(p.external_user_id as string, token);
          status = profile ? "ok" : "unavailable";
        } catch (e) {
          if (e instanceof GraphError && e.kind === "throttle") {
            pausedUntil = now() + (deps.throttleCooldownMs ?? 900_000); // app-wide limit: stop the pass, leave rows untouched
            stats.skipped += 1;
            return stats;
          }
          status = e instanceof GraphError && e.kind === "permission" ? "denied" : "error";
        }
        await withContext(deps.workerDb, { workspaceId }, async (tx) => {
          if (status === "ok" && profile) {
            await tx.execute(sql`UPDATE platform_identities SET profile_name = ${profile.name}, profile_pic_url = ${profile.picUrl}, profile_status = 'ok', profile_fetched_at = now(), profile_attempts = 0, profile_retry_at = NULL WHERE id = ${p.id as string} AND workspace_id = ${workspaceId}`);
            // Only a placeholder name is replaced; a name a person typed is never touched (also enforced by a trigger, migration 0021).
            if (profile.name) await tx.execute(sql`UPDATE contacts SET name = ${profile.name}, version = version + 1, updated_at = now() WHERE id = ${p.contact_id as string} AND workspace_id = ${workspaceId} AND source IN ('messenger','instagram') AND name ~ '^(Messenger|Instagram) user [0-9]{1,4}$'`);
          } else if (p.profile_status === "ok") {
            // a failed weekly refresh keeps the last good name and picture and simply waits another week
            await tx.execute(sql`UPDATE platform_identities SET profile_fetched_at = now() WHERE id = ${p.id as string} AND workspace_id = ${workspaceId}`);
          } else {
            const retryAt = new Date(now() + retryDelayMs(attempts));
            await tx.execute(sql`UPDATE platform_identities SET profile_status = ${status}, profile_attempts = profile_attempts + 1, profile_retry_at = ${retryAt} WHERE id = ${p.id as string} AND workspace_id = ${workspaceId}`);
          }
        });
        if (status === "ok") stats.enriched++;
        else if (status === "error") stats.failed++;
        else stats.unavailable++;
      }
    }
    return stats;
  };
}
