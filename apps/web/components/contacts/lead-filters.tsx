"use client";
import * as React from "react";
import { ChevronDown, SlidersHorizontal, Users } from "lucide-react";
import type { ContactListQuery, ContactOwnerCounts, Member, Tag } from "@crm/contracts";
import { Avatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/overlays";
import { Sheet } from "@/components/ui/sheet";
import { SOURCE_LABEL, sourceLabel } from "@/lib/contacts";

/** The filters the API supports besides search and stage: owner (several), tags (any of), source, created since. */
export type LeadFilterValues = { ownerId?: string; tagIds?: string; source?: ContactListQuery["source"]; createdFrom?: string };
type Props = { members: Member[]; myUserId: string; ownerCounts: ContactOwnerCounts | null; tags: Tag[]; value: LeadFilterValues };

const split = (v?: string) => (v ? v.split(",").filter(Boolean) : []);
const join = (a: string[]) => (a.length ? a.join(",") : undefined);
const toggleIn = (v: string | undefined, id: string) => { const a = split(v); return join(a.includes(id) ? a.filter((x) => x !== id) : [...a, id]); };
/** "me" is the URL token for the current user (old links keep working). */
const tokenOf = (m: Member, me: string) => (m.userId === me ? "me" : m.userId);
const dayIso = (daysAgo: number) => new Date(Date.now() - daysAgo * 86_400_000).toISOString().slice(0, 10);
const PRESETS = [{ id: "any", label: "Any time", days: 0 }, { id: "7", label: "Last 7 days", days: 7 }, { id: "30", label: "Last 30 days", days: 30 }] as const;
const presetOf = (from?: string) => (!from ? "any" : from === dayIso(7) ? "7" : from === dayIso(30) ? "30" : "custom");

/** How many filters (beyond search and stage) are on; shown on the trigger buttons. */
export const filterCount = (v: LeadFilterValues) => split(v.ownerId).length + split(v.tagIds).length + (v.source ? 1 : 0) + (v.createdFrom ? 1 : 0);

const Badge = ({ n }: { n: number }) => n > 0 ? <span className="inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-accent px-1 text-[11px] font-semibold leading-none text-on-accent" aria-hidden>{n}</span> : null;
const Count = ({ n }: { n: number | undefined }) => n === undefined ? null : <span className="tnum ml-auto pl-3 text-xs text-fg-subtle">{n.toLocaleString("en")}</span>;

function useOwnerRows({ members, myUserId, ownerCounts }: Props) {
  const countOf = (id: string | null) => ownerCounts ? ownerCounts.items.find((x) => x.ownerId === id)?.count ?? 0 : undefined;
  const active = members.filter((m) => m.status === "active").sort((a, b) => (a.userId === myUserId ? -1 : b.userId === myUserId ? 1 : a.name.localeCompare(b.name)));
  return { rows: active.map((m) => ({ token: tokenOf(m, myUserId), name: m.userId === myUserId ? `${m.name} (you)` : m.name, plain: m.name, count: countOf(m.userId) })), unassigned: countOf(null) };
}

/** Desktop: the Agent filter, a multi-select menu with each member's lead count, Unassigned, and a Me shortcut. */
export function AgentMenu(props: Props & { onChange: (ownerId: string | undefined) => void }) {
  const { value, onChange } = props;
  const sel = split(value.ownerId);
  const { rows, unassigned } = useOwnerRows(props);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="secondary" aria-label={sel.length ? `Agent, ${sel.length} selected` : "Agent"}><Users aria-hidden />Agent<Badge n={sel.length} /><ChevronDown className="text-fg-subtle" aria-hidden /></Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-h-[min(24rem,var(--radix-dropdown-menu-content-available-height))] w-64 overflow-y-auto">
        <DropdownMenuLabel>Agent</DropdownMenuLabel>
        <DropdownMenuItem onSelect={() => onChange("me")}>Me</DropdownMenuItem>
        <DropdownMenuSeparator />
        {rows.map((r) => <DropdownMenuCheckboxItem key={r.token} checked={sel.includes(r.token)} onCheckedChange={() => onChange(toggleIn(value.ownerId, r.token))}><Avatar name={r.plain} size="xs" /><span className="min-w-0 flex-1 truncate">{r.name}</span><Count n={r.count} /></DropdownMenuCheckboxItem>)}
        <DropdownMenuCheckboxItem checked={sel.includes("unassigned")} onCheckedChange={() => onChange(toggleIn(value.ownerId, "unassigned"))}><span className="min-w-0 flex-1">Unassigned</span><Count n={unassigned} /></DropdownMenuCheckboxItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem disabled={sel.length === 0} onSelect={() => onChange(undefined)}>Clear</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Desktop: Filters menu with only what the API filters on today (source, tags, created). */
export function FiltersMenu({ tags, value, onChange }: Pick<Props, "tags" | "value"> & { onChange: (patch: LeadFilterValues) => void }) {
  const n = (value.source ? 1 : 0) + split(value.tagIds).length + (value.createdFrom ? 1 : 0);
  const p = presetOf(value.createdFrom);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="secondary" aria-label={n ? `Filters, ${n} on` : "Filters"}><SlidersHorizontal aria-hidden />Filters<Badge n={n} /><ChevronDown className="text-fg-subtle" aria-hidden /></Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-h-[min(28rem,var(--radix-dropdown-menu-content-available-height))] w-64 overflow-y-auto">
        <DropdownMenuLabel>Source</DropdownMenuLabel>
        <DropdownMenuRadioGroup value={value.source ?? ""} onValueChange={(v) => onChange({ source: (v || undefined) as LeadFilterValues["source"] })}>
          <DropdownMenuRadioItem value="">Any source</DropdownMenuRadioItem>
          {Object.keys(SOURCE_LABEL).map((s) => <DropdownMenuRadioItem key={s} value={s}>{sourceLabel(s)}</DropdownMenuRadioItem>)}
        </DropdownMenuRadioGroup>
        {tags.length > 0 && <><DropdownMenuSeparator /><DropdownMenuLabel>Tags (any of)</DropdownMenuLabel>{tags.map((t) => <DropdownMenuCheckboxItem key={t.id} checked={split(value.tagIds).includes(t.id)} onCheckedChange={() => onChange({ tagIds: toggleIn(value.tagIds, t.id) })}>{t.name}</DropdownMenuCheckboxItem>)}</>}
        <DropdownMenuSeparator />
        <DropdownMenuLabel>Added</DropdownMenuLabel>
        <DropdownMenuRadioGroup value={p} onValueChange={(v) => onChange({ createdFrom: v === "custom" ? value.createdFrom : PRESETS.find((x) => x.id === v)!.days ? dayIso(PRESETS.find((x) => x.id === v)!.days) : undefined })}>
          {PRESETS.map((x) => <DropdownMenuRadioItem key={x.id} value={x.id}>{x.label}</DropdownMenuRadioItem>)}
          {p === "custom" && <DropdownMenuRadioItem value="custom">Since {value.createdFrom}</DropdownMenuRadioItem>}
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem disabled={n === 0} onSelect={() => onChange({ source: undefined, tagIds: undefined, createdFrom: undefined })}>Clear</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Phone: Agent and Filters are one bottom sheet. Edits stay in a draft until Apply, so the list does not jump under the sheet. */
export function FilterSheetButton(props: Props & { onApply: (v: LeadFilterValues) => void }) {
  const [open, setOpen] = React.useState(false);
  const n = filterCount(props.value);
  return (
    <>
      <Button variant="secondary" className="shrink-0" aria-haspopup="dialog" aria-label={n ? `Filters, ${n} on` : "Filters"} onClick={() => setOpen(true)}><SlidersHorizontal aria-hidden />Filters<Badge n={n} /></Button>
      <Sheet open={open} onOpenChange={setOpen} title="Filters" description="Agent, source, tags and when the lead was added.">
        {open && <SheetBody {...props} onDone={(v) => { setOpen(false); if (v) props.onApply(v); }} />}
      </Sheet>
    </>
  );
}

const rowCls = "flex min-h-11 cursor-pointer items-center gap-3 rounded-control px-1 text-md text-fg";
const boxCls = "size-5 shrink-0 accent-[var(--accent)]";

function SheetBody({ value, onDone, tags, ...rest }: Props & { onDone: (v: LeadFilterValues | null) => void }) {
  const [d, setD] = React.useState<LeadFilterValues>(value);
  const { rows, unassigned } = useOwnerRows({ ...rest, tags, value });
  const sel = split(d.ownerId);
  const p = presetOf(d.createdFrom);
  const live = filterCount(d);
  return (
    <div>
      <p role="status" className="sr-only">{live} {live === 1 ? "filter" : "filters"} selected</p>
      <fieldset className="mb-3">
        <legend className="mb-1 text-sm font-semibold text-fg-muted">Agent</legend>
        <button type="button" className="flex min-h-11 items-center rounded-control px-1 text-md font-medium text-accent-fg" onClick={() => setD({ ...d, ownerId: "me" })}>Only me</button>
        {rows.map((r) => <label key={r.token} className={rowCls}><input type="checkbox" className={boxCls} checked={sel.includes(r.token)} onChange={() => setD({ ...d, ownerId: toggleIn(d.ownerId, r.token) })} /><Avatar name={r.plain} size="sm" /><span className="min-w-0 flex-1 truncate">{r.name}</span><Count n={r.count} /></label>)}
        <label className={rowCls}><input type="checkbox" className={boxCls} checked={sel.includes("unassigned")} onChange={() => setD({ ...d, ownerId: toggleIn(d.ownerId, "unassigned") })} /><span className="flex-1">Unassigned</span><Count n={unassigned} /></label>
      </fieldset>
      <fieldset className="mb-3 border-t border-line pt-2">
        <legend className="mb-1 text-sm font-semibold text-fg-muted">Source</legend>
        {[["", "Any source"] as const, ...Object.keys(SOURCE_LABEL).map((s) => [s, sourceLabel(s)] as const)].map(([v, l]) => <label key={v} className={rowCls}><input type="radio" name="lead-source" className={boxCls} checked={(d.source ?? "") === v} onChange={() => setD({ ...d, source: (v || undefined) as LeadFilterValues["source"] })} />{l}</label>)}
      </fieldset>
      {tags.length > 0 && (
        <fieldset className="mb-3 border-t border-line pt-2">
          <legend className="mb-1 text-sm font-semibold text-fg-muted">Tags (any of)</legend>
          {tags.map((t) => <label key={t.id} className={rowCls}><input type="checkbox" className={boxCls} checked={split(d.tagIds).includes(t.id)} onChange={() => setD({ ...d, tagIds: toggleIn(d.tagIds, t.id) })} />{t.name}</label>)}
        </fieldset>
      )}
      <fieldset className="border-t border-line pt-2">
        <legend className="mb-1 text-sm font-semibold text-fg-muted">Added</legend>
        {PRESETS.map((x) => <label key={x.id} className={rowCls}><input type="radio" name="lead-added" className={boxCls} checked={p === x.id} onChange={() => setD({ ...d, createdFrom: x.days ? dayIso(x.days) : undefined })} />{x.label}</label>)}
        {p === "custom" && <label className={rowCls}><input type="radio" name="lead-added" className={boxCls} checked readOnly />Since {d.createdFrom}</label>}
      </fieldset>
      <div className="sticky bottom-0 -mx-4 mt-3 flex gap-2 border-t border-line bg-surface px-4 py-3">
        <Button className="flex-1" onClick={() => onDone({})} disabled={live === 0}>Clear</Button>
        <Button variant="primary" className="flex-1" onClick={() => onDone(d)}>Apply</Button>
      </div>
    </div>
  );
}
