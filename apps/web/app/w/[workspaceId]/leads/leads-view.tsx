"use client";
import * as React from "react";
import Link from "next/link";
import { ArrowDown, ArrowUp, BarChart3, FilterX, Lock, Plus, Search, SlidersHorizontal } from "lucide-react";
import { endpoints, type LeadDto, type LeadListQuery, type LeadPage, type Member, type PipelineDto } from "@crm/contracts";
import { Status } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/input";
import { PageHeader, Panel } from "@/components/ui/panel";
import { EmptyState, ErrorState } from "@/components/ui/states";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { ToastProvider } from "@/components/ui/toast";
import { Tooltip } from "@/components/ui/overlays";
import { NewLeadDialog } from "@/components/leads/new-lead-dialog";
import { browserApi, errorMessage } from "@/lib/client-api";
import { formatDate } from "@/lib/format";
import { formatMoney, noun, OUTCOME_LABEL, stageName } from "@/lib/leads";

type Props = { initialOutcome: Filters["outcome"]; workspaceId: string; myUserId: string; pipelines: PipelineDto[]; initial: LeadPage | null; members: Member[]; canCreate: boolean; canSetValue: boolean };
type Filters = { q: string; pipelineId: string; stageId: string; outcome: "open" | "won" | "lost" | "all"; ownerId: string; sort: "updated" | "created" | "close"; dir: "asc" | "desc" };
const DEFAULTS: Filters = { q: "", pipelineId: "", stageId: "", outcome: "open", ownerId: "", sort: "updated", dir: "desc" };
const SORTS = [["updated", "Last updated"], ["created", "Created"], ["close", "Expected close"]] as const;

const toQuery = (f: Filters, cursor?: string): LeadListQuery => ({
  limit: 50, sort: f.sort, dir: f.dir,
  ...(f.q.trim() ? { q: f.q.trim() } : {}), ...(f.pipelineId ? { pipelineId: f.pipelineId } : {}), ...(f.stageId ? { stageId: f.stageId } : {}),
  ...(f.outcome !== "all" ? { outcome: f.outcome } : {}), ...(f.ownerId ? { ownerId: f.ownerId } : {}), ...(cursor ? { cursor } : {}),
});

export function LeadsView(props: Props) {
  return <ToastProvider><Inner {...props} /></ToastProvider>;
}

