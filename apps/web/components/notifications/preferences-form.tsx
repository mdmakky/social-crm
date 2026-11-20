"use client";
import * as React from "react";
import { endpoints, type NotificationPreferences } from "@crm/contracts";
import { Bell, CheckCheck, Clock, FileText, Info, ListChecks, Upload, UserPlus, type LucideIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogActions, DialogClose, DialogContent } from "@/components/ui/overlays";
import { Panel } from "@/components/ui/panel";
import { Alert } from "@/components/ui/states";
import { Switch } from "@/components/ui/switch";
import { browserApi, errorMessage } from "@/lib/client-api";

type Pref = NotificationPreferences["preferences"][number];
type Change = { kind: Pref["kind"]; inApp: boolean }[];

const REMINDERS = new Set<string>(["task.reminder"]);
/** An unknown future kind falls back to Bell and lands in Updates, so a preference is never hidden. */
const ICONS: Record<string, LucideIcon> = { "task.reminder": Clock, "contact.owner_assigned": UserPlus, "lead.owner_assigned": FileText, "task.assigned": ListChecks, "import.completed": Upload };

/** One switch per kind, saved the moment it changes. Per-channel columns (email, push) would add a second column of switches per row later. */
export function PreferencesForm({ workspaceId, initial }: { workspaceId: string; initial: NotificationPreferences }) {
  const [prefs, setPrefs] = React.useState(initial.preferences);
  const [announce, setAnnounce] = React.useState("");
  const [savedKinds, setSavedKinds] = React.useState<string[]>([]);
  const [error, setError] = React.useState<{ text: string; retry: Change } | null>(null);
  const [confirmOff, setConfirmOff] = React.useState(false);
  const timers = React.useRef<number[]>([]);
  React.useEffect(() => () => timers.current.forEach(clearTimeout), []);

  async function save(changes: Change, summary: string) {
    const before = prefs;
    setPrefs((cur) => cur.map((p) => { const c = changes.find((x) => x.kind === p.kind); return c ? { ...p, inApp: c.inApp } : p; }));
    setError(null);
    const r = await browserApi.call(endpoints.updateNotificationPreferences, { params: { workspaceId }, body: { preferences: changes } });
    if (!r.ok) {
      setPrefs(before);
      setError({ text: `Could not save. ${errorMessage(r.error)}`, retry: changes });
      return;
    }
    setPrefs(r.data.preferences);
    setAnnounce(`${summary} Saved.`);
    const kinds = changes.map((c) => c.kind as string);
    setSavedKinds((s) => [...s, ...kinds]);
    timers.current.push(window.setTimeout(() => setSavedKinds((s) => s.filter((k) => !kinds.includes(k))), 2500));
  }

  const reminders = prefs.filter((p) => REMINDERS.has(p.kind));
  const updates = prefs.filter((p) => !REMINDERS.has(p.kind));
  const remindersOff = reminders.length > 0 && reminders.every((p) => !p.inApp);
  const allOn = updates.every((p) => p.inApp);

  function toggle(p: Pref, inApp: boolean) {
    if (REMINDERS.has(p.kind) && !inApp) return setConfirmOff(true);
    void save([{ kind: p.kind, inApp }], `${p.label}: ${inApp ? "on" : "off"}.`);
  }

  const row = (p: Pref) => {
    const Icon = ICONS[p.kind] ?? Bell;
    return (
      <li key={p.kind} className="flex items-center gap-3 px-4 py-3">
        <span aria-hidden className="grid size-8 shrink-0 place-items-center rounded-control bg-subtle text-fg-muted"><Icon className="size-4" /></span>
        <div className="min-w-0 flex-1">
          <p className="text-base font-medium text-fg">{p.label}</p>
          <p id={`desc-${p.kind}`} className="text-sm text-fg-muted">{p.description}</p>
        </div>
        <span aria-hidden className={`inline-flex items-center gap-1 text-sm text-success-fg transition-opacity duration-500 ${savedKinds.includes(p.kind) ? "opacity-100" : "opacity-0"}`}><CheckCheck className="size-4" />Saved</span>
        <Switch checked={p.inApp} onCheckedChange={(v) => toggle(p, v)} label={p.label} aria-describedby={`desc-${p.kind}`} />
      </li>
    );
  };

  return (
    <div className="flex flex-col gap-[var(--page-gap)]">
      <section aria-labelledby="grp-reminders" className="flex flex-col gap-2">
        <div>
          <h2 id="grp-reminders" className="text-md font-semibold text-fg">Reminders</h2>
          <p className="text-sm text-fg-subtle">What needs you, when it is time.</p>
        </div>
        {remindersOff && (
          <Alert tone="warning">
            <span>Task reminders are off. You will not be told when a follow-up is due.</span>{" "}
            <button type="button" className="font-medium underline underline-offset-2" onClick={() => void save(reminders.map((p) => ({ kind: p.kind, inApp: true })), "Task reminders: on.")}>Turn on</button>
          </Alert>
        )}
        <Panel><ul className="divide-y divide-line">{reminders.map(row)}</ul></Panel>
      </section>

      <section aria-labelledby="grp-updates" className="flex flex-col gap-2">
        <div className="flex items-end justify-between gap-3">
          <div>
            <h2 id="grp-updates" className="text-md font-semibold text-fg">Updates</h2>
            <p className="text-sm text-fg-subtle">What happened.</p>
          </div>
          {updates.length > 0 && (
            <Button variant="ghost" size="sm" onClick={() => void save(updates.map((p) => ({ kind: p.kind, inApp: !allOn })), `Updates: all ${allOn ? "off" : "on"}.`)}>{allOn ? "Turn off all" : "Turn on all"}</Button>
          )}
        </div>
        <Panel><ul className="divide-y divide-line">{updates.map(row)}</ul></Panel>
      </section>

      {error && (
        <Alert tone="error">
          <span>{error.text}</span>{" "}
          <button type="button" className="font-medium underline underline-offset-2" onClick={() => void save(error.retry, "Updated.")}>Try again</button>
        </Alert>
      )}
      <p className="flex items-center gap-2 text-sm text-fg-muted"><Info aria-hidden className="size-4 shrink-0" />In-app only for now. Email and push are not available yet.</p>
      <span role="status" aria-live="polite" className="sr-only">{announce}</span>

      <Dialog open={confirmOff} onOpenChange={setConfirmOff}>
        <DialogContent title="Turn off task reminders?" description="You will not be told when a follow-up is due.">
          <DialogActions>
            <DialogClose asChild><Button>Keep on</Button></DialogClose>
            <Button variant="danger" onClick={() => { setConfirmOff(false); void save(reminders.map((p) => ({ kind: p.kind, inApp: false })), "Task reminders: off.") }}>Turn off</Button>
          </DialogActions>
        </DialogContent>
      </Dialog>
    </div>
  );
}
