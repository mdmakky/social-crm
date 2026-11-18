"use client";
import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowDown, ArrowUp, ArrowUpDown, Bookmark, Columns3, Download, FilterX, Lock, Pencil, Plus, RefreshCw, Search, SlidersHorizontal, Trash2, Upload, Users } from "lucide-react";
import { CONTACT_COLUMNS, endpoints, type ContactColumn, type ContactListQuery, type ContactPage, type ContactStageCounts, type ContactSummary, type CustomField, type LifecycleStage, type LostReasonDto, type Member, type PipelineDto, type SavedView, type Tag, type ViewConfig } from "@crm/contracts";
import { Avatar } from "@/components/ui/avatar";
import { Badge, hueOf, Status } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Checkbox } from "@/components/ui/form-controls";
import { Input, Select } from "@/components/ui/input";
import { Dialog, DialogClose, DialogContent, DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger, DialogActions } from "@/components/ui/overlays";
import { PageHeader, Panel } from "@/components/ui/panel";
import { Alert, EmptyState, ErrorState } from "@/components/ui/states";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { tabClass } from "@/components/ui/tabs";
import { ToastProvider } from "@/components/ui/toast";
import { StageBadge, StageDialog, StageMenu } from "@/components/contacts/stage-control";
import { NewContactDialog } from "@/components/contacts/new-contact-dialog";
import { browserApi, errorMessage } from "@/lib/client-api";
import { COLUMN_LABEL, DEFAULT_COLUMNS, relativeTime, SORT_FOR_COLUMN, SORT_OPTIONS, sortOptionFor, sourceLabel, TAG_TONE } from "@/lib/contacts";
import { formatDate } from "@/lib/format";
import { formatMoney } from "@/lib/leads";
import { orderedStages, defaultPipeline } from "@/lib/contact-lead";

type Q = Pick<ContactListQuery, "search" | "lifecycleStageId" | "stageId" | "ownerId" | "tagIds" | "source" | "sort" | "dir">;
type Perms = { lead: boolean; viewValue: boolean; edit: boolean; import: boolean; export: boolean; shareViews: boolean; schema: boolean };
type Props = { workspaceId: string; timeZone: string; myUserId: string; initial: ContactPage | null; initialQuery: ContactListQuery; pipelines: PipelineDto[]; lostReasons: LostReasonDto[]; initialCounts: ContactStageCounts | null; stages: LifecycleStage[]; tags: Tag[]; members: Member[]; views: SavedView[]; fields: CustomField[]; perms: Perms };

const FILTERS: (keyof Q)[] = ["search", "lifecycleStageId", "stageId", "ownerId", "tagIds", "source"];
const MAX_BULK = 100;
const count = (x: number) => x.toLocaleString("en");
const hasFilters = (q: Q) => FILTERS.some((k) => !!q[k]);

export function ContactsView(props: Props) {
  return <ToastProvider><Inner {...props} /></ToastProvider>;
}

