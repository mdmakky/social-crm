"use client";
import * as React from "react";
import { endpoints, type CapiMappingPreview, type LeadDto } from "@crm/contracts";
import { Badge } from "@/components/ui/badge";
import { Field } from "@/components/ui/field";
import { Select } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert } from "@/components/ui/states";
import { browserApi, errorMessage } from "@/lib/client-api";

type Trigger = "lead_created" | "lead_stage_entered" | "lead_won" | "lead_lost";
const SKIP_TEXT: Record<string, string> = {
  mapping_disabled: "This rule is turned off.", dataset_inactive: "The dataset is disabled.", no_value: "The lead has no value.", no_consent: "No ad measurement consent for this lead.", opted_out: "The lead withdrew consent.",
};

/** Dry run: pick a lead, see which rules would send and which would be skipped, and why. Queues nothing. */
export function RuleTest({ workspaceId, when }: { workspaceId: string; when: (t: Trigger, stageId: string | null) => string }) {
  const [leads, setLeads] = React.useState<LeadDto[] | null>(null);
  const [leadId, setLeadId] = React.useState("");
  const [result, setResult] = React.useState<CapiMappingPreview | null>(null);
  const [state, setState] = React.useState<"idle" | "loading" | "error">("idle");
  const [error, setError] = React.useState<string | null>(null);
  React.useEffect(() => {
    void browserApi.call(endpoints.listLeads, { params: { workspaceId }, query: { limit: 50, sort: "updated", dir: "desc" } }).then((r) => { if (r.ok) setLeads(r.data.items); else { setLeads([]); setError(errorMessage(r.error)); } });
  }, [workspaceId]);
  async function pick(id: string) {
    setLeadId(id); setResult(null); setError(null);
    if (!id) { setState("idle"); return; }
    setState("loading");
    const r = await browserApi.call(endpoints.previewCapiMappings, { params: { workspaceId }, body: { leadId: id } });
    if (!r.ok) { setState("error"); setError(errorMessage(r.error)); return; }
    setState("idle"); setResult(r.data);
  }
  return (
    <div className="rounded-control border border-line-card p-3">
      <h4 className="font-medium text-fg">Test with a lead</h4>
      <p className="mb-2 text-sm text-fg-subtle">See what each rule would do for a real lead. Nothing is sent.</p>
      {leads === null ? <Skeleton className="h-9" /> : leads.length === 0 ? <p className="text-sm text-fg-muted">{error ?? "No leads yet. Create a lead to test the rules."}</p> : (
        <Field label="Lead">{(p) => (
          <Select {...p} value={leadId} onChange={(ev) => void pick(ev.target.value)}>
            <option value="">Choose a lead</option>
            {leads.map((l) => <option key={l.id} value={l.id}>{l.title} ({l.primaryContact.name})</option>)}
          </Select>
        )}</Field>
      )}
      {state === "loading" && <div role="status" aria-label="Checking" className="mt-3"><Skeleton className="h-10" /></div>}
      {state === "error" && error && <Alert tone="error" className="mt-3">{error}</Alert>}
      {result && (
        <ul className="mt-3 flex flex-col gap-1" aria-label="Test result">
          {result.items.length === 0 && <li className="text-sm text-fg-muted">There are no rules to test.</li>}
          {result.items.map((i) => (
            <li key={i.mappingId} className="flex flex-wrap items-center gap-2 text-sm">
              <Badge tone={i.result === "send" ? "success" : "neutral"}>{i.result === "send" ? "Would send" : "Skipped"}</Badge>
              <span className="text-fg">{i.eventName} to {i.datasetName}{i.value !== null ? `, ${i.value} ${i.currency}` : ""}</span>
              <span className="text-fg-muted">{when(i.triggerType, i.stageId)}{i.reason ? `. ${SKIP_TEXT[i.reason]}${i.reason === "no_value" && i.askForValue ? " The app asks for it when the lead is moved." : ""}` : ""}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
