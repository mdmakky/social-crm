"use client";
import * as React from "react";
import { useRouter } from "next/navigation";
import { Command } from "cmdk";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { LogOut, Plus, Search, User } from "lucide-react";
import type { Role } from "@crm/core/permissions";
import { endpoints, type SearchGroup } from "@crm/contracts";
import { browserApi, errorMessage } from "@/lib/client-api";
import { authClient } from "@/lib/auth-client";
import { builtNav, href } from "@/lib/nav";
import { settingsFor } from "@/components/settings/settings-nav";
import { Kbd } from "@/components/ui/kbd";
import type { ShellWorkspace } from "./types";

const itemCls = "flex cursor-default items-center gap-2 rounded-control px-2 py-2 text-base text-fg data-[selected=true]:bg-selected data-[selected=true]:ring-1 data-[selected=true]:ring-inset data-[selected=true]:ring-accent [&_svg]:size-4 [&_svg]:text-fg-subtle";
const groupCls = "[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-fg-subtle";

const MIN_CHARS = 2;
const DEBOUNCE_MS = 200;
type Remote = { key: string; status: "done" | "error"; groups: SearchGroup[]; error?: string };

/** Debounced global search. Every request gets a sequence number; only the latest may update state. */
function useGlobalSearch(workspaceId: string, q: string) {
  const [state, setState] = React.useState<Remote | null>(null);
  const seq = React.useRef(0);
  const [retry, setRetry] = React.useState(0);
  const key = `${workspaceId}|${q}|${retry}`;
  const searching = q.length >= MIN_CHARS;
  React.useEffect(() => {
    const mine = ++seq.current;
    if (!searching) return;
    const t = setTimeout(async () => {
      const res = await browserApi.call(endpoints.search, { params: { workspaceId }, query: { q } });
      if (mine !== seq.current) return;
      setState(res.ok ? { key, status: "done", groups: res.data.groups } : { key, status: "error", groups: [], error: errorMessage(res.error) });
    }, DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [workspaceId, q, searching, key]);
  // results for an older query stay visible (no flicker) but are flagged as loading until the new answer arrives
  const status = !searching ? "idle" : state?.key === key ? state.status : "loading";
  return { status, groups: searching ? state?.groups ?? [] : [], error: state?.error, retry: () => setRetry((n) => n + 1) } as const;
}

type Props = { open: boolean; onOpenChange: (o: boolean) => void; workspace: ShellWorkspace; workspaces: ShellWorkspace[]; role: Role };

export function CommandMenu(props: Props) {
  const opener = React.useRef<HTMLElement | null>(null);
  // The exit animation keeps the content mounted briefly after close; remount the palette on every opening so typed text and results always start fresh.
  const [seen, setSeen] = React.useState({ open: false, n: 0 });
  if (props.open !== seen.open) setSeen({ open: props.open, n: seen.n + (props.open ? 1 : 0) });
  return (
    <DialogPrimitive.Root open={props.open} onOpenChange={props.onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="scrim fixed inset-0 z-40 bg-fg/25" />
        <DialogPrimitive.Content aria-label="Command menu" onOpenAutoFocus={() => { opener.current = document.activeElement as HTMLElement | null; }} onCloseAutoFocus={(e) => { e.preventDefault(); opener.current?.focus(); }} className="pop fixed left-1/2 top-[12vh] z-50 w-[calc(100vw-32px)] max-w-lg -translate-x-1/2 overflow-hidden rounded-card border border-line bg-surface shadow-popover">
          <DialogPrimitive.Title className="sr-only">Command menu</DialogPrimitive.Title>
          <DialogPrimitive.Description className="sr-only">Search pages and actions, then press Enter.</DialogPrimitive.Description>
          <Palette key={seen.n} {...props} />
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

/** Mounted only while the dialog is open, so its state (typed text, results, selection) resets on every opening. */
function Palette({ onOpenChange, workspace, workspaces, role }: Props) {
  const router = useRouter();
  const [input, setInput] = React.useState("");
  const q = input.trim();
  const remote = useGlobalSearch(workspace.id, q);
  // cmdk does not auto-select force-mounted items, so point the selection at the best live hit (Enter opens it).
  const firstHit = remote.groups.find((g) => g.hits.length > 0)?.hits[0];
  const firstKey = firstHit ? `${firstHit.type}:${firstHit.id}` : "";
  const [picked, setPicked] = React.useState({ forKey: "", value: "" });
  const selected = picked.forKey === firstKey ? picked.value : firstKey;
  const go = (to: string) => { onOpenChange(false); router.push(to); };
  const groups = builtNav(role);
  return (
      <Command label="Command menu" shouldFilter value={selected} onValueChange={(v) => setPicked({ forKey: firstKey, value: v })}>
        <div className="flex items-center gap-2 border-b border-line px-3">
          <Search className="size-4 text-fg-subtle" aria-hidden />
          <Command.Input value={input} onValueChange={setInput} placeholder="Search leads, pages and actions" className="h-11 flex-1 bg-transparent text-base text-fg outline-none pointer-coarse:text-md" />
          <Kbd>Esc</Kbd>
        </div>
        {q.length >= MIN_CHARS && (
          <div role="status" className="border-b border-line px-4 py-2 text-sm text-fg-muted">
            {remote.status === "loading" && "Searching…"}
            {remote.status === "done" && remote.groups.every((g) => g.hits.length === 0) && `No results for “${q}”.`}
            {remote.status === "error" && (
              <span className="flex items-center gap-2 text-danger">
                <span>Search failed. {remote.error}</span>
                <button type="button" onClick={remote.retry} className="rounded px-1 text-accent underline">Retry</button>
              </span>
            )}
          </div>
        )}
        <Command.List className="max-h-80 overflow-y-auto p-2">
          {q.length < MIN_CHARS && <Command.Empty className="px-2 py-6 text-center text-sm text-fg-muted">No matching pages or actions.</Command.Empty>}
          {remote.groups.filter((g) => g.hits.length > 0).map((g) => (
            <Command.Group key={g.type} heading={g.label} forceMount className={groupCls}>
              {g.hits.map((h) => (
                <Command.Item key={`${g.type}:${h.id}`} value={`${g.type}:${h.id}`} forceMount onSelect={() => go(h.href)} className={itemCls}>
                  <User />
                  <span className="min-w-0 flex-1"><span className="block truncate">{h.title}</span>{h.subtitle && <span className="block truncate text-xs text-fg-muted">{h.subtitle}</span>}</span>
                </Command.Item>
              ))}
            </Command.Group>
          ))}
          <Command.Group heading="Go to" className={groupCls}>
            {groups.flatMap((g) => g.items).map((item) => {
              const Icon = item.icon;
              return (
                <Command.Item key={item.key} value={item.label} onSelect={() => go(href(workspace.id, item))} className={itemCls}>
                  <Icon />
                  <span className="flex-1">{item.label}</span>
                </Command.Item>
              );
            })}
          </Command.Group>
          <Command.Group heading="Settings" className={groupCls}>
            {settingsFor(role).groups.flatMap((g) => g.items).map((i) => (
              <Command.Item key={i.path} value={`${i.label} settings`} onSelect={() => go(`/w/${workspace.id}/${i.path}`)} className={itemCls}>
                <i.icon />
                <span className="flex-1">{i.label}</span>
              </Command.Item>
            ))}
          </Command.Group>
          {workspaces.length > 1 && (
            <Command.Group heading="Switch workspace" className={groupCls}>
              {workspaces.filter((w) => w.id !== workspace.id).map((w) => (
                <Command.Item key={w.id} value={`Switch to ${w.name}`} onSelect={() => go(`/w/${w.id}`)} className={itemCls}>
                  <span className="flex-1">{w.name}</span>
                </Command.Item>
              ))}
            </Command.Group>
          )}
          <Command.Group heading="Actions" className={groupCls}>
            <Command.Item value="Create workspace" onSelect={() => go("/onboarding?new=1")} className={itemCls}><Plus /><span>Create workspace</span></Command.Item>
            <Command.Item value="Sign out" onSelect={async () => { onOpenChange(false); await authClient.signOut(); router.replace("/login"); }} className={itemCls}><LogOut /><span>Sign out</span></Command.Item>
          </Command.Group>
        </Command.List>
        <div className="flex items-center gap-3 border-t border-line px-3 py-2 text-xs text-fg-subtle"><span><Kbd>↑</Kbd> <Kbd>↓</Kbd> to move</span><span><Kbd>Enter</Kbd> to open</span></div>
      </Command>
  );
}
