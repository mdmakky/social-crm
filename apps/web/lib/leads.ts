import type { LeadDto, PipelineDto, StageDto } from "@crm/contracts";

/** UI wording follows the pipeline kind (decision 1): lead pipelines say Lead, sales pipelines say Deal. The data model is one entity (D20). */
export const noun = (kind: PipelineDto["kind"] | undefined, plural = false) => (kind === "lead" ? (plural ? "Leads" : "Lead") : plural ? "Deals" : "Deal");
export const OUTCOME_LABEL = { open: "Open", won: "Won", lost: "Lost" } as const;
export const OUTCOME_TONE = { open: "accent", won: "success", lost: "neutral" } as const;
export const PRIORITY_LABEL = { low: "Low", normal: "Normal", high: "High" } as const;

/** Money is stored as integer minor units; the number of decimals comes from the currency. */
export function formatMoney(minor: number, currency: string, locale = "en"): string {
  const digits = new Intl.NumberFormat(locale, { style: "currency", currency }).resolvedOptions().maximumFractionDigits ?? 2;
  return new Intl.NumberFormat(locale, { style: "currency", currency, maximumFractionDigits: digits }).format(minor / 10 ** digits);
}
export const toMinor = (text: string, currency: string): number | null => {
  const digits = new Intl.NumberFormat("en", { style: "currency", currency }).resolvedOptions().maximumFractionDigits ?? 2;
  const t = text.trim().replace(/,/g, "");
  if (!/^\d+(\.\d+)?$/.test(t)) return null;
  const n = Math.round(Number(t) * 10 ** digits);
  return Number.isSafeInteger(n) ? n : null;
};
export const fromMinor = (minor: number, currency: string): string => {
  const digits = new Intl.NumberFormat("en", { style: "currency", currency }).resolvedOptions().maximumFractionDigits ?? 2;
  return (minor / 10 ** digits).toFixed(digits);
};
export const CURRENCIES = ["USD", "EUR", "GBP", "CAD", "AUD", "JPY", "INR", "BDT", "AED", "SGD"] as const;

export const stageName = (pipelines: PipelineDto[], l: Pick<LeadDto, "pipelineId" | "stageId">): StageDto | undefined =>
  pipelines.find((p) => p.id === l.pipelineId)?.stages.find((s) => s.id === l.stageId);
export const msAgo = (days: number) => Date.now() - days * 86_400_000;
