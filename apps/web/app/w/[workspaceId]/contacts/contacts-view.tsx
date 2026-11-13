"use client";
import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowDown, ArrowUp, ArrowUpDown, Bookmark, Columns3, Download, FilterX, Plus, Search, SlidersHorizontal, Trash2, Upload, Users } from "lucide-react";
import { CONTACT_COLUMNS, endpoints, type ContactColumn, type ContactListQuery, type ContactPage, type ContactSummary, type CustomField, type LifecycleStage, type Member, type SavedView, type Tag, type ViewConfig } from "@crm/contracts";
import { Avatar } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Checkbox } from "@/components/ui/form-controls";
import { Input, Select } from "@/components/ui/input";
import { Dialog, DialogClose, DialogContent, DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/overlays";
import { PageHeader, Panel } from "@/components/ui/panel";
import { Alert, EmptyState, ErrorState } from "@/components/ui/states";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { NewContactDialog } from "@/components/contacts/new-contact-dialog";
import { browserApi, errorMessage } from "@/lib/client-api";
import { COLUMN_LABEL, DEFAULT_COLUMNS, relativeTime, SORT_FOR_COLUMN, sourceLabel, TAG_TONE } from "@/lib/contacts";
import { formatDate } from "@/lib/format";

type Q = Pick<ContactListQuery, "search" | "lifecycleStageId" | "ownerId" | "tagIds" | "source" | "sort" | "dir">;
type Perms = { edit: boolean; import: boolean; export: boolean; shareViews: boolean; schema: boolean };
type Props = { workspaceId: string; timeZone: string; myUserId: string; initial: ContactPage | null; initialQuery: ContactListQuery; stages: LifecycleStage[]; tags: Tag[]; members: Member[]; views: SavedView[]; fields: CustomField[]; perms: Perms };

const FILTERS: (keyof Q)[] = ["search", "lifecycleStageId", "ownerId", "tagIds", "source"];
const hasFilters = (q: Q) => FILTERS.some((k) => !!q[k]);

export function ContactsView({ workspaceId, timeZone, myUserId, initial, initialQuery, stages, tags, members, views: initialViews, fields, perms }: Props) {
  const [query, setQuery] = React.useState<Q>({ search: initialQuery.search, lifecycleStageId: initialQuery.lifecycleStageId, ownerId: initialQuery.ownerId, tagIds: initialQuery.tagIds, source: initialQuery.source, sort: initialQuery.sort ?? "lastActivity", dir: initialQuery.dir ?? "desc" });
  const [page, setPage] = React.useState<ContactPage>(initial ?? { items: [], nextCursor: null, total: 0 });
  const [status, setStatus] = React.useState<"idle" | "loading" | "error">(initial ? "idle" : "error");
  const [errorText, setErrorText] = React.useState<string | null>(null);
  const [moreBusy, setMoreBusy] = React.useState(false);
  const [viewColumns, setViewColumns] = React.useState<ContactColumn[] | null>(null);
  const [views, setViews] = React.useState(initialViews);
  const [activeView, setActiveView] = React.useState<string | null>(null);
  const [newOpen, setNewOpen] = React.useState(false);
  const [colsOpen, setColsOpen] = React.useState(false);
  const [saveOpen, setSaveOpen] = React.useState(false);
  const [showFilters, setShowFilters] = React.useState(false);
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
  const saveColumns = (c: ContactColumn[]) => {
    setViewColumns(c);
    try { localStorage.setItem(storeKey, JSON.stringify(c)); window.dispatchEvent(new Event("crm-columns")); } catch { /* the layout just won't be remembered */ }
  };

  const toParams = (q: Q) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(q)) if (v && !(k === "sort" && v === "lastActivity") && !(k === "dir" && v === "desc")) p.set(k, String(v));
    return p;
  };

  const load = React.useCallback(async (q: Q) => {
    const mine = ++seq.current;
    setStatus("loading");
    const res = await browserApi.call(endpoints.listContacts, { params: { workspaceId }, query: { ...q, limit: 25 } });
    if (mine !== seq.current) return; // a newer request superseded this one
    if (!res.ok) { setErrorText(errorMessage(res.error)); setStatus("error"); return; }
    setPage(res.data);
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
    const res = await browserApi.call(endpoints.listContacts, { params: { workspaceId }, query: { ...query, limit: 25, cursor: page.nextCursor } });
    setMoreBusy(false);
    if (!res.ok) return setErrorText(errorMessage(res.error));
    setErrorText(null);
    setPage((p) => ({ ...res.data, items: [...p.items, ...res.data.items] }));
  }

  const set = (patch: Partial<Q>) => { setActiveView(null); setQuery((q) => ({ ...q, ...patch })); };
  const clearFilters = () => set({ search: undefined, lifecycleStageId: undefined, ownerId: undefined, tagIds: undefined, source: undefined });
  const toggleSort = (col: ContactColumn) => {
    const s = SORT_FOR_COLUMN[col];
    if (!s) return;
    set({ sort: s, dir: query.sort === s && query.dir === "asc" ? "desc" : query.sort === s ? "asc" : s === "name" ? "asc" : "desc" });
  };

  const applyView = (v: SavedView) => {
    setActiveView(v.id);
    saveColumns(v.config.columns);
    setQuery({ ...(v.config.filters as Q), sort: v.config.sort, dir: v.config.dir });
  };
  const currentConfig = (): ViewConfig => ({ columns, filters: Object.fromEntries(FILTERS.filter((k) => query[k]).map((k) => [k, query[k]])) as ViewConfig["filters"], sort: query.sort ?? "lastActivity", dir: query.dir ?? "desc" });

  const filtered = hasFilters(query);
  const exportHref = `/v1/workspaces/${workspaceId}/contacts/export?${(() => { const p = toParams(query); p.delete("sort"); p.delete("dir"); return p; })()}`;

  return (
    <>
      <PageHeader
        title="Contacts"
        description={status === "error" && !page.items.length ? undefined : `${page.total.toLocaleString("en-US")} ${page.total === 1 ? "contact" : "contacts"}${filtered ? " match your filters" : ""}`}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            {perms.import && <Button asChild variant="secondary"><Link href={`/w/${workspaceId}/contacts/import`}><Upload />Import</Link></Button>}
            {perms.export && <Button asChild variant="secondary"><a href={exportHref} download><Download />Export</a></Button>}
            {perms.edit && <Button variant="primary" onClick={() => setNewOpen(true)}><Plus />Add contact</Button>}
          </div>
        }
      />

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="relative min-w-0 flex-1 basis-56 sm:max-w-sm">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-fg-subtle" aria-hidden />
          <Input aria-label="Search contacts" type="search" placeholder="Search name, email or phone" className="pl-8" value={query.search ?? ""} onChange={(e) => set({ search: e.target.value || undefined })} />
        </div>
        <Button variant="secondary" className="md:hidden" aria-expanded={showFilters} onClick={() => setShowFilters((s) => !s)}><SlidersHorizontal />Filters{filtered ? " (on)" : ""}</Button>
        <div className={`${showFilters ? "flex" : "hidden"} w-full flex-wrap items-center gap-2 md:flex md:w-auto`}>
          <Select aria-label="Lifecycle stage" className="w-auto min-w-36" value={query.lifecycleStageId ?? ""} onChange={(e) => set({ lifecycleStageId: e.target.value || undefined })}>
            <option value="">All stages</option>
            {stages.filter((s) => !s.archived).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </Select>
          <Select aria-label="Owner" className="w-auto min-w-32" value={query.ownerId ?? ""} onChange={(e) => set({ ownerId: e.target.value || undefined })}>
            <option value="">All owners</option>
            <option value="me">Me</option>
            <option value="unassigned">Unassigned</option>
            {members.filter((m) => m.userId !== myUserId).map((m) => <option key={m.userId} value={m.userId}>{m.name}</option>)}
          </Select>
          <Select aria-label="Tag" className="w-auto min-w-28" value={query.tagIds ?? ""} onChange={(e) => set({ tagIds: e.target.value || undefined })}>
            <option value="">Any tag</option>
            {tags.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </Select>
          <Select aria-label="Source" className="w-auto min-w-32" value={query.source ?? ""} onChange={(e) => set({ source: (e.target.value || undefined) as Q["source"] })}>
            <option value="">All sources</option>
            {["manual", "import", "messenger", "instagram", "facebook_lead_ad", "web_form", "referral", "other"].map((s) => <option key={s} value={s}>{sourceLabel(s)}</option>)}
          </Select>
          {filtered && <Button variant="ghost" onClick={clearFilters}><FilterX />Clear</Button>}
        </div>
        <div className="ml-auto flex items-center gap-2">
          <Select aria-label="Sort by" className="w-auto md:hidden" value={`${query.sort}:${query.dir}`} onChange={(e) => { const [s, d] = e.target.value.split(":"); set({ sort: s as Q["sort"], dir: d as Q["dir"] }); }}>
            <option value="lastActivity:desc">Latest activity</option>
            <option value="created:desc">Newest</option>
            <option value="name:asc">Name A to Z</option>
          </Select>
          <ViewsMenu views={views} active={activeView} canManageShared={perms.shareViews} onApply={applyView} onSave={() => setSaveOpen(true)} onDelete={async (v) => { const r = await browserApi.call(endpoints.deleteView, { params: { workspaceId, viewId: v.id } }); if (r.ok) { setViews((x) => x.filter((y) => y.id !== v.id)); if (activeView === v.id) setActiveView(null); } }} />
          <Button variant="secondary" className="hidden md:inline-flex" onClick={() => setColsOpen(true)}><Columns3 />Columns</Button>
        </div>
      </div>

      {errorText && page.items.length > 0 && <Alert tone="error" className="mb-3">{errorText}</Alert>}

      <Panel className={status === "loading" ? "opacity-70 transition-opacity" : ""} aria-busy={status === "loading"}>
        {status === "error" && page.items.length === 0 ? (
          <ErrorState title="Contacts could not be loaded" description={errorText ?? "Check your connection and try again."} onRetry={() => void load(query)} />
        ) : page.items.length === 0 && status !== "loading" ? (
          filtered ? (
            <EmptyState icon={FilterX} title="No contacts match these filters" description="Try a different search or clear the filters." action={<Button onClick={clearFilters}>Clear filters</Button>} />
          ) : (
            <EmptyState
              icon={Users}
              title="No contacts yet"
              description="Add the people you talk to, or bring them in from a spreadsheet. Conversations and leads will attach to these records."
              action={<div className="flex flex-wrap justify-center gap-2">{perms.edit && <Button variant="primary" onClick={() => setNewOpen(true)}><Plus />Add contact</Button>}{perms.import && <Button asChild variant="secondary"><Link href={`/w/${workspaceId}/contacts/import`}><Upload />Import a CSV</Link></Button>}</div>}
            />
          )
        ) : (
          <>
            <div className="hidden md:block">
              <ContactsTable items={page.items} columns={columns} query={query} onSort={toggleSort} workspaceId={workspaceId} timeZone={timeZone} />
            </div>
            <ul className="md:hidden">
              {page.items.map((c) => <ContactCard key={c.id} c={c} workspaceId={workspaceId} timeZone={timeZone} />)}
            </ul>
            <div className="flex items-center justify-between gap-3 border-t border-line px-4 py-3 text-sm text-fg-muted">
              <span role="status">{status === "loading" ? "Updating…" : `Showing ${page.items.length.toLocaleString("en-US")} of ${page.total.toLocaleString("en-US")}`}</span>
              {page.nextCursor && <Button onClick={loadMore} loading={moreBusy}>Load more</Button>}
            </div>
          </>
        )}
      </Panel>

      <NewContactDialog open={newOpen} onOpenChange={setNewOpen} workspaceId={workspaceId} stages={stages} members={members} fields={fields} myUserId={myUserId} />
      <ColumnsDialog open={colsOpen} onOpenChange={setColsOpen} columns={columns} onChange={(c) => { setActiveView(null); saveColumns(c); }} />
      <SaveViewDialog open={saveOpen} onOpenChange={setSaveOpen} canShare={perms.shareViews} onSave={async (name, shared) => { const r = await browserApi.call(endpoints.createView, { params: { workspaceId }, body: { name, shared, config: currentConfig() } }); if (!r.ok) return errorMessage(r.error); setViews((v) => [...v, r.data].sort((a, b) => a.name.localeCompare(b.name))); setActiveView(r.data.id); return null; }} />
    </>
  );
}

function ContactsTable({ items, columns, query, onSort, workspaceId, timeZone }: { items: ContactSummary[]; columns: ContactColumn[]; query: Q; onSort: (c: ContactColumn) => void; workspaceId: string; timeZone: string }) {
  const router = useRouter();
  const sortKey = (c: ContactColumn) => SORT_FOR_COLUMN[c];
  return (
    <Table scrollLabel="Contacts table, scrolls sideways when columns do not fit">
      <THead>
        <tr>
          {columns.map((col) => {
            const s = sortKey(col);
            const active = s && query.sort === s;
            return (
              <TH key={col} className={col === "contact" ? "sticky left-0 z-10" : undefined} aria-sort={active ? (query.dir === "asc" ? "ascending" : "descending") : s ? "none" : undefined}>
                {s ? (
                  <button type="button" onClick={() => onSort(col)} className="inline-flex items-center gap-1 rounded text-xs font-medium text-fg-muted hover:text-fg">
                    {COLUMN_LABEL[col]}
                    {active ? (query.dir === "asc" ? <ArrowUp className="size-3" aria-hidden /> : <ArrowDown className="size-3" aria-hidden />) : <ArrowUpDown className="size-3 text-fg-disabled" aria-hidden />}
                  </button>
                ) : COLUMN_LABEL[col]}
              </TH>
            );
          })}
        </tr>
      </THead>
      <TBody>
        {items.map((c) => (
          <TR key={c.id} className="group cursor-pointer" onClick={(e) => { if (!(e.target as HTMLElement).closest("a,button")) router.push(`/w/${workspaceId}/contacts/${c.id}`); }}>
            {columns.map((col) => <TD key={col} className={col === "contact" ? "sticky left-0 z-10 w-72 min-w-56 max-w-72 bg-surface group-hover:bg-canvas" : "whitespace-nowrap"}>{cell(col, c, workspaceId, timeZone)}</TD>)}
          </TR>
        ))}
      </TBody>
    </Table>
  );
}

function cell(col: ContactColumn, c: ContactSummary, workspaceId: string, timeZone: string): React.ReactNode {
  switch (col) {
    case "contact":
      return (
        <div className="flex min-w-0 items-center gap-3">
          <Avatar name={c.name} />
          <div className="min-w-0">
            <Link href={`/w/${workspaceId}/contacts/${c.id}`} className="block truncate font-medium text-fg hover:underline">{c.name}</Link>
            <p className="truncate text-sm text-fg-muted">{c.email ?? c.phone ?? "No email or phone"}</p>
          </div>
        </div>
      );
    case "lifecycle": return <Badge>{c.lifecycleStage.name}</Badge>;
    case "owner": return c.owner ? <span className="inline-flex items-center gap-2"><Avatar name={c.owner.name} size="xs" /><span>{c.owner.name}</span></span> : <span className="text-fg-subtle">Unassigned</span>;
    case "tags": return c.tags.length ? <span className="inline-flex items-center gap-1">{c.tags.slice(0, 2).map((t) => <Badge key={t.id} tone={TAG_TONE[t.color]}>{t.name}</Badge>)}{c.tags.length > 2 && <span className="text-xs text-fg-subtle" title={c.tags.slice(2).map((t) => t.name).join(", ")}>+{c.tags.length - 2}</span>}</span> : <span className="text-fg-subtle">None</span>;
    case "source": return <span className="text-fg-muted">{sourceLabel(c.source)}</span>;
    case "lastActivity": return <time dateTime={c.lastActivityAt ?? undefined} suppressHydrationWarning className="tnum text-fg-muted">{c.lastActivityAt ? relativeTime(c.lastActivityAt, timeZone) : "None"}</time>;
    case "created": return <time dateTime={c.createdAt} className="tnum text-fg-muted">{formatDate(c.createdAt, timeZone)}</time>;
  }
}

function ContactCard({ c, workspaceId, timeZone }: { c: ContactSummary; workspaceId: string; timeZone: string }) {
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
            <Badge>{c.lifecycleStage.name}</Badge>
            {c.tags.slice(0, 2).map((t) => <Badge key={t.id} tone={TAG_TONE[t.color]}>{t.name}</Badge>)}
            {c.owner && <span className="text-xs text-fg-subtle">· {c.owner.name}</span>}
          </div>
        </div>
      </Link>
    </li>
  );
}

