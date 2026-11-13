"use client";
import * as React from "react";
import { endpoints, type NotificationPreferences } from "@crm/contracts";
import { Checkbox } from "@/components/ui/form-controls";
import { Panel } from "@/components/ui/panel";
import { browserApi, errorMessage } from "@/lib/client-api";

/** One toggle per kind, saved as soon as it changes. Per-channel columns (email, push) would add a second column of toggles here later. */
export function PreferencesForm({ workspaceId, initial }: { workspaceId: string; initial: NotificationPreferences }) {
  const [prefs, setPrefs] = React.useState(initial.preferences);
  const [message, setMessage] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);

  async function toggle(kind: (typeof prefs)[number]["kind"], inApp: boolean) {
    const before = prefs;
    setPrefs((cur) => cur.map((p) => (p.kind === kind ? { ...p, inApp } : p)));
    setError(null);
    const r = await browserApi.call(endpoints.updateNotificationPreferences, { params: { workspaceId }, body: { preferences: [{ kind, inApp }] } });
    if (!r.ok) {
      setPrefs(before);
      setError(errorMessage(r.error));
      return;
    }
    setPrefs(r.data.preferences);
    setMessage(`${before.find((p) => p.kind === kind)?.label}: ${inApp ? "on" : "off"}. Saved.`);
  }

  return (
    <Panel>
      <fieldset className="divide-y divide-line">
        <legend className="sr-only">In-app notifications</legend>
        {prefs.map((p) => (
          <div key={p.kind} className="flex flex-wrap items-start justify-between gap-x-4 px-4 py-3">
            <Checkbox label={p.label} checked={p.inApp} onChange={(e) => void toggle(p.kind, e.target.checked)} aria-describedby={`desc-${p.kind}`} className="font-medium" />
            <p id={`desc-${p.kind}`} className="max-w-xs text-sm text-fg-muted">{p.description}</p>
          </div>
        ))}
      </fieldset>
      <div className="border-t border-line px-4 py-2 text-sm text-fg-muted">
        <span role="status" aria-live="polite">{message}</span>
        {error && <span role="alert" className="text-danger-fg">{error}</span>}
      </div>
    </Panel>
  );
}
