"use client";
import * as React from "react";
import { endpoints, type StageCheck } from "@crm/contracts";
import { Badge, Status } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input, Select } from "@/components/ui/input";
import { Dialog, DialogActions, DialogContent } from "@/components/ui/overlays";
import { Alert } from "@/components/ui/states";
import { browserApi } from "@/lib/client-api";
import { stageHue } from "@/lib/contact-lead";
import { CURRENCIES, toMinor } from "@/lib/leads";

/** What the person chose in the dialog. `cancel`: leave the lead where it is. No `value`: move without one (the event is recorded as skipped). */
export type ValueChoice = { cancel: true } | { cancel?: false; value?: { valueMinor: number; currency: string } };
type Target = { id: string; name: string; kind: "open" | "won" | "lost"; position: number };

const MAX_MINOR = 9_000_000_000_000; // same limit as the API
const digitsOf = (cur: string) => new Intl.NumberFormat("en", { style: "currency", currency: cur }).resolvedOptions().maximumFractionDigits ?? 2;
const money = (minor: number, cur: string) => new Intl.NumberFormat("en", { style: "currency", currency: cur }).format(minor / 10 ** digitsOf(cur));

/** The amount as typed: null with a plain reason when it is not usable. Greater than 0, at most the currency's minor units, within a sane maximum. */
export function parseAmount(text: string, cur: string): { minor: number } | { error: string } {
  const t = text.trim().replace(/,/g, "");
  if (!/^\d+(\.\d+)?$/.test(t)) return { error: "Enter an amount above 0, for example 2500 or 2,500.50." };
  const d = digitsOf(cur);
  if ((t.split(".")[1]?.length ?? 0) > d) return { error: d === 0 ? `${cur} has no decimals. Enter a whole number.` : `${cur} allows at most ${d} decimals.` };
  const minor = toMinor(t, cur);
  if (minor === null || minor <= 0) return { error: "Enter an amount above 0." };
  if (minor > MAX_MINOR) return { error: "That amount is too large." };
  return { minor };
}

/**
 * Before a stage change: ask the server whether a firing ad rule needs a deal value the lead does not have (GET stage-check).
 * `gate()` resolves at once when nothing is needed (or when the check itself fails: a preflight problem never blocks a move), otherwise it opens the dialog and resolves with the choice.
 * Render `dialog` once, anywhere in the component that calls gate.
 */
export function useStageValueGate(workspaceId: string) {
  const [req, setReq] = React.useState<{ check: StageCheck; name: string; stage: Target; done: (c: ValueChoice) => void } | null>(null);
  const gate = React.useCallback(async (contact: { id: string; name: string }, stage: Target): Promise<ValueChoice> => {
    const r = await browserApi.call(endpoints.checkStageChange, { params: { workspaceId, contactId: contact.id }, query: { stageId: stage.id } });
    if (!r.ok || !r.data.needsValue) return {};
    return new Promise<ValueChoice>((resolve) => setReq({ check: r.data, name: contact.name, stage, done: (c) => { setReq(null); resolve(c); } }));
  }, [workspaceId]);
  const dialog = req ? <ValueDialog check={req.check} name={req.name} stage={req.stage} onDone={req.done} /> : null;
  return { gate, dialog };
}

const consentText = { granted: ["Granted, will be sent", "success"], revoked: ["Not granted, nothing is sent", "danger"], none: ["Not granted, nothing is sent", "danger"] } as const;

export function ValueDialog({ check, name, stage, onDone }: { check: StageCheck; name: string; stage: Target; onDone: (c: ValueChoice) => void }) {
  const asked = check.fires.filter((f) => f.ask);
  const events = [...new Set(asked.map((f) => f.eventName))];
  const eventText = events.join(" and ");
  const [text, setText] = React.useState("");
  const [cur, setCur] = React.useState(check.currency);
  const [error, setError] = React.useState<string | null>(null);
  const parsed = text.trim() ? parseAmount(text, cur) : null;
  const canSet = check.canSetValue;
  const consent = consentText[check.consent];
  const currencies = CURRENCIES.includes(cur as never) ? CURRENCIES : [...CURRENCIES, cur];

  function save() {
    const p = parseAmount(text, cur);
    if ("error" in p) { setError(text.trim() ? p.error : "Enter an amount above 0."); return; }
    onDone({ value: { valueMinor: p.minor, currency: cur } });
  }

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onDone({ cancel: true }); }}>
      <DialogContent title="Add a deal value">
        <form className="flex flex-col gap-4" noValidate onSubmit={(e) => { e.preventDefault(); if (canSet) save(); }}>
          <p className="text-md text-fg-muted">
            Moving <b className="font-semibold text-fg">{name}</b> to <Status hue={stageHue(stage)} className="text-base font-medium"><span>{stage.name}</span></Status> sends <b className="font-semibold text-fg">{eventText}</b> to Meta, and {events.length > 1 ? "they need" : `${eventText} needs`} a value.
          </p>
          {canSet ? (
            <Field label="Deal value" error={error}>{(p) => (
              <div className="grid grid-cols-[1fr_6rem] gap-2">
                <Input {...p} inputMode="decimal" autoComplete="off" placeholder="0" value={text} className="h-11 text-md" onChange={(e) => { setText(e.target.value); setError(null); }} />
                <Select aria-label="Currency" value={cur} wrapperClassName="[&_select]:h-11" onChange={(e) => { setCur(e.target.value); setError(null); }}>{currencies.map((c) => <option key={c}>{c}</option>)}</Select>
              </div>
            )}</Field>
          ) : (
            <Alert tone="info">You can&apos;t add a deal value here. An owner or admin needs to add it on the lead. You can still move it without a value.</Alert>
          )}
          <div className="rounded-card border border-line bg-canvas p-3">
            <p className="mb-2 text-xs font-semibold text-fg-subtle">What will be sent to Meta</p>
            <dl className="grid grid-cols-[5.5rem_1fr] items-center gap-x-3 gap-y-1.5 text-base">
              <dt className="text-fg-subtle">Event</dt><dd className="font-medium text-fg">{eventText}</dd>
              <dt className="text-fg-subtle">Value</dt><dd className="text-fg" aria-live="polite">{parsed && "minor" in parsed ? money(parsed.minor, cur) : "Not set yet"}</dd>
              <dt className="text-fg-subtle">Ad consent</dt><dd><Badge tone={consent[1]}>{consent[0]}</Badge></dd>
              {asked.some((f) => f.datasetMode === "mock") && <><dt className="text-fg-subtle">Dataset</dt><dd><Badge tone="warning">MOCK</Badge> <span className="text-fg-muted">nothing reaches Meta yet</span></dd></>}
            </dl>
          </div>
          <DialogActions className="flex-wrap max-md:flex-col-reverse max-md:[&>button]:min-h-11 max-md:[&>button]:w-full">
            <Button type="button" variant="ghost" onClick={() => onDone({ cancel: true })}>Cancel</Button>
            <Button type="button" onClick={() => onDone({})}>Move without value</Button>
            {canSet && <Button type="submit" variant="primary">Save and move</Button>}
          </DialogActions>
          <p className="text-xs text-fg-subtle">{asked.some((f) => f.eventName === "Purchase") ? "\u201CMove without value\u201D changes the stage and sends nothing to Meta. It is recorded as skipped." : "\u201CMove without value\u201D changes the stage and sends the event without a value."}</p>
        </form>
      </DialogContent>
    </Dialog>
  );
}
