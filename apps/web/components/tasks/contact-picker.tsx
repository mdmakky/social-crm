"use client";
import * as React from "react";
import { Search, X } from "lucide-react";
import { endpoints } from "@crm/contracts";
import { Input } from "@/components/ui/input";
import { browserApi } from "@/lib/client-api";

export type PickedContact = { id: string; name: string };
type Option = PickedContact & { detail: string | null };

/** Searchable contact combobox. The list shows recent contacts until the user types. */
export function ContactPicker({ id, workspaceId, value, onChange, describedBy, invalid }: { id: string; workspaceId: string; value: PickedContact | null; onChange: (c: PickedContact | null) => void; describedBy?: string; invalid?: boolean }) {
  const [text, setText] = React.useState("");
  const [open, setOpen] = React.useState(false);
  const [options, setOptions] = React.useState<Option[]>([]);
  const [state, setState] = React.useState<"idle" | "loading" | "error">("idle");
  const [active, setActive] = React.useState(0);
  const seq = React.useRef(0);
  const listId = `${id}-list`;

  React.useEffect(() => {
    if (!open) return;
    const mine = ++seq.current;
    const t = setTimeout(async () => {
      setState("loading");
      const r = await browserApi.call(endpoints.listContacts, { params: { workspaceId }, query: { search: text.trim() || undefined, limit: 8 } });
      if (mine !== seq.current) return;
      if (!r.ok) return setState("error");
      setOptions(r.data.items.map((c) => ({ id: c.id, name: c.name, detail: c.email ?? c.phone ?? c.company })));
      setActive(0);
      setState("idle");
    }, text ? 200 : 0);
    return () => clearTimeout(t);
  }, [text, open, workspaceId]);

  const pick = (o: Option) => { onChange({ id: o.id, name: o.name }); setText(""); setOpen(false); };

  if (value) {
    return (
      <div className="flex min-h-10 items-center justify-between gap-2 rounded-md border border-line-strong bg-surface px-3 py-1.5 pointer-coarse:min-h-11">
        <span id={id} className="min-w-0 truncate text-base text-fg">{value.name}</span>
        <button type="button" onClick={() => onChange(null)} aria-label={`Remove contact ${value.name}`} className="flex size-7 shrink-0 items-center justify-center rounded text-fg-muted hover:bg-hover hover:text-fg pointer-coarse:size-11"><X className="size-4" aria-hidden /></button>
      </div>
    );
  }
  return (
    <div className="relative">
      <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-fg-subtle" aria-hidden />
      <Input
        id={id}
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={open && options[active] ? `${id}-opt-${options[active]!.id}` : undefined}
        aria-describedby={describedBy}
        aria-invalid={invalid}
        autoComplete="off"
        placeholder="Search contacts by name, email or phone"
        className="pl-8"
        value={text}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        onChange={(e) => { setText(e.target.value); setOpen(true); }}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") { e.preventDefault(); setOpen(true); setActive((a) => Math.min(a + 1, options.length - 1)); }
          else if (e.key === "ArrowUp") { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); }
          else if (e.key === "Enter" && open && options[active]) { e.preventDefault(); pick(options[active]!); }
          else if (e.key === "Escape" && open) { e.stopPropagation(); setOpen(false); }
        }}
      />
      {open && (
        <ul id={listId} role="listbox" aria-label="Matching contacts" className="absolute z-20 mt-1 max-h-60 w-full overflow-auto rounded-md border border-line bg-surface py-1 shadow-lg">
          {state === "error" ? <li role="presentation" className="px-3 py-2 text-sm text-danger-fg">Contacts could not be loaded. Keep typing to try again.</li>
            : options.length === 0 ? <li role="presentation" className="px-3 py-2 text-sm text-fg-muted">{state === "loading" ? "Searching…" : "No contacts found."}</li>
            : options.map((o, i) => (
              <li key={o.id} id={`${id}-opt-${o.id}`} role="option" aria-selected={i === active} onMouseDown={(e) => { e.preventDefault(); pick(o); }} onMouseEnter={() => setActive(i)} className={`cursor-pointer px-3 py-2 pointer-coarse:py-3 ${i === active ? "bg-hover" : ""}`}>
                <span className="block truncate text-base text-fg">{o.name}</span>
                {o.detail && <span className="block truncate text-sm text-fg-muted">{o.detail}</span>}
              </li>
            ))}
        </ul>
      )}
    </div>
  );
}
