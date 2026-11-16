"use client";
import * as React from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { ArrowDown, ArrowUp, BarChart3, FilterX, Lock, MoreHorizontal, Plus, Search, SlidersHorizontal, UserRound } from "lucide-react";
import { endpoints, type LeadDto, type LeadPage, type LeadStageCounts, type LostReasonDto, type Member, type PipelineDto, type StageDto } from "@crm/contracts";
import { Status } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input, Select } from "@/components/ui/input";
import { Dialog, DialogActions, DialogContent, DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger, Tooltip } from "@/components/ui/overlays";
import { PageHeader, Panel } from "@/components/ui/panel";
import { Alert, EmptyState, ErrorState } from "@/components/ui/states";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { tabClass } from "@/components/ui/tabs";
import { ToastProvider, useToast } from "@/components/ui/toast";
import { NewLeadDialog } from "@/components/leads/new-lead-dialog";
import { browserApi, errorMessage } from "@/lib/client-api";
import { formatDate } from "@/lib/format";
import { listTotal, parseFilters, toCountsQuery, toListQuery, toSearch, type Filters } from "@/lib/lead-filters";
import { formatMoney, OUTCOME_LABEL, stageName } from "@/lib/leads";

type Props = { workspaceId: string; myUserId: string; pipelines: PipelineDto[]; lostReasons: LostReasonDto[]; initial: LeadPage | null; initialCounts: LeadStageCounts | null; members: Member[]; canCreate: boolean; canSetValue: boolean; canViewValue: boolean };
const SORTS = [["updated", "Last updated"], ["created", "Created"], ["close", "Expected close"]] as const;
const MAX_BULK = 100;
const CODE_TEXT: Record<string, string> = { not_found: "no longer exist", forbidden: "you may not move", lost_reason_required: "need a lost reason", version_conflict: "changed meanwhile", contact_deleted: "have a deleted contact", pipeline_archived: "are in an archived pipeline", invalid_body: "cannot go to that stage", rate_limited: "were blocked by the rate limit" };
const n = (x: number) => x.toLocaleString("en");

export function LeadsView(props: Props) {
  return <ToastProvider><Inner {...props} /></ToastProvider>;
}

/** A text box that edits locally and commits to the URL after a short pause, and follows the URL when it changes elsewhere (back button, Clear). */
function useDraft(value: string, commit: (v: string) => void) {
  const [draft, setDraft] = React.useState(value);
  const [seen, setSeen] = React.useState(value);
  const [sent, setSent] = React.useState(value);
  if (seen !== value) { setSeen(value); setSent(value); if (value !== sent) setDraft(value); } // changed elsewhere (back button, Clear), not by our own commit
  React.useEffect(() => {
    if (draft === value) return;
    const t = setTimeout(() => { setSent(draft); commit(draft); }, 350);
    return () => clearTimeout(t);
  }, [draft, value, commit]);
  return [draft, setDraft] as const;
}

