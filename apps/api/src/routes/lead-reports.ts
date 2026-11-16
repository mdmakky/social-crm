import { Hono } from "hono";
import { sql } from "drizzle-orm";
import { LeadReportQuery, type LeadReport } from "@crm/contracts";
import { can } from "@crm/core/permissions";
import { withContext, type Db } from "@crm/db";
import { fail, query, wctx, type ScopedEnv } from "./scope.ts";

type Row = Record<string, unknown>;
const DAY = 86_400_000;
const ymd = (d: Date) => d.toISOString().slice(0, 10);
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * Minimal reporting over one pipeline. Counts are visible to every role that can view leads. Value sums are computed only for owner/admin:
 * for anyone else the query for value is never run and the fields are null, because an aggregate over a subset (granted leads only) or a total
 * minus counts would still leak restricted lead values. Money is grouped per currency and never converted. No forecasting or weighting.
 */
export function leadReportRoutes(db: Db) {
  const r = new Hono<ScopedEnv>();
  r.get("/lead-reports/overview", async (c) => {
    const q = query(c, LeadReportQuery);
    if (!q.ok) return q.res;
    const { workspaceId } = wctx(c);
    const showValues = can(c.get("role"), "lead.value.view", {}); // owner/admin only; "granted" counts as false without a grant
    const to = q.data.to ?? ymd(new Date());
    const from = q.data.from ?? ymd(new Date(Date.now() - 90 * DAY));
    if (from > to) return fail(c, 400, "invalid_query", "The start date is after the end date.");
    return withContext(db, wctx(c), async (tx) => {
      const pl = (await tx.execute(sql`SELECT id, name FROM pipelines WHERE workspace_id = ${workspaceId} AND archived_at IS NULL AND (${q.data.pipelineId ?? null}::uuid IS NULL AND is_default OR id = ${q.data.pipelineId ?? null}::uuid) LIMIT 1`)).rows as Row[];
      const pipe = pl[0] ?? (await tx.execute(sql`SELECT id, name FROM pipelines WHERE workspace_id = ${workspaceId} AND archived_at IS NULL AND ${q.data.pipelineId ?? null}::uuid IS NULL ORDER BY position LIMIT 1`)).rows[0] as Row | undefined;
      if (!pipe) return fail(c, 404, "not_found", "No pipeline.");
      const pid = String(pipe.id);
      const vals = (rows: Row[], key = "currency") => (showValues ? rows.filter((x) => x[key] !== null).map((x) => ({ currency: String(x[key]), minor: Number(x.minor) })) : null);

      const stageRows = (await tx.execute(sql`SELECT s.id, s.name, s.position, count(l.id)::int AS n FROM pipeline_stages s LEFT JOIN leads l ON l.workspace_id = s.workspace_id AND l.stage_id = s.id AND l.deleted_at IS NULL AND l.outcome = 'open'
        WHERE s.workspace_id = ${workspaceId} AND s.pipeline_id = ${pid} AND s.kind = 'open' AND s.archived_at IS NULL GROUP BY s.id ORDER BY s.position`)).rows as Row[];
      const stageValues = showValues ? (await tx.execute(sql`SELECT stage_id, currency, sum(value_minor)::float8 AS minor FROM leads WHERE workspace_id = ${workspaceId} AND pipeline_id = ${pid} AND deleted_at IS NULL AND outcome = 'open' AND value_minor IS NOT NULL GROUP BY stage_id, currency`)).rows as Row[] : [];
      const entered = (await tx.execute(sql`SELECT to_stage_id AS id, count(DISTINCT lead_id)::int AS n FROM stage_transitions WHERE workspace_id = ${workspaceId} AND pipeline_id = ${pid} AND occurred_at >= ${from}::date AND occurred_at < (${to}::date + 1) GROUP BY to_stage_id`)).rows as Row[];
      const openN = stageRows.reduce((n, x) => n + Number(x.n), 0);

      const closed = async (outcome: "won" | "lost") => {
        const [cnt] = (await tx.execute(sql`SELECT count(*)::int AS n FROM leads WHERE workspace_id = ${workspaceId} AND pipeline_id = ${pid} AND deleted_at IS NULL AND outcome = ${outcome} AND closed_at >= ${from}::date AND closed_at < (${to}::date + 1)`)).rows as Row[];
        const v = showValues ? (await tx.execute(sql`SELECT currency, sum(value_minor)::float8 AS minor FROM leads WHERE workspace_id = ${workspaceId} AND pipeline_id = ${pid} AND deleted_at IS NULL AND outcome = ${outcome} AND closed_at >= ${from}::date AND closed_at < (${to}::date + 1) AND value_minor IS NOT NULL GROUP BY currency`)).rows as Row[] : [];
        return { count: Number(cnt!.n), values: vals(v) };
      };
      const won = await closed("won");
      const lost = await closed("lost");
      const reasons = (await tx.execute(sql`SELECT r.id, r.name, count(*)::int AS n FROM leads l JOIN lost_reasons r ON r.workspace_id = l.workspace_id AND r.id = l.lost_reason_id WHERE l.workspace_id = ${workspaceId} AND l.pipeline_id = ${pid} AND l.deleted_at IS NULL AND l.outcome = 'lost' AND l.closed_at >= ${from}::date AND l.closed_at < (${to}::date + 1) GROUP BY r.id, r.name ORDER BY n DESC, r.name`)).rows as Row[];
      const [created] = (await tx.execute(sql`SELECT count(*)::int AS n FROM leads WHERE workspace_id = ${workspaceId} AND pipeline_id = ${pid} AND deleted_at IS NULL AND created_at >= ${from}::date AND created_at < (${to}::date + 1)`)).rows as Row[];
      const [days] = (await tx.execute(sql`SELECT avg(extract(epoch FROM (closed_at - created_at)) / 86400)::float8 AS d FROM leads WHERE workspace_id = ${workspaceId} AND pipeline_id = ${pid} AND deleted_at IS NULL AND outcome = 'won' AND closed_at >= ${from}::date AND closed_at < (${to}::date + 1)`)).rows as Row[];

      // Expected closing of OPEN leads: overdue, the next six calendar months (UTC), later, and no date.
      const closingRows = (await tx.execute(sql`SELECT CASE WHEN expected_close_date IS NULL THEN 'none' WHEN expected_close_date < current_date THEN 'overdue' WHEN expected_close_date >= (date_trunc('month', current_date) + interval '6 months') THEN 'later' ELSE to_char(expected_close_date, 'YYYY-MM') END AS bucket, count(*)::int AS n
        FROM leads WHERE workspace_id = ${workspaceId} AND pipeline_id = ${pid} AND deleted_at IS NULL AND outcome = 'open' GROUP BY 1`)).rows as Row[];
      const closingValues = showValues ? (await tx.execute(sql`SELECT CASE WHEN expected_close_date IS NULL THEN 'none' WHEN expected_close_date < current_date THEN 'overdue' WHEN expected_close_date >= (date_trunc('month', current_date) + interval '6 months') THEN 'later' ELSE to_char(expected_close_date, 'YYYY-MM') END AS bucket, currency, sum(value_minor)::float8 AS minor
        FROM leads WHERE workspace_id = ${workspaceId} AND pipeline_id = ${pid} AND deleted_at IS NULL AND outcome = 'open' AND value_minor IS NOT NULL GROUP BY 1, 2`)).rows as Row[] : [];
      const now = new Date();
      const buckets = [{ bucket: "overdue", label: "Overdue" }, ...Array.from({ length: 6 }, (_, i) => { const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + i, 1)); return { bucket: `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`, label: `${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}` }; }), { bucket: "later", label: "Later" }, { bucket: "none", label: "No date" }];

      const winDen = won.count + lost.count;
      const body: LeadReport = {
        pipelineId: pid, pipelineName: String(pipe.name), period: { from, to }, valuesVisible: showValues,
        stages: stageRows.map((s) => ({ stageId: String(s.id), name: String(s.name), count: Number(s.n), share: openN ? Number(s.n) / openN : 0, values: vals(stageValues.filter((v) => v.stage_id === s.id)), entered: Number(entered.find((e) => e.id === s.id)?.n ?? 0) })),
        openTotal: { count: openN, values: showValues ? vals(Object.values(stageValues.reduce<Record<string, Row>>((a, v) => { const k = String(v.currency); a[k] = { currency: k, minor: Number(a[k]?.minor ?? 0) + Number(v.minor) }; return a; }, {}))) : null },
        won, lost: { ...lost, reasons: reasons.map((x) => ({ reasonId: String(x.id), name: String(x.name), count: Number(x.n) })) },
        conversion: { created: Number(created!.n), winRate: winDen ? won.count / winDen : null, avgDaysToWin: days!.d === null ? null : Math.round(Number(days!.d) * 10) / 10 },
        closing: buckets.map((b) => ({ ...b, count: Number(closingRows.find((x) => x.bucket === b.bucket)?.n ?? 0), values: vals(closingValues.filter((v) => v.bucket === b.bucket)) })),
      };
      return c.json(body);
    });
  });
  return r;
}