function Inner({ initialOutcome, workspaceId, myUserId, pipelines, initial, members, canCreate, canSetValue }: Props) {
  const [showFilters, setShowFilters] = React.useState(false);
  const [f, setF] = React.useState<Filters>({ ...DEFAULTS, outcome: initialOutcome });
  const [page, setPage] = React.useState<LeadPage>(initial ?? { items: [], nextCursor: null });
  const [status, setStatus] = React.useState<"idle" | "loading" | "error">(initial ? "idle" : "error");
  const [errorText, setErrorText] = React.useState<string | null>(null);
  const [moreBusy, setMoreBusy] = React.useState(false);
  const [newOpen, setNewOpen] = React.useState(false);
  const [announce, setAnnounce] = React.useState("");
  const seq = React.useRef(0);
  const first = React.useRef(true);
  const active = pipelines.filter((p) => !p.archived);
  const selected = pipelines.find((p) => p.id === f.pipelineId);
  const labelKind = selected?.kind ?? (new Set(active.map((p) => p.kind)).size === 1 ? active[0]?.kind : undefined);
  const stages = (selected ? [selected] : active).flatMap((p) => p.stages.filter((s) => !s.archived).map((s) => ({ ...s, label: selected ? s.name : `${p.name} · ${s.name}` })));
  const filtered = f.q.trim() !== "" || f.pipelineId !== "" || f.stageId !== "" || f.outcome !== "open" || f.ownerId !== "";

  const load = React.useCallback(async (next: Filters) => {
    const mine = ++seq.current;
    setStatus("loading");
    const r = await browserApi.call(endpoints.listLeads, { params: { workspaceId }, query: toQuery(next) });
    if (mine !== seq.current) return;
    if (!r.ok) { setErrorText(errorMessage(r.error)); setStatus("error"); return; }
    setPage(r.data); setStatus("idle");
    setAnnounce(`${r.data.items.length}${r.data.nextCursor ? "+" : ""} results`);
  }, [workspaceId]);

  React.useEffect(() => {
    if (first.current) { first.current = false; return; }
    const t = setTimeout(() => void load(f), f.q ? 250 : 0);
    return () => clearTimeout(t);
  }, [f, load]);

  async function more() {
    if (!page.nextCursor) return;
    setMoreBusy(true);
    const r = await browserApi.call(endpoints.listLeads, { params: { workspaceId }, query: toQuery(f, page.nextCursor) });
    setMoreBusy(false);
    if (!r.ok) { setErrorText(errorMessage(r.error)); return; }
    setErrorText(null);
    setPage((p) => ({ items: [...p.items, ...r.data.items], nextCursor: r.data.nextCursor }));
  }

  const set = (patch: Partial<Filters>) => setF((x) => ({ ...x, ...patch }));
  const href = (l: LeadDto) => `/w/${workspaceId}/leads/${l.id}`;
  const stageBadge = (l: LeadDto) => <Status hue={l.outcome === "won" ? 2 : l.outcome === "lost" ? "muted" : ((((stageName(pipelines, l)?.position ?? 0) % 6) + 1) as 1 | 2 | 3 | 4 | 5 | 6)}>{stageName(pipelines, l)?.name ?? OUTCOME_LABEL[l.outcome]}</Status>;
  const value = (l: LeadDto) =>
    l.valueHidden ? <Tooltip label="You don't have access to deal value on this record." side="top"><span className="inline-flex items-center gap-1 text-fg-subtle"><Lock className="size-3" aria-hidden />Hidden</span></Tooltip>
      : l.valueMinor !== null && l.currency ? <span className="tabular-nums">{formatMoney(l.valueMinor, l.currency)}</span> : <span className="text-fg-subtle">—</span>;

  return (
    <>
      <PageHeader title="Leads" description="Track every opportunity from first contact to won or lost." actions={canCreate && active.length > 0 ? <Button variant="primary" onClick={() => setNewOpen(true)}><Plus className="size-4" aria-hidden />New {noun(labelKind).toLowerCase()}</Button> : undefined} />

      <div className="mb-3 flex flex-wrap items-center gap-2" role="search" aria-label="Filter leads">
        <div className="relative min-w-0 flex-1 basis-56 sm:max-w-xs">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-fg-subtle" aria-hidden />
          <Input aria-label="Search leads by title" placeholder="Search by title" className="pl-8" value={f.q} onChange={(e) => set({ q: e.target.value })} />
        </div>
        <Button variant="secondary" className="md:hidden" aria-expanded={showFilters} aria-controls="lead-filters" onClick={() => setShowFilters((v) => !v)}><SlidersHorizontal aria-hidden />Filters{filtered ? " (on)" : ""}</Button>
        <div id="lead-filters" className={`${showFilters ? "flex" : "hidden"} w-full flex-wrap items-center gap-2 md:contents`}>
        <Select aria-label="Status" wrapperClassName="w-auto max-md:min-w-[9rem] max-md:flex-1" value={f.outcome} onChange={(e) => set({ outcome: e.target.value as Filters["outcome"] })}>
          <option value="open">Open</option><option value="won">Won</option><option value="lost">Lost</option><option value="all">All statuses</option>
        </Select>
        {active.length > 1 && (
          <Select aria-label="Pipeline" wrapperClassName="w-auto max-md:min-w-[9rem] max-md:flex-1" value={f.pipelineId} onChange={(e) => set({ pipelineId: e.target.value, stageId: "" })}>
            <option value="">All pipelines</option>{active.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </Select>
        )}
        <Select aria-label="Stage" wrapperClassName="w-auto max-md:min-w-[9rem] max-md:flex-1" value={f.stageId} onChange={(e) => set({ stageId: e.target.value })}>
          <option value="">All stages</option>{stages.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
        </Select>
        <Select aria-label="Owner" wrapperClassName="w-auto max-md:min-w-[9rem] max-md:flex-1" value={f.ownerId} onChange={(e) => set({ ownerId: e.target.value })}>
          <option value="">Anyone</option><option value={myUserId}>Me</option>{members.filter((m) => m.userId !== myUserId).map((m) => <option key={m.userId} value={m.userId}>{m.name}</option>)}
        </Select>
        <div className="ml-auto flex items-center gap-1">
          <Select aria-label="Sort by" wrapperClassName="w-auto max-md:min-w-[9rem] max-md:flex-1" value={f.sort} onChange={(e) => set({ sort: e.target.value as Filters["sort"] })}>{SORTS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</Select>
          <Button variant="secondary" icon aria-label={f.dir === "desc" ? "Sorted descending. Switch to ascending" : "Sorted ascending. Switch to descending"} onClick={() => set({ dir: f.dir === "desc" ? "asc" : "desc" })}>{f.dir === "desc" ? <ArrowDown className="size-4" aria-hidden /> : <ArrowUp className="size-4" aria-hidden />}</Button>
          {filtered && <Button variant="ghost" onClick={() => setF(DEFAULTS)}><FilterX className="size-4" aria-hidden />Clear</Button>}
        </div>
      
        </div>
      </div>
      <p className="sr-only" role="status" aria-live="polite">{announce}</p>

      {status === "error" && page.items.length === 0 ? (
        <Panel><ErrorState description={errorText ?? undefined} onRetry={() => void load(f)} /></Panel>
      ) : status === "loading" && page.items.length === 0 ? (
        <Panel aria-busy="true" role="status"><div aria-label="Loading leads">{Array.from({ length: 6 }).map((_, i) => <div key={i} className="flex gap-3 border-b border-line px-4 py-3 last:border-0"><Skeleton className="h-4 w-56" /><Skeleton className="ml-auto h-4 w-24" /></div>)}</div></Panel>
      ) : page.items.length === 0 ? (
        <Panel>
          {filtered ? <EmptyState icon={BarChart3} title="No leads match these filters" description="Try a different search or clear the filters." action={<Button onClick={() => setF(DEFAULTS)}>Clear filters</Button>} />
            : <EmptyState icon={BarChart3} title="No open leads" description={active.length === 0 ? "An admin needs to set up a pipeline first." : "Create one to start tracking it through the pipeline. Won and lost ones are under Status."} action={canCreate && active.length > 0 ? <Button variant="primary" onClick={() => setNewOpen(true)}><Plus className="size-4" aria-hidden />New {noun(labelKind).toLowerCase()}</Button> : undefined} />}
        </Panel>
      ) : (
        <div className={status === "loading" ? "opacity-60 transition-opacity" : "transition-opacity"} aria-busy={status === "loading"}>
          <Panel className="hidden overflow-hidden md:block">
            <Table scrollLabel="Leads">
              <THead><TR className="hover:bg-transparent"><TH>Title</TH><TH>Contact</TH><TH>Stage</TH><TH className="text-right">Value</TH><TH>Close</TH><TH>Owner</TH></TR></THead>
              <TBody>
                {page.items.map((l) => (
                  <TR key={l.id} className="group">
                    <TD className="max-w-xs"><Link href={href(l)} className="block truncate font-medium text-fg hover:text-accent-fg focus-visible:outline-offset-2">{l.title}</Link></TD>
                    <TD className="max-w-48 truncate text-fg-muted">{l.primaryContact.name}</TD>
                    <TD>{stageBadge(l)}</TD>
                    <TD className="text-right">{value(l)}</TD>
                    <TD className="whitespace-nowrap text-fg-muted">{l.expectedCloseDate ? formatDate(`${l.expectedCloseDate}T12:00:00Z`, "UTC") : "—"}</TD>
                    <TD className="text-fg-muted">{l.owner?.name ?? "Unassigned"}</TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          </Panel>
          <ul className="flex flex-col gap-2 md:hidden" aria-label="Leads">
            {page.items.map((l) => (
              <li key={l.id}>
                <Link href={href(l)} className="block rounded-card bg-surface p-3 shadow-sheet active:bg-hover">
                  <div className="flex items-start justify-between gap-2"><span className="min-w-0 break-words font-medium text-fg">{l.title}</span>{stageBadge(l)}</div>
                  <div className="mt-1 text-sm text-fg-muted">{l.primaryContact.name}</div>
                  <div className="mt-2 flex items-center justify-between text-sm"><span>{value(l)}</span><span className="text-fg-subtle">{l.owner?.name ?? "Unassigned"}</span></div>
                </Link>
              </li>
            ))}
          </ul>
          <div className="mt-3 flex flex-col items-center gap-2 text-sm text-fg-muted">
            {errorText && <p role="alert" className="text-danger-fg">{errorText}</p>}
            {page.nextCursor ? <Button onClick={() => void more()} disabled={moreBusy}>{moreBusy ? "Loading…" : "Load more"}</Button> : <p>{page.items.length} {page.items.length === 1 ? "lead" : "leads"}</p>}
          </div>
        </div>
      )}
      <NewLeadDialog key={String(newOpen)} open={newOpen} onOpenChange={setNewOpen} workspaceId={workspaceId} pipelines={pipelines} canSetValue={canSetValue} />
    </>
  );
}