function Inner({ workspaceId, timeZone, myUserId, initial, initialQuery, pipelines, lostReasons, initialCounts, stages, tags, members, views: initialViews, fields, perms }: Props) {
  const [query, setQuery] = React.useState<Q>({ search: initialQuery.search, lifecycleStageId: initialQuery.lifecycleStageId, stageId: initialQuery.stageId, ownerId: initialQuery.ownerId, tagIds: initialQuery.tagIds, source: initialQuery.source, sort: initialQuery.sort ?? "lastActivity", dir: initialQuery.dir ?? "desc" });
  const [page, setPage] = React.useState<ContactPage>(initial ?? { items: [], nextCursor: null, total: 0 });
  const [status, setStatus] = React.useState<"idle" | "loading" | "error">(initial ? "idle" : "error");
  const [errorText, setErrorText] = React.useState<string | null>(null);
  const [moreBusy, setMoreBusy] = React.useState(false);
  const [viewColumns, setViewColumns] = React.useState<ContactColumn[] | null>(null);
  const [views, setViews] = React.useState(initialViews);
  const [activeView, setActiveView] = React.useState<string | null>(null);
  const [baseView, setBaseView] = React.useState<string | null>(null); // last applied or saved view; stays after filters change so it can be updated
  const [newOpen, setNewOpen] = React.useState(false);
  const [colsOpen, setColsOpen] = React.useState(false);
  const [saveOpen, setSaveOpen] = React.useState(false);
  const [renameOpen, setRenameOpen] = React.useState(false);
  const [deleteView, setDeleteView] = React.useState<SavedView | null>(null);
  const [exporting, setExporting] = React.useState(false);
  const [actionError, setActionError] = React.useState<string | null>(null);
  const [showFilters, setShowFilters] = React.useState(false);
  const [counts, setCounts] = React.useState<ContactStageCounts | null>(initialCounts);
  const [selected, setSelected] = React.useState<Set<string>>(new Set());
  const [moving, setMoving] = React.useState<string[] | null>(null);
  const seq = React.useRef(0);
  const first = React.useRef(true);
  const storeKey = `crm.contacts.columns.${workspaceId}`;

  // The column layout is a per-device convenience. useSyncExternalStore reads it after hydration without a mismatch.
  const stored = React.useSyncExternalStore(
    (cb) => { window.addEventListener("storage", cb); window.addEventListener("crm-columns", cb); return () => { window.removeEventListener("storage", cb); window.removeEventListener("crm-columns", cb); }; },
    () => { try { return localStorage.getItem(storeKey) ?? ""; } catch { return ""; } },
    () => "",
  );
  const storedColumns = React.useMemo(() => {
    try {
      const parsed = stored ? (JSON.parse(stored) as string[]) : null;
      return parsed && parsed.every((c) => (CONTACT_COLUMNS as readonly string[]).includes(c)) && parsed.includes("contact") ? (parsed as ContactColumn[]) : null;
    } catch { return null; }
  }, [stored]);
  const columns = viewColumns ?? storedColumns ?? DEFAULT_COLUMNS;
  // Editing columns by hand saves the personal layout; applying a saved view only overlays it.
  const saveColumns = (c: ContactColumn[]) => {
    setViewColumns(null);
    try { localStorage.setItem(storeKey, JSON.stringify(c)); window.dispatchEvent(new Event("crm-columns")); } catch { /* the layout just won't be remembered */ }
  };

  const toParams = (q: Q) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(q)) if (v && !(k === "sort" && v === "lastActivity") && !(k === "dir" && v === "desc")) p.set(k, String(v));
    return p;
  };

  // Counts follow the filters except the stage itself, so the chips always add up to the list.
  const { stageId: _sid, sort: _srt, dir: _dir, ...shared } = query;
  const countsKey = JSON.stringify(shared);
  const loadCounts = React.useCallback(async () => {
    const r = await browserApi.call(endpoints.contactStageCounts, { params: { workspaceId }, query: JSON.parse(countsKey) });
    setCounts(r.ok ? r.data : null);
  }, [workspaceId, countsKey]);
  const firstCounts = React.useRef(true);
  React.useEffect(() => {
    if (firstCounts.current) { firstCounts.current = false; return; }
    const t = setTimeout(() => void loadCounts(), 250);
    return () => clearTimeout(t);
  }, [loadCounts]);

  const load = React.useCallback(async (q: Q) => {
    const mine = ++seq.current;
    setStatus("loading");
    const res = await browserApi.call(endpoints.listContacts, { params: { workspaceId }, query: { ...q, limit: 25 } });
    if (mine !== seq.current) return; // a newer request superseded this one
    if (!res.ok) { setErrorText(errorMessage(res.error)); setStatus("error"); return; }
    setPage(res.data);
    setSelected((s) => new Set([...s].filter((id) => res.data.items.some((c) => c.id === id)))); // a changed list keeps only the selected contacts still in it
    setStatus("idle");
  }, [workspaceId]);

  React.useEffect(() => {
    if (first.current) { first.current = false; return; }
    const t = setTimeout(() => {
      const p = toParams(query).toString();
      window.history.replaceState(null, "", p ? `?${p}` : window.location.pathname);
      void load(query);
    }, 250);
    return () => clearTimeout(t);
  }, [query, load]);

  async function loadMore() {
    if (!page.nextCursor) return;
    setMoreBusy(true);
    const mine = seq.current;
    const res = await browserApi.call(endpoints.listContacts, { params: { workspaceId }, query: { ...query, limit: 25, cursor: page.nextCursor } });
    setMoreBusy(false);
    if (mine !== seq.current) return; // the filters changed while this page was loading: its rows belong to the old query
    if (!res.ok) return setErrorText(errorMessage(res.error));
    setErrorText(null);
    setPage((p) => ({ ...res.data, items: [...p.items, ...res.data.items] }));
  }

  const set = (patch: Partial<Q>) => { setActiveView(null); setQuery((q) => ({ ...q, ...patch })); };
  const clearFilters = () => set({ search: undefined, lifecycleStageId: undefined, stageId: undefined, ownerId: undefined, tagIds: undefined, source: undefined });
  const toggleSort = (col: ContactColumn) => {
    const s = SORT_FOR_COLUMN[col];
    if (!s) return;
    set({ sort: s, dir: query.sort === s && query.dir === "asc" ? "desc" : query.sort === s ? "asc" : s === "name" ? "asc" : "desc" });
  };

  const applyView = (v: SavedView) => {
    setActiveView(v.id);
    setBaseView(v.id);
    setViewColumns(v.config.columns);
    setQuery({ ...(v.config.filters as Q), sort: v.config.sort, dir: v.config.dir });
  };
  const currentConfig = (): ViewConfig => ({ columns, filters: Object.fromEntries(FILTERS.filter((k) => query[k]).map((k) => [k, query[k]])) as ViewConfig["filters"], sort: query.sort ?? "lastActivity", dir: query.dir ?? "desc" });

  const filtered = hasFilters(query);
  const stale = status === "error" && page.items.length > 0;
  async function doExport() {
    setExporting(true);
    setActionError(null);
    const { sort: _s, dir: _d, ...filters } = query;
    const res = await browserApi.call(endpoints.exportContacts, { params: { workspaceId }, query: filters });
    setExporting(false);
    if (!res.ok) return setActionError(errorMessage(res.error));
    const url = URL.createObjectURL(new Blob([res.data], { type: "text/csv" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = "contacts.csv";
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  const chipStages = orderedStages(defaultPipeline(pipelines));
  const countOf = (id: string) => counts?.items.find((x) => x.stageId === id)?.count ?? 0;
  const afterMove = (moved: string[]) => {
    setSelected((s) => { const x = new Set(s); moved.forEach((id) => x.delete(id)); return x; });
    void load(query);
    void loadCounts();
  };
  const toggle = (id: string) => setSelected((s) => {
    const x = new Set(s);
    if (x.has(id)) x.delete(id);
    else if (x.size >= MAX_BULK) setActionError(`You can change up to ${MAX_BULK} contacts at a time.`);
    else x.add(id);
    return x;
  });
  const pageIds = page.items.slice(0, MAX_BULK).map((c) => c.id);
  const allOnPage = pageIds.length > 0 && pageIds.every((id) => selected.has(id));
  const selectAll = () => setSelected(allOnPage ? new Set() : new Set(pageIds));
  const lead = { enabled: perms.lead, pipelines, lostReasons, workspaceId, viewValue: perms.viewValue, selected, toggle, allOnPage, selectAll, onChanged: afterMove };
  const sortLabel = SORT_OPTIONS.find((o) => o.value === `${query.sort}:${query.dir}`)?.label;

  return (
    <>
      <PageHeader
        title="Contacts"
        description={status === "error" && !page.items.length ? undefined : stale ? "Showing previous results" : `${page.total.toLocaleString("en-US")} ${page.total === 1 ? "contact" : "contacts"}${filtered ? " match your filters" : ""}`}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            {perms.import && <Button asChild variant="secondary"><Link href={`/w/${workspaceId}/contacts/import`}><Upload />Import</Link></Button>}
            {perms.export && <Button variant="secondary" onClick={() => void doExport()} loading={exporting}><Download />Export</Button>}
            {perms.edit && <Button variant="primary" onClick={() => setNewOpen(true)}><Plus />Add contact</Button>}
          </div>
        }
      />

      {chipStages.length > 0 && (
        <div className="mb-3 flex gap-1.5 overflow-x-auto pb-1" role="group" aria-label="Filter by stage">
          <button type="button" className={tabClass(!query.stageId)} aria-pressed={!query.stageId} onClick={() => set({ stageId: undefined })}>All{counts && <>{" "}<span className="tabular-nums">{count(counts.total)}</span></>}<span className="sr-only"> contacts</span></button>
          {chipStages.map((s) => (
            <button key={s.id} type="button" className={tabClass(query.stageId === s.id)} aria-pressed={query.stageId === s.id} onClick={() => set({ stageId: s.id })}>{s.name}{counts && <>{" "}<span className="tabular-nums">{count(countOf(s.id))}</span></>}<span className="sr-only"> {countOf(s.id) === 1 ? "contact" : "contacts"}</span></button>
          ))}
        </div>
      )}

      <div className="mb-3 flex flex-wrap items-center gap-1.5">
        <div className="relative min-w-0 flex-1 basis-56 sm:max-w-64">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-fg-subtle" aria-hidden />
          <Input aria-label="Search contacts" type="search" placeholder="Search name, email or phone" className="pl-8 shadow-none" value={query.search ?? ""} onChange={(e) => set({ search: e.target.value || undefined })} />
        </div>
        <Button variant="secondary" className="md:hidden" aria-expanded={showFilters} onClick={() => setShowFilters((s) => !s)}><SlidersHorizontal />Filters{filtered ? " (on)" : ""}</Button>
        <div className={`${showFilters ? "flex" : "hidden"} w-full flex-wrap items-center gap-1 md:flex md:w-auto`}>
          <Select aria-label="Lifecycle" quiet active={!!query.lifecycleStageId} className="w-auto" value={query.lifecycleStageId ?? ""} onChange={(e) => set({ lifecycleStageId: e.target.value || undefined })}>
            <option value="">Any lifecycle</option>
            {stages.filter((s) => !s.archived).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </Select>
          <Select aria-label="Owner" quiet active={!!query.ownerId} className="w-auto" value={query.ownerId ?? ""} onChange={(e) => set({ ownerId: e.target.value || undefined })}>
            <option value="">All owners</option>
            <option value="me">Me</option>
            <option value="unassigned">Unassigned</option>
            {members.filter((m) => m.userId !== myUserId).map((m) => <option key={m.userId} value={m.userId}>{m.name}</option>)}
          </Select>
          <Select aria-label="Tag" quiet active={!!query.tagIds} className="w-auto" value={query.tagIds ?? ""} onChange={(e) => set({ tagIds: e.target.value || undefined })}>
            <option value="">Any tag</option>
            {tags.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </Select>
          <Select aria-label="Source" quiet active={!!query.source} className="w-auto" value={query.source ?? ""} onChange={(e) => set({ source: (e.target.value || undefined) as Q["source"] })}>
            <option value="">All sources</option>
            {["manual", "import", "messenger", "instagram", "whatsapp", "telegram", "email", "web_chat", "facebook_lead_ad", "web_form", "referral", "other"].map((s) => <option key={s} value={s}>{sourceLabel(s)}</option>)}
          </Select>
          {filtered && <Button variant="ghost" onClick={clearFilters}><FilterX />Clear</Button>}
        </div>
        <div className="ml-auto flex items-center gap-2">
          <Select aria-label="Sort by" wrapperClassName="t-cards" className="w-auto" value={sortOptionFor(query.sort, query.dir)} onChange={(e) => { if (e.target.value === "custom") return; const [s, d] = e.target.value.split(":"); set({ sort: s as Q["sort"], dir: d as Q["dir"] }); }}>
            {sortOptionFor(query.sort, query.dir) === "custom" && <option value="custom">Custom order</option>}
            {SORT_OPTIONS.filter((o) => perms.viewValue || !o.value.startsWith("value")).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </Select>
          <ViewsMenu views={views} active={activeView} base={baseView} canManageShared={perms.shareViews} onApply={applyView} onSave={() => setSaveOpen(true)} onRename={(v) => { setBaseView(v.id); setRenameOpen(true); }} onUpdate={async (v) => { const r = await browserApi.call(endpoints.updateView, { params: { workspaceId, viewId: v.id }, body: { config: currentConfig() } }); if (!r.ok) return setActionError(errorMessage(r.error)); setViews((x) => x.map((y) => (y.id === v.id ? r.data : y))); }} onDelete={setDeleteView} />
          <Button variant="ghost" className="t-table-inline" onClick={() => setColsOpen(true)}><Columns3 />Columns</Button>
        </div>
      </div>

      {selected.size > 0 && perms.lead && (
        <div role="region" aria-label="Bulk actions" className="sticky top-0 z-10 mb-3 flex flex-wrap items-center gap-2 rounded-card border border-line bg-surface px-3 py-2 shadow-sheet">
          <span className="text-sm font-medium text-fg" aria-live="polite">{selected.size} selected</span>
          <Button variant="primary" size="sm" onClick={() => setMoving([...selected])}>Change stage</Button>
          <Button variant="ghost" size="sm" onClick={() => setSelected(new Set())}>Clear selection</Button>
        </div>
      )}
      {actionError && <Alert tone="error" className="mb-3">{actionError}</Alert>}
      {errorText && page.items.length > 0 && (
        <Alert tone="error" className="mb-3">
          <span className="flex flex-wrap items-center justify-between gap-2">{errorText}{stale && <Button size="sm" onClick={() => void load(query)}><RefreshCw />Retry</Button>}</span>
        </Alert>
      )}

      <Panel className={`overflow-hidden ${status === "loading" || stale ? "opacity-70 transition-opacity" : "transition-opacity"}`} aria-busy={status === "loading"}>
        {status === "error" && page.items.length === 0 ? (
          <ErrorState title="Contacts could not be loaded" description={errorText ?? "Check your connection and try again."} onRetry={() => void load(query)} />
        ) : page.items.length === 0 && status !== "loading" ? (
          filtered ? (
            <EmptyState icon={FilterX} title="No contacts match these filters" description="Try a different search or clear the filters." action={<Button onClick={clearFilters}>Clear filters</Button>} />
          ) : (
            <EmptyState
              icon={Users}
              title="No contacts yet"
              description="Add people, or import a spreadsheet."
              action={<div className="flex flex-wrap justify-center gap-2">{perms.edit && <Button variant="primary" onClick={() => setNewOpen(true)}><Plus />Add contact</Button>}{perms.import && <Button asChild variant="secondary"><Link href={`/w/${workspaceId}/contacts/import`}><Upload />Import a CSV</Link></Button>}</div>}
            />
          )
        ) : (
          <>
            <div className="t-table">
              <ContactsTable items={page.items} columns={columns} query={query} onSort={toggleSort} workspaceId={workspaceId} timeZone={timeZone} lead={lead} />
            </div>
            <ul className="t-cards">
              {page.items.map((c) => <ContactCard key={c.id} c={c} workspaceId={workspaceId} timeZone={timeZone} pipelines={pipelines} />)}
            </ul>
            <div className="flex items-center justify-between gap-3 border-t border-line-card px-4 py-2.5 text-sm text-fg-subtle">
              <span role="status">{status === "loading" ? "Updating…" : `${stale ? "Showing previous results; the last search failed. " : sortLabel ? `Sorted by ${sortLabel}. ` : ""}Showing ${page.items.length.toLocaleString("en-US")} of ${page.total.toLocaleString("en-US")}`}</span>
              {page.nextCursor && <Button onClick={loadMore} loading={moreBusy} disabled={status === "loading"}>Load more</Button>}
            </div>
          </>
        )}
      </Panel>

      {moving && <StageDialog key={moving.join()} ids={moving} pipelines={pipelines} lostReasons={lostReasons} workspaceId={workspaceId} onClose={() => setMoving(null)} onDone={(moved) => afterMove(moved)} />}
      <NewContactDialog open={newOpen} onOpenChange={setNewOpen} workspaceId={workspaceId} stages={stages} members={members} fields={fields} myUserId={myUserId} />
      <ColumnsDialog open={colsOpen} onOpenChange={setColsOpen} columns={columns} onChange={(c) => { setActiveView(null); saveColumns(c); }} />
      <ViewNameDialog open={renameOpen} onOpenChange={setRenameOpen} view={views.find((v) => v.id === baseView) ?? null} onSave={async (name) => { const v = views.find((x) => x.id === baseView); if (!v) return null; const r = await browserApi.call(endpoints.updateView, { params: { workspaceId, viewId: v.id }, body: { name } }); if (!r.ok) return errorMessage(r.error); setViews((x) => x.map((y) => (y.id === v.id ? r.data : y)).sort((a, b) => a.name.localeCompare(b.name))); return null; }} />
      <DeleteViewDialog view={deleteView} onClose={() => setDeleteView(null)} onConfirm={async (v) => { const r = await browserApi.call(endpoints.deleteView, { params: { workspaceId, viewId: v.id } }); if (!r.ok) return errorMessage(r.error); setViews((x) => x.filter((y) => y.id !== v.id)); if (activeView === v.id) setActiveView(null); if (baseView === v.id) setBaseView(null); return null; }} />
      <SaveViewDialog open={saveOpen} onOpenChange={setSaveOpen} canShare={perms.shareViews} onSave={async (name, shared) => { const r = await browserApi.call(endpoints.createView, { params: { workspaceId }, body: { name, shared, config: currentConfig() } }); if (!r.ok) return errorMessage(r.error); setViews((v) => [...v, r.data].sort((a, b) => a.name.localeCompare(b.name))); setActiveView(r.data.id); setBaseView(r.data.id); return null; }} />
    </>
  );
}

type LeadCtx = { enabled: boolean; pipelines: PipelineDto[]; lostReasons: LostReasonDto[]; workspaceId: string; viewValue: boolean; selected: Set<string>; toggle: (id: string) => void; allOnPage: boolean; selectAll: () => void; onChanged: (ids: string[]) => void };

function ContactsTable({ items, columns, query, onSort, workspaceId, timeZone, lead }: { items: ContactSummary[]; columns: ContactColumn[]; query: Q; onSort: (c: ContactColumn) => void; workspaceId: string; timeZone: string; lead: LeadCtx }) {
  const router = useRouter();
  const headRef = React.useRef<HTMLInputElement>(null);
  React.useEffect(() => { if (headRef.current) headRef.current.indeterminate = lead.selected.size > 0 && !lead.allOnPage; }, [lead.selected, lead.allOnPage]);
  const sortKey = (c: ContactColumn) => (c === "value" && !lead.viewValue ? undefined : SORT_FOR_COLUMN[c]);
  return (
    <Table scrollLabel="Contacts table, scrolls sideways when columns do not fit">
      <THead>
        <tr>
          {lead.enabled && <TH className="sticky left-0 z-10 w-10 pr-0"><input ref={headRef} type="checkbox" className="size-4 accent-[var(--accent)]" aria-label="Select all on this page" checked={lead.allOnPage} onChange={lead.selectAll} /></TH>}
          {columns.map((col) => {
            const s = sortKey(col);
            const active = s && query.sort === s;
            return (
              <TH key={col} className={col === "contact" ? `sticky z-10 ${lead.enabled ? "left-10" : "left-0"}` : undefined} aria-sort={active ? (query.dir === "asc" ? "ascending" : "descending") : s ? "none" : undefined}>
                {s ? (
                  <button type="button" onClick={() => onSort(col)} className="press group/sort inline-flex min-h-6 min-w-6 items-center gap-1 rounded py-1 text-xs font-medium text-fg-subtle hover:text-fg pointer-coarse:min-h-11 pointer-coarse:min-w-11">
                    {COLUMN_LABEL[col]}
                    {active ? (query.dir === "asc" ? <ArrowUp className="size-3" aria-hidden /> : <ArrowDown className="size-3" aria-hidden />) : <ArrowUpDown className="size-3 text-fg-disabled opacity-0 transition-opacity duration-[var(--dur-fast)] group-hover/sort:opacity-100 group-focus-visible/sort:opacity-100" aria-hidden />}
                  </button>
                ) : COLUMN_LABEL[col]}
              </TH>
            );
          })}
        </tr>
      </THead>
      <TBody>
        {items.map((c) => (
          <TR key={c.id} className={`group cursor-pointer hover:bg-row-hover ${lead.selected.has(c.id) ? "bg-selected" : "bg-surface"}`} onClick={(e) => { if (!(e.target as HTMLElement).closest("a,button,input,label")) router.push(`/w/${workspaceId}/contacts/${c.id}`); }}>
            {lead.enabled && <TD className="sticky left-0 z-10 w-10 bg-inherit pr-0"><input type="checkbox" className="size-4 accent-[var(--accent)]" aria-label={`Select ${c.name}`} checked={lead.selected.has(c.id)} onChange={() => lead.toggle(c.id)} /></TD>}
            {columns.map((col) => <TD key={col} className={col === "contact" ? `sticky z-10 w-[22rem] min-w-60 max-w-[22rem] bg-inherit ${lead.enabled ? "left-10" : "left-0"}` : "whitespace-nowrap"}>{cell(col, c, workspaceId, timeZone, lead)}</TD>)}
          </TR>
        ))}
      </TBody>
    </Table>
  );
}

/** Well-known stage names get a meaningful color (early = sky, engaged = indigo, won = green, lost = rose); custom stages hash to a stable hue. */
const STAGE_HUE: Record<string, 1 | 2 | 3 | 4 | 5 | 6> = { new: 5, lead: 5, subscriber: 5, qualified: 1, opportunity: 3, customer: 6, evangelist: 2, churned: 4, lost: 4 };

/** Lifecycle stage is a state, not a label: dot and plain text, so it never reads as a tag pill. */
function Stage({ name }: { name: string }) {
  return <Status hue={STAGE_HUE[name.trim().toLowerCase()] ?? hueOf(name)}>{name}</Status>;
}

/** An empty value: a quiet dash on screen, the full words for assistive tech. */
const Empty = ({ children }: { children: string }) => <span className="text-fg-disabled"><span aria-hidden>—</span><span className="sr-only">{children}</span></span>;

function ValueCell({ c }: { c: ContactSummary }) {
  const l = c.lead;
  if (l?.valueHidden) return <span className="inline-flex items-center gap-1 text-fg-subtle" title="You don't have access to values."><Lock className="size-3" aria-hidden />Hidden</span>;
  return l && l.valueMinor !== null && l.currency ? <span className="tnum">{formatMoney(l.valueMinor, l.currency)}</span> : <Empty>No value</Empty>;
}

function cell(col: ContactColumn, c: ContactSummary, workspaceId: string, timeZone: string, lead: LeadCtx): React.ReactNode {
  switch (col) {
    case "stage":
      return (
        <span className="inline-flex items-center gap-1.5">
          {lead.enabled ? <StageMenu c={c} pipelines={lead.pipelines} lostReasons={lead.lostReasons} workspaceId={workspaceId} onChanged={() => lead.onChanged([])} /> : <StageBadge pipelines={lead.pipelines} c={c} />}
          {!!c.lead?.moreCount && <span className="text-xs text-fg-subtle" title={`This contact also has ${c.lead.moreCount} older or closed ${c.lead.moreCount === 1 ? "lead" : "leads"}.`}>+{c.lead.moreCount} more</span>}
        </span>
      );
    case "value": return <ValueCell c={c} />;
    case "contact":
      return (
        <div className="flex min-w-0 items-center gap-3">
          <Avatar name={c.name} size="lg" />
          <div className="min-w-0 leading-tight">
            <Link href={`/w/${workspaceId}/contacts/${c.id}`} className="block truncate font-medium text-fg hover:text-accent-fg pointer-coarse:-my-3 pointer-coarse:py-3">{c.name}</Link>
            <p className="truncate text-sm text-fg-subtle">{c.email ?? c.phone ?? "No email or phone"}</p>
          </div>
        </div>
      );
    case "lifecycle": return <Stage name={c.lifecycleStage.name} />;
    case "owner": return c.owner ? <span className="inline-flex items-center gap-1.5"><Avatar name={c.owner.name} size="xs" /><span>{c.owner.name}</span></span> : <Empty>Unassigned</Empty>;
    case "tags": return c.tags.length ? <span className="inline-flex items-center gap-1">{c.tags.slice(0, 2).map((t) => <Badge key={t.id} shape="square" tone={t.color === "neutral" ? "neutral" : TAG_TONE[t.color]}>{t.name}</Badge>)}{c.tags.length > 2 && <span className="text-xs text-fg-subtle" title={c.tags.slice(2).map((t) => t.name).join(", ")}>+{c.tags.length - 2}</span>}</span> : <Empty>No tags</Empty>;
    // The default source is low-signal, so it recedes; any other source reads at normal strength.
    case "source": return <span className={c.source === "manual" ? "text-fg-subtle" : "text-fg"}>{sourceLabel(c.source)}</span>;
    case "lastActivity": return <time dateTime={c.lastActivityAt ?? undefined} suppressHydrationWarning className="tnum text-fg-muted">{c.lastActivityAt ? relativeTime(c.lastActivityAt, timeZone) : <Empty>No activity</Empty>}</time>;
    case "created": return <time dateTime={c.createdAt} className="tnum text-fg-muted">{formatDate(c.createdAt, timeZone)}</time>;
  }
}

function ContactCard({ c, workspaceId, timeZone, pipelines }: { c: ContactSummary; workspaceId: string; timeZone: string; pipelines: PipelineDto[] }) {
  return (
    <li className="border-b border-line last:border-b-0">
      <Link href={`/w/${workspaceId}/contacts/${c.id}`} className="flex items-start gap-3 px-4 py-3 active:bg-hover">
        <Avatar name={c.name} />
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline justify-between gap-2">
            <p className="truncate font-medium text-fg">{c.name}</p>
            <time dateTime={c.lastActivityAt ?? undefined} suppressHydrationWarning className="shrink-0 text-xs text-fg-subtle">{c.lastActivityAt ? relativeTime(c.lastActivityAt, timeZone) : ""}</time>
          </div>
          <p className="truncate text-sm text-fg-muted">{c.email ?? c.phone ?? "No email or phone"}</p>
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            <StageBadge pipelines={pipelines} c={c} />
            {c.tags.slice(0, 2).map((t) => <Badge key={t.id} shape="square" tone={TAG_TONE[t.color]}>{t.name}</Badge>)}
            {c.owner && <span className="text-xs text-fg-subtle">· {c.owner.name}</span>}
          </div>
        </div>
      </Link>
    </li>
  );
}

function ViewsMenu({ views, active, base, canManageShared, onApply, onSave, onRename, onUpdate, onDelete }: { views: SavedView[]; active: string | null; base: string | null; canManageShared: boolean; onApply: (v: SavedView) => void; onSave: () => void; onRename: (v: SavedView) => void; onUpdate: (v: SavedView) => void; onDelete: (v: SavedView) => void }) {
  const current = views.find((v) => v.id === active);
  const manage = views.find((v) => v.id === base);
  const canManage = !!manage && (manage.mine || (manage.shared && canManageShared));
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="secondary"><Bookmark />{current ? current.name : "Views"}</Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64">
        <DropdownMenuLabel>Saved views</DropdownMenuLabel>
        {views.length === 0 && <p className="px-2 py-1.5 text-sm text-fg-muted">No saved views yet. Set up filters and columns, then save them.</p>}
        {views.map((v) => (
          <DropdownMenuItem key={v.id} onSelect={() => onApply(v)} aria-current={v.id === active ? "true" : undefined}>
            <span className="min-w-0 flex-1 truncate">{v.name}</span>
            {v.shared && <span className="text-xs text-fg-subtle">Shared</span>}
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={onSave}><Plus aria-hidden />Save current view…</DropdownMenuItem>
        {canManage && manage && (
          <>
            <DropdownMenuItem onSelect={() => onUpdate(manage)}><RefreshCw aria-hidden />Update “{manage.name}” with current filters</DropdownMenuItem>
            <DropdownMenuItem onSelect={() => onRename(manage)}><Pencil aria-hidden />Rename “{manage.name}”…</DropdownMenuItem>
            <DropdownMenuItem danger onSelect={() => onDelete(manage)}><Trash2 aria-hidden />Delete “{manage.name}”</DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function ColumnsDialog({ open, onOpenChange, columns, onChange }: { open: boolean; onOpenChange: (o: boolean) => void; columns: ContactColumn[]; onChange: (c: ContactColumn[]) => void }) {
  const hidden = CONTACT_COLUMNS.filter((c) => !columns.includes(c));
  const [note, setNote] = React.useState("");
  const list = React.useRef<HTMLUListElement>(null);
  const refocus = React.useRef<string | null>(null);
  // Re-rendering moves or removes the button that had focus; put it back on the same row so keyboard users keep their place.
  React.useLayoutEffect(() => {
    const key = refocus.current;
    if (!key) return;
    refocus.current = null;
    const [col, act] = key.split(":") as [string, string];
    const pick = (a: string) => list.current?.querySelector<HTMLButtonElement>(`[data-col="${col}"][data-act="${a}"]:not(:disabled)`);
    (pick(act) ?? pick(act === "up" ? "down" : "up"))?.focus();
  });
  const apply = (next: ContactColumn[], focus: string, text: string) => { refocus.current = focus; setNote(text); onChange(next); };
  const move = (i: number, d: -1 | 1) => {
    const next = [...columns];
    const j = i + d;
    if (j < 0 || j >= next.length) return;
    [next[i], next[j]] = [next[j]!, next[i]!];
    apply(next, `${columns[i]}:${d < 0 ? "up" : "down"}`, `${COLUMN_LABEL[columns[i]!]}, position ${j + 1} of ${next.length}`);
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title="Columns" description="Choose and order columns. Remembered on this device.">
        <p role="status" className="sr-only">{note}</p>
        <ul ref={list} className="flex flex-col gap-1">
          {columns.map((c, i) => (
            <li key={c} className="flex items-center gap-2 rounded-control px-1 py-0.5">
              <span className="flex-1 text-base text-fg">{COLUMN_LABEL[c]}</span>
              <Button variant="ghost" icon size="sm" data-col={c} data-act="up" aria-label={`Move ${COLUMN_LABEL[c]} up`} disabled={i === 0} onClick={() => move(i, -1)}><ArrowUp /></Button>
              <Button variant="ghost" icon size="sm" data-col={c} data-act="down" aria-label={`Move ${COLUMN_LABEL[c]} down`} disabled={i === columns.length - 1} onClick={() => move(i, 1)}><ArrowDown /></Button>
              {c === "contact" ? <span className="w-20 text-right text-xs text-fg-subtle">Always shown</span> : <Button variant="secondary" size="sm" className="w-20" data-col={c} data-act="hide" onClick={() => apply(columns.filter((x) => x !== c), `${c}:show`, `${COLUMN_LABEL[c]} hidden`)}>Hide</Button>}
            </li>
          ))}
          {hidden.map((c) => (
            <li key={c} className="flex items-center gap-2 rounded-control px-1 py-0.5">
              <span className="flex-1 text-base text-fg-muted">{COLUMN_LABEL[c]}</span>
              <Button variant="secondary" size="sm" className="w-20" data-col={c} data-act="show" onClick={() => apply([...columns, c], `${c}:hide`, `${COLUMN_LABEL[c]} shown`)}>Show</Button>
            </li>
          ))}
        </ul>
        <div className="mt-4 flex justify-between">
          <Button variant="ghost" onClick={() => { setNote("Columns reset to default"); onChange(DEFAULT_COLUMNS); }}>Reset to default</Button>
          <DialogClose asChild><Button variant="primary">Done</Button></DialogClose>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function SaveViewDialog({ open, onOpenChange, canShare, onSave }: { open: boolean; onOpenChange: (o: boolean) => void; canShare: boolean; onSave: (name: string, shared: boolean) => Promise<string | null> }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title="Save view" description="Saves the current filters, sort order and columns.">
        <SaveViewForm canShare={canShare} onSave={onSave} onDone={() => onOpenChange(false)} />
      </DialogContent>
    </Dialog>
  );
}

function SaveViewForm({ canShare, onSave, onDone }: { canShare: boolean; onSave: (name: string, shared: boolean) => Promise<string | null>; onDone: () => void }) {
  const [name, setName] = React.useState("");
  const [shared, setShared] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  return (
    <form noValidate onSubmit={async (e) => { e.preventDefault(); if (!name.trim()) return setError("Give the view a name."); setBusy(true); const err = await onSave(name.trim(), shared); setBusy(false); if (err) setError(err); else onDone(); }} className="flex flex-col gap-3">
      {error && <Alert tone="error">{error}</Alert>}
      <Field label="View name" error={null}>{(p) => <Input {...p} value={name} onChange={(e) => setName(e.target.value)} maxLength={60} autoFocus placeholder="For example, My qualified leads" />}</Field>
      {canShare && <Checkbox label="Share with everyone in this workspace" checked={shared} onChange={(e) => setShared(e.target.checked)} />}
      <DialogActions className="mt-2">
        <DialogClose asChild><Button variant="ghost">Cancel</Button></DialogClose>
        <Button type="submit" variant="primary" loading={busy}>Save view</Button>
      </DialogActions>
    </form>
  );
}

function ViewNameDialog({ open, onOpenChange, view, onSave }: { open: boolean; onOpenChange: (o: boolean) => void; view: SavedView | null; onSave: (name: string) => Promise<string | null> }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title="Rename view" description="Only the name changes. Filters and columns stay as saved.">
        {view && <RenameViewForm key={view.id + view.name} view={view} onSave={onSave} onDone={() => onOpenChange(false)} />}
      </DialogContent>
    </Dialog>
  );
}

function RenameViewForm({ view, onSave, onDone }: { view: SavedView; onSave: (name: string) => Promise<string | null>; onDone: () => void }) {
  const [name, setName] = React.useState(view.name);
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  return (
    <form noValidate onSubmit={async (e) => { e.preventDefault(); if (!name.trim()) return setError("Give the view a name."); setBusy(true); const err = await onSave(name.trim()); setBusy(false); if (err) setError(err); else onDone(); }} className="flex flex-col gap-3">
      {error && <Alert tone="error">{error}</Alert>}
      <Field label="View name" error={null}>{(p) => <Input {...p} value={name} onChange={(e) => setName(e.target.value)} maxLength={60} autoFocus />}</Field>
      <DialogActions className="mt-2">
        <DialogClose asChild><Button variant="ghost">Cancel</Button></DialogClose>
        <Button type="submit" variant="primary" loading={busy}>Rename</Button>
      </DialogActions>
    </form>
  );
}

function DeleteViewDialog({ view, onClose, onConfirm }: { view: SavedView | null; onClose: () => void; onConfirm: (v: SavedView) => Promise<string | null> }) {
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  return (
    <Dialog open={!!view} onOpenChange={(o) => { if (!o) { setError(null); onClose(); } }}>
      <DialogContent title={view ? `Delete “${view.name}”?` : "Delete view"} description={view?.shared ? "This view is shared. It will be removed for everyone in the workspace." : "The saved filters and columns are removed. Contacts are not affected."}>
        {error && <Alert tone="error" className="mb-3">{error}</Alert>}
        <DialogActions>
          <DialogClose asChild><Button variant="ghost">Cancel</Button></DialogClose>
          <Button variant="danger" loading={busy} onClick={async () => { if (!view) return; setBusy(true); const err = await onConfirm(view); setBusy(false); if (err) setError(err); else onClose(); }}>Delete view</Button>
        </DialogActions>
      </DialogContent>
    </Dialog>
  );
}