function Inner({ workspaceId, myUserId, pipelines, lostReasons, initial, initialCounts, members, canCreate, canSetValue, canViewValue }: Props) {
  const sp = useSearchParams();
  const f = React.useMemo(() => parseFilters(sp, pipelines), [sp, pipelines]);
  const toast = useToast();
  const [showFilters, setShowFilters] = React.useState(false);
  const [page, setPage] = React.useState<LeadPage>(initial ?? { items: [], nextCursor: null });
  const [counts, setCounts] = React.useState<LeadStageCounts | null>(initialCounts);
  const [status, setStatus] = React.useState<"idle" | "loading" | "error">(initial ? "idle" : "error");
  const [errorText, setErrorText] = React.useState<string | null>(null);
  const [moreBusy, setMoreBusy] = React.useState(false);
  const [newOpen, setNewOpen] = React.useState(false);
  const [announce, setAnnounce] = React.useState("");
  const [selected, setSelected] = React.useState<Set<string>>(new Set());
  const [moving, setMoving] = React.useState<string[] | null>(null);
  const seq = React.useRef(0);
  const first = React.useRef(true);
  const active = pipelines.filter((p) => !p.archived);
  const chipsPipeline = pipelines.find((p) => p.id === f.pipeline) ?? (active.length === 1 ? active[0] : undefined);
  const defaultFilters = parseFilters(new URLSearchParams(), pipelines);
  const filtered = toSearch(f, pipelines) !== toSearch(defaultFilters, pipelines);
  const countsKey = JSON.stringify(toCountsQuery(f, pipelines));
  const listKey = sp.toString();

  const go = React.useCallback((patch: Partial<Filters>, mode: "pushState" | "replaceState" = "pushState") => {
    const qs = toSearch({ ...parseFilters(new URLSearchParams(window.location.search), pipelines), ...patch }, pipelines);
    window.history[mode](null, "", qs ? `?${qs}` : window.location.pathname);
  }, [pipelines]);
  const setQ = React.useCallback((v: string) => go({ q: v }, "replaceState"), [go]);
  const setMin = React.useCallback((v: string) => go({ min: v }, "replaceState"), [go]);
  const setMax = React.useCallback((v: string) => go({ max: v }, "replaceState"), [go]);
  const setSource = React.useCallback((v: string) => go({ source: v }, "replaceState"), [go]);
  const [qDraft, setQDraft] = useDraft(f.q, setQ);
  const [minDraft, setMinDraft] = useDraft(f.min, setMin);
  const [maxDraft, setMaxDraft] = useDraft(f.max, setMax);
  const [sourceDraft, setSourceDraft] = useDraft(f.source, setSource);

  const load = React.useCallback(async () => {
    const mine = ++seq.current;
    setStatus("loading");
    const r = await browserApi.call(endpoints.listLeads, { params: { workspaceId }, query: toListQuery(f, pipelines) });
    if (mine !== seq.current) return;
    if (!r.ok) { setErrorText(errorMessage(r.error)); setStatus("error"); return; }
    setPage(r.data); setStatus("idle"); setErrorText(null);
    setSelected((s) => new Set([...s].filter((id) => r.data.items.some((l) => l.id === id)))); // a changed list keeps only the selected leads still in it
    setAnnounce(`${r.data.items.length}${r.data.nextCursor ? "+" : ""} results`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId, listKey, pipelines]);
  const loadCounts = React.useCallback(async () => {
    const r = await browserApi.call(endpoints.leadStageCounts, { params: { workspaceId }, query: toCountsQuery(f, pipelines) });
    setCounts(r.ok ? r.data : null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId, countsKey, pipelines]);

  React.useEffect(() => {
    if (first.current) { first.current = false; return; }
    void load();
  }, [load]);
  const firstCounts = React.useRef(true);
  React.useEffect(() => {
    if (firstCounts.current) { firstCounts.current = false; return; }
    void loadCounts();
  }, [loadCounts]);

  async function more() {
    if (!page.nextCursor) return;
    setMoreBusy(true);
    const r = await browserApi.call(endpoints.listLeads, { params: { workspaceId }, query: toListQuery(f, pipelines, page.nextCursor) });
    setMoreBusy(false);
    if (!r.ok) { setErrorText(errorMessage(r.error)); return; }
    setErrorText(null);
    setPage((p) => ({ items: [...p.items, ...r.data.items], nextCursor: r.data.nextCursor }));
    setAnnounce(`${r.data.items.length} more loaded`);
  }

  const href = (l: LeadDto) => `/w/${workspaceId}/leads/${l.id}`;
  const stageBadge = (l: LeadDto) => <Status hue={l.outcome === "won" ? 2 : l.outcome === "lost" ? "muted" : ((((stageName(pipelines, l)?.position ?? 0) % 6) + 1) as 1 | 2 | 3 | 4 | 5 | 6)}>{stageName(pipelines, l)?.name ?? OUTCOME_LABEL[l.outcome]}</Status>;
  const value = (l: LeadDto) =>
    l.valueHidden ? <Tooltip label="You don't have access to lead value on this record." side="top"><span className="inline-flex items-center gap-1 text-fg-subtle"><Lock className="size-3" aria-hidden />Hidden</span></Tooltip>
      : l.valueMinor !== null && l.currency ? <span className="tabular-nums">{formatMoney(l.valueMinor, l.currency)}</span> : <span className="text-fg-subtle">—</span>;

  // ---- stage chips
  const chipStages = (chipsPipeline?.stages.filter((s) => !s.archived) ?? []).sort((a, b) => ({ open: 0, won: 1, lost: 2 })[a.kind] - ({ open: 0, won: 1, lost: 2 })[b.kind] || a.position - b.position);
  const countOf = (id: string) => counts?.items.find((x) => x.stageId === id)?.count ?? 0;
  const allOpen = chipStages.filter((s) => s.kind === "open").reduce((t, s) => t + countOf(s.id), 0);
  const total = counts ? listTotal(counts.items, f, pipelines) : null;

  // ---- selection
  const items = page.items;
  const toggle = (id: string) => setSelected((s) => {
    const x = new Set(s);
    if (x.has(id)) x.delete(id);
    else if (x.size >= MAX_BULK) toast(`You can change up to ${MAX_BULK} leads at a time.`, "error");
    else x.add(id);
    return x;
  });
  const pageIds = items.slice(0, MAX_BULK).map((l) => l.id);
  const allOnPage = pageIds.length > 0 && pageIds.every((id) => selected.has(id));
  const selectAll = () => { setSelected(allOnPage ? new Set() : new Set(pageIds)); if (!allOnPage && items.length > MAX_BULK) toast(`Selected the first ${MAX_BULK}. A change applies to at most ${MAX_BULK} leads at a time.`); };
  const headRef = React.useRef<HTMLInputElement>(null);
  React.useEffect(() => { if (headRef.current) headRef.current.indeterminate = selected.size > 0 && !allOnPage; }, [selected, allOnPage]);

  const checkbox = (l: LeadDto) => (
    <input type="checkbox" className="size-4 accent-[var(--accent)]" aria-label={`Select ${l.title}`} checked={selected.has(l.id)} onChange={() => toggle(l.id)} />
  );

  async function afterMove(movedIds: string[]) {
    setSelected((s) => { const x = new Set(s); movedIds.forEach((id) => x.delete(id)); return x; });
    await Promise.all([load(), loadCounts()]);
  }

  return (
    <>
      <PageHeader title="Leads" description="Track every lead from first contact to won or lost." actions={canCreate && active.length > 0 ? <Button variant="primary" onClick={() => setNewOpen(true)}><Plus className="size-4" aria-hidden />New lead</Button> : undefined} />

      {chipsPipeline && (
        <div className="relative mb-3 flex gap-1.5 overflow-x-auto pb-1" role="group" aria-label="Filter by stage">
          <button type="button" className={tabClass(!f.stage && f.status === "open")} aria-pressed={!f.stage && f.status === "open"} onClick={() => go({ stage: "", status: "open" })}>All{" "}<span className="tabular-nums">{n(allOpen)}</span><span className="sr-only"> open leads</span></button>
          {chipStages.map((s) => (
            <button key={s.id} type="button" className={tabClass(f.stage === s.id)} aria-pressed={f.stage === s.id} onClick={() => go({ stage: s.id, status: "all" })}>{s.name}{" "}<span className="tabular-nums">{n(countOf(s.id))}</span><span className="sr-only"> {countOf(s.id) === 1 ? "lead" : "leads"}</span></button>
          ))}
        </div>
      )}

      <div className="mb-3 flex flex-wrap items-center gap-2" role="search" aria-label="Filter leads">
        <div className="relative min-w-0 flex-1 basis-56 sm:max-w-xs">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-fg-subtle" aria-hidden />
          <Input aria-label="Search leads by title" placeholder="Search by title" className="pl-8" value={qDraft} onChange={(e) => setQDraft(e.target.value)} />
        </div>
        <Button variant="secondary" aria-pressed={f.owner === myUserId} onClick={() => go({ owner: f.owner === myUserId ? "" : myUserId })} className={f.owner === myUserId ? "border-fg" : undefined}><UserRound className="size-4" aria-hidden />My leads</Button>
        <Button variant="secondary" className="md:hidden" aria-expanded={showFilters} aria-controls="lead-filters" onClick={() => setShowFilters((v) => !v)}><SlidersHorizontal aria-hidden />Filters{filtered ? " (on)" : ""}</Button>
        <div id="lead-filters" className={`${showFilters ? "flex" : "hidden"} w-full flex-wrap items-center gap-2 md:contents`}>
          <Select aria-label="Status" wrapperClassName="w-auto max-md:min-w-[9rem] max-md:flex-1" value={f.status} onChange={(e) => go({ status: e.target.value as Filters["status"], stage: "" })}>
            <option value="open">Open</option><option value="won">Won</option><option value="lost">Lost</option><option value="all">All statuses</option>
          </Select>
          {active.length > 1 && (
            <Select aria-label="Pipeline" wrapperClassName="w-auto max-md:min-w-[9rem] max-md:flex-1" value={f.pipeline} onChange={(e) => go({ pipeline: e.target.value, stage: "", status: "open" })}>
              <option value="">All pipelines</option>{active.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </Select>
          )}
          <Select aria-label="Owner" wrapperClassName="w-auto max-md:min-w-[9rem] max-md:flex-1" value={f.owner} onChange={(e) => go({ owner: e.target.value })}>
            <option value="">Anyone</option><option value={myUserId}>Me</option>{members.filter((m) => m.userId !== myUserId).map((m) => <option key={m.userId} value={m.userId}>{m.name}</option>)}
          </Select>
          <Input aria-label="Source" placeholder="Source" className="w-28 max-md:min-w-[9rem] max-md:flex-1" value={sourceDraft} onChange={(e) => setSourceDraft(e.target.value)} />
          {canViewValue && (
            <>
              <Input aria-label="Minimum value" inputMode="decimal" placeholder="Min value" className="w-28 max-md:min-w-[9rem] max-md:flex-1" value={minDraft} onChange={(e) => setMinDraft(e.target.value.replace(/[^\d.]/g, ""))} />
              <Input aria-label="Maximum value" inputMode="decimal" placeholder="Max value" className="w-28 max-md:min-w-[9rem] max-md:flex-1" value={maxDraft} onChange={(e) => setMaxDraft(e.target.value.replace(/[^\d.]/g, ""))} />
            </>
          )}
          <Select aria-label="Last activity" wrapperClassName="w-auto max-md:min-w-[9rem] max-md:flex-1" value={f.active} onChange={(e) => go({ active: e.target.value as Filters["active"] })}>
            <option value="">Any activity</option><option value="7">Last 7 days</option><option value="30">Last 30 days</option><option value="90">Last 90 days</option>
          </Select>
          <div className="ml-auto flex items-center gap-1">
            <Select aria-label="Sort by" wrapperClassName="w-auto max-md:min-w-[9rem] max-md:flex-1" value={f.sort} onChange={(e) => go({ sort: e.target.value as Filters["sort"] })}>{SORTS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</Select>
            <Button variant="secondary" icon aria-label={f.dir === "desc" ? "Sorted descending. Switch to ascending" : "Sorted ascending. Switch to descending"} onClick={() => go({ dir: f.dir === "desc" ? "asc" : "desc" })}>{f.dir === "desc" ? <ArrowDown className="size-4" aria-hidden /> : <ArrowUp className="size-4" aria-hidden />}</Button>
            {filtered && <Button variant="ghost" onClick={() => window.history.pushState(null, "", window.location.pathname)}><FilterX className="size-4" aria-hidden />Clear</Button>}
          </div>
        </div>
      </div>
      <p className="sr-only" role="status" aria-live="polite">{announce}</p>

      {selected.size > 0 && canCreate && (
        <div role="region" aria-label="Bulk actions" className="sticky top-0 z-10 mb-3 flex flex-wrap items-center gap-2 rounded-card border border-line bg-surface px-3 py-2 shadow-sheet">
          <span className="text-sm font-medium text-fg" aria-live="polite">{selected.size} selected</span>
          <Button variant="primary" size="sm" onClick={() => setMoving([...selected])}>Change stage</Button>
          <Button variant="ghost" size="sm" onClick={() => setSelected(new Set())}>Clear selection</Button>
        </div>
      )}

      {status === "error" && items.length === 0 ? (
        <Panel><ErrorState description={errorText ?? undefined} onRetry={() => void load()} /></Panel>
      ) : status === "loading" && items.length === 0 ? (
        <Panel aria-busy="true" role="status"><div aria-label="Loading leads">{Array.from({ length: 6 }).map((_, i) => <div key={i} className="flex gap-3 border-b border-line px-4 py-3 last:border-0"><Skeleton className="h-4 w-56" /><Skeleton className="ml-auto h-4 w-24" /></div>)}</div></Panel>
      ) : items.length === 0 ? (
        <Panel>
          {filtered ? <EmptyState icon={BarChart3} title="No leads match these filters" description="Try a different search or clear the filters." action={<Button onClick={() => window.history.pushState(null, "", window.location.pathname)}>Clear filters</Button>} />
            : <EmptyState icon={BarChart3} title="No open leads" description={active.length === 0 ? "An admin needs to set up a pipeline first." : "Create one to start tracking it through the pipeline. Won and lost ones are under Status."} action={canCreate && active.length > 0 ? <Button variant="primary" onClick={() => setNewOpen(true)}><Plus className="size-4" aria-hidden />New lead</Button> : undefined} />}
        </Panel>
      ) : (
        <div className={status === "loading" ? "opacity-60 transition-opacity" : "transition-opacity"} aria-busy={status === "loading"}>
          {errorText && status === "error" && <Alert tone="error" className="mb-3">{errorText}</Alert>}
          <Panel className="t-table overflow-hidden">
            <Table scrollLabel="Leads">
              <THead><TR className="hover:bg-transparent">
                {canCreate && <TH className="w-10 pr-0"><input ref={headRef} type="checkbox" className="size-4 accent-[var(--accent)]" aria-label="Select all on this page" checked={allOnPage} onChange={selectAll} /></TH>}
                <TH>Title</TH><TH>Contact</TH><TH>Stage</TH><TH className="text-right">Value</TH><TH>Close</TH><TH>Owner</TH>{canCreate && <TH className="w-10"><span className="sr-only">Actions</span></TH>}
              </TR></THead>
              <TBody>
                {items.map((l) => (
                  <TR key={l.id} className={selected.has(l.id) ? "group bg-selected" : "group"}>
                    {canCreate && <TD className="w-10 pr-0">{checkbox(l)}</TD>}
                    <TD className="max-w-xs"><Link href={href(l)} className="block truncate font-medium text-fg hover:text-accent-fg focus-visible:outline-offset-2">{l.title}</Link></TD>
                    <TD className="max-w-48 truncate text-fg-muted">{l.primaryContact.name}</TD>
                    <TD>{stageBadge(l)}</TD>
                    <TD className="text-right">{value(l)}</TD>
                    <TD className="whitespace-nowrap text-fg-muted">{l.expectedCloseDate ? formatDate(`${l.expectedCloseDate}T12:00:00Z`, "UTC") : "—"}</TD>
                    <TD className="text-fg-muted">{l.owner?.name ?? "Unassigned"}</TD>
                    {canCreate && (
                      <TD className="w-10 pl-0">
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild><Button variant="ghost" icon size="sm" aria-label={`Change stage of ${l.title}`}><MoreHorizontal className="size-4" aria-hidden /></Button></DropdownMenuTrigger>
                          <DropdownMenuContent align="end"><DropdownMenuItem onSelect={() => setMoving([l.id])}>Change stage</DropdownMenuItem></DropdownMenuContent>
                        </DropdownMenu>
                      </TD>
                    )}
                  </TR>
                ))}
              </TBody>
            </Table>
          </Panel>
          <ul className="t-cards-flex flex-col gap-2" aria-label="Leads">
            {items.map((l) => (
              <li key={l.id} className="flex items-start gap-1 rounded-card bg-surface shadow-sheet">
                {canCreate && <label className="flex size-11 shrink-0 items-center justify-center">{checkbox(l)}</label>}
                <Link href={href(l)} className={`block min-w-0 flex-1 rounded-card p-3 active:bg-hover ${canCreate ? "pl-0" : ""}`}>
                  <div className="flex items-start justify-between gap-2"><span className="min-w-0 break-words font-medium text-fg">{l.title}</span>{stageBadge(l)}</div>
                  <div className="mt-1 text-sm text-fg-muted">{l.primaryContact.name}</div>
                  <div className="mt-2 flex items-center justify-between text-sm"><span>{value(l)}</span><span className="text-fg-subtle">{l.owner?.name ?? "Unassigned"}</span></div>
                </Link>
              </li>
            ))}
          </ul>
          <div className="mt-3 flex flex-col items-center gap-2 text-sm text-fg-muted">
            {errorText && status !== "error" && <p role="alert" className="text-danger-fg">{errorText}</p>}
            <p>{total !== null ? `Showing ${n(items.length)} of ${n(Math.max(total, items.length))}` : `${n(items.length)}${page.nextCursor ? "+" : ""} ${items.length === 1 && !page.nextCursor ? "lead" : "leads"}`}</p>
            {page.nextCursor && <Button onClick={() => void more()} disabled={moreBusy}>{moreBusy ? "Loading…" : "Load more"}</Button>}
          </div>
        </div>
      )}
      <NewLeadDialog key={String(newOpen)} open={newOpen} onOpenChange={setNewOpen} workspaceId={workspaceId} pipelines={pipelines} canSetValue={canSetValue} />
      {moving && <StageDialog key={moving.join()} ids={moving} leads={items} pipelines={pipelines} lostReasons={lostReasons} workspaceId={workspaceId} onClose={() => setMoving(null)} onDone={(moved) => void afterMove(moved)} />}
    </>
  );
}

/** Confirms and applies a stage change for one or many leads (the same call for both). Failures are listed, never swallowed; failed leads stay selected. */
function StageDialog({ ids, leads, pipelines, lostReasons, workspaceId, onClose, onDone }: { ids: string[]; leads: LeadDto[]; pipelines: PipelineDto[]; lostReasons: LostReasonDto[]; workspaceId: string; onClose: () => void; onDone: (moved: string[]) => void }) {
  const toast = useToast();
  const [mine] = React.useState(() => leads.filter((l) => ids.includes(l.id))); // fixed while the dialog is open, the list behind it reloads
  const pipelineIds = new Set(mine.map((l) => l.pipelineId));
  const pipeline = pipelines.find((p) => p.id === mine[0]?.pipelineId);
  const stages: StageDto[] = (pipeline?.stages.filter((s) => !s.archived) ?? []).sort((a, b) => ({ open: 0, won: 1, lost: 2 })[a.kind] - ({ open: 0, won: 1, lost: 2 })[b.kind] || a.position - b.position);
  const [stageId, setStageId] = React.useState("");
  const [reasonId, setReasonId] = React.useState(lostReasons[0]?.id ?? "");
  const [busy, setBusy] = React.useState(false);
  const [problem, setProblem] = React.useState<string | null>(null);
  const target = stages.find((s) => s.id === stageId);
  const mixed = pipelineIds.size > 1;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!target) return;
    setBusy(true); setProblem(null);
    const r = await browserApi.call(endpoints.bulkMoveLeads, { params: { workspaceId }, body: { leadIds: ids, stageId: target.id, ...(target.kind === "lost" ? { lostReasonId: reasonId } : {}) } });
    setBusy(false);
    if (!r.ok) { setProblem(errorMessage(r.error)); return; }
    const done = r.data.results.filter((x) => x.ok).map((x) => x.id);
    const failed = r.data.results.filter((x) => !x.ok);
    if (failed.length === 0) { toast(`${n(done.length)} ${done.length === 1 ? "lead" : "leads"} moved to ${target.name}.`); onDone(done); onClose(); return; }
    const byCode = new Map<string, number>();
    for (const x of failed) byCode.set(x.code, (byCode.get(x.code) ?? 0) + 1);
    setProblem(`${n(done.length)} moved to ${target.name}. ${n(failed.length)} not moved: ${[...byCode].map(([c, k]) => `${k} ${CODE_TEXT[c] ?? "could not be moved"}`).join(", ")}.`);
    onDone(done);
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent title={ids.length === 1 ? "Change stage" : `Change stage of ${n(ids.length)} leads`} description="Each lead is moved as if you had moved it yourself: history, automations and conversion events follow.">
        <form className="flex flex-col gap-4" onSubmit={submit}>
          {mixed && <Alert tone="warning">These leads are in different pipelines. Filter by one pipeline and select again.</Alert>}
          <Field label="New stage">{(p) => <Select {...p} value={stageId} disabled={mixed} onChange={(e) => setStageId(e.target.value)}><option value="">Choose a stage</option>{stages.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</Select>}</Field>
          {target?.kind === "lost" && <Field label="Lost reason">{(p) => <Select {...p} value={reasonId} onChange={(e) => setReasonId(e.target.value)}>{lostReasons.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}</Select>}</Field>}
          {problem && <Alert tone="warning">{problem}</Alert>}
          <DialogActions><Button type="button" onClick={onClose}>{problem ? "Close" : "Cancel"}</Button><Button type="submit" variant="primary" disabled={!target || mixed || busy || (target.kind === "lost" && !reasonId)}>{busy ? "Moving…" : `Move ${n(ids.length)} ${ids.length === 1 ? "lead" : "leads"}`}</Button></DialogActions>
        </form>
      </DialogContent>
    </Dialog>
  );
}