function ViewsMenu({ views, active, canManageShared, onApply, onSave, onDelete }: { views: SavedView[]; active: string | null; canManageShared: boolean; onApply: (v: SavedView) => void; onSave: () => void; onDelete: (v: SavedView) => void }) {
  const current = views.find((v) => v.id === active);
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
        {current && (current.mine || (current.shared && canManageShared)) && <DropdownMenuItem danger onSelect={() => onDelete(current)}><Trash2 aria-hidden />Delete “{current.name}”</DropdownMenuItem>}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function ColumnsDialog({ open, onOpenChange, columns, onChange }: { open: boolean; onOpenChange: (o: boolean) => void; columns: ContactColumn[]; onChange: (c: ContactColumn[]) => void }) {
  const hidden = CONTACT_COLUMNS.filter((c) => !columns.includes(c));
  const move = (i: number, d: -1 | 1) => { const next = [...columns]; const j = i + d; if (j < 0 || j >= next.length) return; [next[i], next[j]] = [next[j]!, next[i]!]; onChange(next); };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title="Columns" description="Choose which columns to show and in what order. Your layout is remembered on this device; save a view to share it.">
        <ul className="flex flex-col gap-1">
          {columns.map((c, i) => (
            <li key={c} className="flex items-center gap-2 rounded-md px-1 py-0.5">
              <span className="flex-1 text-base text-fg">{COLUMN_LABEL[c]}</span>
              <Button variant="ghost" icon size="sm" aria-label={`Move ${COLUMN_LABEL[c]} up`} disabled={i === 0} onClick={() => move(i, -1)}><ArrowUp /></Button>
              <Button variant="ghost" icon size="sm" aria-label={`Move ${COLUMN_LABEL[c]} down`} disabled={i === columns.length - 1} onClick={() => move(i, 1)}><ArrowDown /></Button>
              {c === "contact" ? <span className="w-20 text-right text-xs text-fg-subtle">Always shown</span> : <Button variant="secondary" size="sm" className="w-20" onClick={() => onChange(columns.filter((x) => x !== c))}>Hide</Button>}
            </li>
          ))}
          {hidden.map((c) => (
            <li key={c} className="flex items-center gap-2 rounded-md px-1 py-0.5">
              <span className="flex-1 text-base text-fg-muted">{COLUMN_LABEL[c]}</span>
              <Button variant="secondary" size="sm" className="w-20" onClick={() => onChange([...columns, c])}>Show</Button>
            </li>
          ))}
        </ul>
        <div className="mt-4 flex justify-between">
          <Button variant="ghost" onClick={() => onChange(DEFAULT_COLUMNS)}>Reset to default</Button>
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
      <div className="mt-2 flex justify-end gap-2">
        <DialogClose asChild><Button variant="ghost">Cancel</Button></DialogClose>
        <Button type="submit" variant="primary" loading={busy}>Save view</Button>
      </div>
    </form>
  );
}
