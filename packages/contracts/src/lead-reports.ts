import { z } from "zod";
import { endpoint } from "./endpoint.ts";

const W = "/v1/workspaces/:workspaceId";
const Uuid = z.string().uuid();
const Money = z.object({ currency: z.string(), minor: z.number() });

/** Amounts are per currency (never summed across currencies) and are null when the caller may not see every lead value. */
const Values = z.array(Money).nullable();

export const LeadReportQuery = z.object({
  pipelineId: Uuid.optional(),
  /** Period for closed/created metrics, YYYY-MM-DD inclusive. Default: the last 90 days. */
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});
export type LeadReportQuery = z.input<typeof LeadReportQuery>;

export const LeadReport = z.object({
  pipelineId: Uuid,
  pipelineName: z.string(),
  period: z.object({ from: z.string(), to: z.string() }),
  /** False for anyone but owner/admin: every value-bearing field below is then null, so no aggregate can reveal a restricted value. */
  valuesVisible: z.boolean(),
  stages: z.array(z.object({ stageId: Uuid, name: z.string(), count: z.number().int(), share: z.number(), values: Values, entered: z.number().int() })),
  openTotal: z.object({ count: z.number().int(), values: Values }),
  won: z.object({ count: z.number().int(), values: Values }),
  lost: z.object({ count: z.number().int(), values: Values, reasons: z.array(z.object({ reasonId: Uuid, name: z.string(), count: z.number().int() })) }),
  conversion: z.object({ created: z.number().int(), winRate: z.number().nullable(), avgDaysToWin: z.number().nullable() }),
  closing: z.array(z.object({ bucket: z.string(), label: z.string(), count: z.number().int(), values: Values })),
});
export type LeadReport = z.infer<typeof LeadReport>;

export const leadReportEndpoints = {
  leadReport: endpoint({ method: "GET", path: `${W}/lead-reports/overview`, query: LeadReportQuery, response: LeadReport }),
} as const;
