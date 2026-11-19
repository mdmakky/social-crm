"use client";
import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Bell, ChevronRight, LogOut, Moon, Sun, Upload } from "lucide-react";
import { endpoints, PASSWORD_MIN_LENGTH, UpdateWorkspaceBody, type WorkspaceDetail } from "@crm/contracts";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input, Select } from "@/components/ui/input";
import { Panel } from "@/components/ui/panel";
import { Alert } from "@/components/ui/states";
import { authClient } from "@/lib/auth-client";
import { browserApi, errorMessage } from "@/lib/client-api";
import { cn } from "@/lib/cn";
import { ROLE_LABEL } from "@/lib/format";
import { CURRENCIES } from "@/lib/leads";

type Draft = Pick<WorkspaceDetail, "name" | "timezone" | "currency" | "timeFormat" | "weekStart" | "business" | "logo">;
const pick = (w: WorkspaceDetail): Draft => ({ name: w.name, timezone: w.timezone, currency: w.currency, timeFormat: w.timeFormat, weekStart: w.weekStart, business: { ...w.business }, logo: w.logo });
const same = (a: Draft, b: Draft) => JSON.stringify(a) === JSON.stringify(b);

const Row = ({ label, hint, children, id }: { label: string; hint?: string; children: React.ReactNode; id?: string }) => (
  <div className="grid gap-x-8 gap-y-1.5 border-b border-line px-4 py-4 last:border-b-0 md:grid-cols-[13rem_minmax(0,1fr)]">
    <div className="md:pt-2"><p id={id} className="text-base font-medium text-fg">{label}</p>{hint && <p className="mt-0.5 text-xs text-fg-subtle">{hint}</p>}</div>
    <div className="min-w-0">{children}</div>
  </div>
);
const Section = ({ title, children }: { title: string; children: React.ReactNode }) => <section className="flex flex-col gap-2"><h2 className="px-1 text-xs font-semibold uppercase tracking-wide text-fg-subtle">{title}</h2><Panel>{children}</Panel></section>;

/** Two or three buttons where exactly one is chosen. */
function Choice<T extends string>({ label, value, options, onChange, disabled }: { label: string; value: T; options: readonly (readonly [T, string])[]; onChange: (v: T) => void; disabled?: boolean }) {
  return (
    <div role="group" aria-label={label} className="inline-flex flex-wrap gap-1 rounded-control bg-subtle p-0.5">
      {options.map(([v, text]) => <button key={v} type="button" disabled={disabled} aria-pressed={value === v} onClick={() => onChange(v)} className={cn("press h-8 rounded-[6px] px-3 text-sm font-medium pointer-coarse:h-11 disabled:opacity-50", value === v ? "bg-surface text-fg shadow-sm" : "text-fg-muted hover:text-fg")}>{text}</button>)}
    </div>
  );
}

const offsetOf = (tz: string, at: Date) => { try { return (new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "shortOffset" }).formatToParts(at).find((p) => p.type === "timeZoneName")?.value ?? "").replace("GMT", "UTC"); } catch { return ""; } };
const clockOf = (tz: string, at: Date, h12: boolean) => new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit", hour12: h12 }).format(at);
const dayOf = (tz: string, at: Date) => new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short" }).format(at);
const hourOf = (tz: string, at: Date) => Number(new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", hour12: false }).format(at)) % 24;
const cityOf = (tz: string) => tz.split("/").slice(-1)[0]!.replace(/_/g, " ");

function useNow() {
  const [now, setNow] = React.useState(() => new Date());
  React.useEffect(() => { const t = setInterval(() => setNow(new Date()), 30_000); return () => clearInterval(t); }, []);
  return now;
}

function TimeZoneRow({ value, onChange, h12, disabled }: { value: string; onChange: (tz: string) => void; h12: boolean; disabled: boolean }) {
  const now = useNow();
  const [open, setOpen] = React.useState(false);
  const [q, setQ] = React.useState("");
  const device = React.useMemo(() => Intl.DateTimeFormat().resolvedOptions().timeZone, []);
  const zones = React.useMemo(() => {
    const all = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.("timeZone") ?? [];
    return Array.from(new Set(["UTC", ...all, value]));
  }, [value]);
  const shown = React.useMemo(() => {
    const s = q.trim().toLowerCase();
    return (s ? zones.filter((z) => `${z} ${cityOf(z)}`.toLowerCase().includes(s)) : zones).slice(0, 60);
  }, [zones, q]);
  const day = (z: string) => { const h = hourOf(z, now); return h >= 6 && h < 18; };
  const Icon = day(value) ? Sun : Moon;
  return (
    <div>
      <div className="flex flex-wrap items-center gap-3">
        <span aria-hidden className="grid size-11 shrink-0 place-items-center rounded-xl bg-warning-bg text-warning-fg"><Icon className="size-5" /></span>
        <div className="min-w-0 flex-1">
          <p className="tnum text-xl font-bold leading-6 text-fg" data-testid="tz-clock">{clockOf(value, now, h12)}</p>
          <p className="text-sm text-fg-muted">{dayOf(value, now)} · {value.replace(/_/g, " ")} · {offsetOf(value, now)}</p>
        </div>
        {!disabled && <Button size="sm" aria-expanded={open} onClick={() => setOpen((o) => !o)}>{open ? "Done" : "Change"}</Button>}
      </div>
      {open && (
        <div className="mt-3 overflow-hidden rounded-card border border-line">
          <Input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search city or region" aria-label="Search time zones" className="rounded-none border-0 border-b border-line" />
          <ul role="listbox" aria-label="Time zones" className="max-h-72 overflow-y-auto overscroll-contain">
            {shown.length === 0 && <li className="p-5 text-center text-sm text-fg-subtle">No time zone matches “{q}”.</li>}
            {shown.map((z) => (
              <li key={z} role="option" aria-selected={z === value}>
                <button type="button" onClick={() => { onChange(z); setOpen(false); setQ(""); }} className={cn("press grid min-h-14 w-full grid-cols-[2rem_minmax(0,1fr)_auto] items-center gap-3 border-b border-line px-3 py-2 text-left last:border-b-0 hover:bg-subtle", z === value && "bg-accent-subtle")}>
                  <span aria-hidden className="text-fg-subtle">{day(z) ? <Sun className="size-4" /> : <Moon className="size-4" />}</span>
                  <span className="min-w-0"><span className="block truncate font-medium text-fg">{cityOf(z)}</span><span className="block truncate text-xs text-fg-subtle">{z} · {offsetOf(z, now)}</span></span>
                  <span className="tnum text-sm text-fg-muted">{dayOf(z, now)} {clockOf(z, now, h12)}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
      {!disabled && (device === value ? <p className="mt-2 text-sm text-success-fg">Matches this device</p> : <p className="mt-2 text-sm text-fg-muted">This device is in {cityOf(device)}. <button type="button" className="font-semibold text-accent-fg underline underline-offset-4" onClick={() => onChange(device)}>Use it</button></p>)}
    </div>
  );
}

/** Shrinks the picked image to a 128 px square (centre crop) and returns a data URL small enough to store with the workspace. */
async function logoFrom(file: File): Promise<string> {
  if (!/^image\/(png|jpeg|webp)$/.test(file.type)) throw new Error("Use a PNG, JPG or WebP image.");
  const bmp = await createImageBitmap(file).catch(() => { throw new Error("That image could not be read."); });
  const S = 128;
  const c = document.createElement("canvas");
  c.width = S; c.height = S;
  const g = c.getContext("2d")!;
  const side = Math.min(bmp.width, bmp.height);
  g.drawImage(bmp, (bmp.width - side) / 2, (bmp.height - side) / 2, side, side, 0, 0, S, S);
  const out = c.toDataURL("image/webp", 0.85);
  const url = /^data:image\/webp/.test(out) ? out : c.toDataURL("image/png");
  if (url.length > 90_000) throw new Error("That image is too detailed. Try a simpler one.");
  return url;
}

function LogoRow({ name, logo, onChange, disabled }: { name: string; logo: string | null; onChange: (l: string | null) => void; disabled: boolean }) {
  const input = React.useRef<HTMLInputElement>(null);
  const [err, setErr] = React.useState<string | null>(null);
  return (
    <div className="flex flex-wrap items-center gap-3">
      {logo
        ? <img src={logo} alt="Workspace logo" className="size-14 rounded-xl object-cover" />
        : <span aria-hidden className="grid size-14 place-items-center rounded-xl bg-accent text-lg font-bold text-on-accent">{(name.trim() || "?").slice(0, 2).toUpperCase()}</span>}
      {!disabled && (
        <div className="flex flex-wrap gap-2">
          <input ref={input} type="file" accept="image/png,image/jpeg,image/webp" className="sr-only" tabIndex={-1} aria-label="Choose a logo image" onChange={async (e) => { const f = e.target.files?.[0]; e.target.value = ""; if (!f) return; try { setErr(null); onChange(await logoFrom(f)); } catch (x) { setErr((x as Error).message); } }} />
          <Button size="sm" onClick={() => input.current?.click()}><Upload />{logo ? "Replace logo" : "Upload logo"}</Button>
          {logo && <Button size="sm" variant="ghost" onClick={() => onChange(null)}>Remove</Button>}
        </div>
      )}
      <p className="basis-full text-xs text-fg-subtle">{err ? <span role="alert" className="text-danger-fg">{err}</span> : "Shown in the sidebar. A square picture works best; without one we use the first letters of the name."}</p>
    </div>
  );
}

function PasswordRow() {
  const [open, setOpen] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [msg, setMsg] = React.useState<{ ok: boolean; text: string } | null>(null);
  const [cur, setCur] = React.useState("");
  const [next, setNext] = React.useState("");
  const [again, setAgain] = React.useState("");
  const problem = next && next.length < PASSWORD_MIN_LENGTH ? `Use at least ${PASSWORD_MIN_LENGTH} characters.` : again && again !== next ? "The two passwords do not match." : null;
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!cur || !next || problem) return;
    setBusy(true); setMsg(null);
    const r = await authClient.changePassword({ currentPassword: cur, newPassword: next, revokeOtherSessions: true });
    setBusy(false);
    if (r.error) return setMsg({ ok: false, text: r.error.message ?? "The password could not be changed." });
    setCur(""); setNext(""); setAgain(""); setOpen(false);
    setMsg({ ok: true, text: "Password changed. Other devices were signed out." });
  }
  return (
    <div>
      {msg && !open && <Alert tone={msg.ok ? "success" : "error"}>{msg.text}</Alert>}
      {!open ? <Button size="sm" className={msg ? "mt-2" : ""} onClick={() => { setOpen(true); setMsg(null); }}>Change password</Button> : (
        <form onSubmit={submit} noValidate className="flex max-w-sm flex-col gap-3">
          {msg && <Alert tone={msg.ok ? "success" : "error"}>{msg.text}</Alert>}
          <Field label="Current password">{(p) => <Input {...p} type="password" autoComplete="current-password" value={cur} onChange={(e) => setCur(e.target.value)} />}</Field>
          <Field label="New password" hint={`At least ${PASSWORD_MIN_LENGTH} characters.`} error={next ? problem && next.length < PASSWORD_MIN_LENGTH ? problem : null : null}>{(p) => <Input {...p} type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} />}</Field>
          <Field label="New password again" error={again && again !== next ? "The two passwords do not match." : null}>{(p) => <Input {...p} type="password" autoComplete="new-password" value={again} onChange={(e) => setAgain(e.target.value)} />}</Field>
          <p className="text-xs text-fg-subtle">Changing it signs you out on your other devices.</p>
          <div className="flex gap-2"><Button type="submit" variant="primary" loading={busy} disabled={!cur || !next || !!problem || !again}>Change password</Button><Button type="button" variant="ghost" onClick={() => { setOpen(false); setMsg(null); setCur(""); setNext(""); setAgain(""); }}>Cancel</Button></div>
        </form>
      )}
    </div>
  );
}

function NameRow({ name }: { name: string }) {
  const router = useRouter();
  const [value, setValue] = React.useState(name);
  const [busy, setBusy] = React.useState(false);
  const [msg, setMsg] = React.useState<{ ok: boolean; text: string } | null>(null);
  const bad = !value.trim() ? "Enter your name." : value.trim().length > 80 ? "Use at most 80 characters." : null;
  async function save() {
    if (bad || value.trim() === name) return;
    setBusy(true); setMsg(null);
    const r = await authClient.updateUser({ name: value.trim() });
    setBusy(false);
    if (r.error) return setMsg({ ok: false, text: r.error.message ?? "The name could not be saved." });
    setMsg({ ok: true, text: "Name saved." });
    router.refresh();
  }
  return (
    <form onSubmit={(e) => { e.preventDefault(); void save(); }} noValidate className="flex max-w-sm flex-col gap-2">
      <div className="flex gap-2">
        <Input aria-label="Your name" value={value} onChange={(e) => { setValue(e.target.value); setMsg(null); }} maxLength={90} aria-invalid={bad ? true : undefined} autoComplete="name" />
        <Button type="submit" loading={busy} disabled={!!bad || value.trim() === name}>Save</Button>
      </div>
      {(bad || msg) && <p role={msg?.ok ? "status" : "alert"} className={cn("text-xs", bad || !msg?.ok ? "text-danger-fg" : "text-success-fg")}>{bad ?? msg!.text}</p>}
    </form>
  );
}

export function GeneralSettings({ workspaceId, workspace, me, canEdit }: { workspaceId: string; workspace: WorkspaceDetail; me: { name: string; email: string }; canEdit: boolean }) {
  const router = useRouter();
  const [saved, setSaved] = React.useState<Draft>(() => pick(workspace));
  const [d, setD] = React.useState<Draft>(() => pick(workspace));
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [done, setDone] = React.useState(false);
  const [out, setOut] = React.useState(false);
  const dirty = canEdit && !same(d, saved);
  const set = (p: Partial<Draft>) => { setD((x) => ({ ...x, ...p })); setDone(false); };
  const biz = (k: keyof Draft["business"], v: string) => set({ business: { ...d.business, [k]: v } });
  const h12 = d.timeFormat === "12h";
  const currencies = (CURRENCIES as readonly string[]).includes(d.currency) ? CURRENCIES : [...CURRENCIES, d.currency];

  const parsed = React.useMemo(() => {
    const body: Record<string, unknown> = {};
    if (d.name.trim() !== saved.name) body.name = d.name.trim();
    if (d.timezone !== saved.timezone) body.timezone = d.timezone;
    if (d.currency !== saved.currency) body.currency = d.currency;
    if (d.timeFormat !== saved.timeFormat) body.timeFormat = d.timeFormat;
    if (d.weekStart !== saved.weekStart) body.weekStart = d.weekStart;
    const b = Object.fromEntries((Object.keys(d.business) as (keyof Draft["business"])[]).filter((k) => d.business[k].trim() !== saved.business[k]).map((k) => [k, d.business[k].trim()]));
    if (Object.keys(b).length) body.business = b;
    if (d.logo !== saved.logo) body.logo = d.logo;
    return { body, result: UpdateWorkspaceBody.safeParse(body) };
  }, [d, saved]);
  const nameError = !d.name.trim() ? "Give the workspace a name." : d.name.trim().length < 2 ? "Use at least 2 characters." : d.name.trim().length > 60 ? "Use at most 60 characters." : null;
  const issue = (k: string) => (parsed.result.success ? null : parsed.result.error.issues.find((i) => i.path.join(".") === k)?.message ?? null);

  async function save() {
    if (!parsed.result.success || nameError) return;
    setBusy(true); setError(null);
    const r = await browserApi.call(endpoints.updateWorkspace, { params: { workspaceId }, body: parsed.result.data });
    setBusy(false);
    if (!r.ok) return setError(errorMessage(r.error));
    const next = { ...d, name: d.name.trim(), business: Object.fromEntries(Object.entries(d.business).map(([k, v]) => [k, v.trim()])) as Draft["business"] };
    setSaved(next); setD(next); setDone(true);
    router.refresh();
  }
  const discard = () => { setD(saved); setError(null); };

  return (
    <div className="flex flex-col gap-[var(--page-gap)]">
      {dirty && (
        <div role="region" aria-label="Unsaved changes" className="fixed inset-x-0 bottom-[var(--bottomnav-h)] z-30 flex items-center gap-2 border-t border-line bg-fg px-4 py-2.5 text-surface md:sticky md:inset-x-auto md:bottom-auto md:top-0 md:rounded-card md:border md:border-accent/30 md:bg-accent-subtle md:text-accent-fg">
          <span className="min-w-0 flex-1 text-sm font-medium">Unsaved changes</span>
          <Button variant="ghost" size="sm" className="text-inherit hover:bg-surface/15 md:hover:bg-accent/10" onClick={discard} disabled={busy}>Discard</Button>
          <Button variant="primary" size="sm" className="max-md:bg-surface max-md:text-fg" onClick={() => void save()} loading={busy} disabled={!parsed.result.success || !!nameError}>Save changes</Button>
        </div>
      )}
      {error && <Alert tone="error">{error}</Alert>}
      {done && !dirty && <Alert tone="success">Settings saved.</Alert>}
      {!canEdit && <Alert tone="info">Only owners and admins can change the workspace settings.</Alert>}

      <Section title="Workspace">
        <Row label="Logo"><LogoRow name={d.name} logo={d.logo} onChange={(l) => set({ logo: l })} disabled={!canEdit} /></Row>
        <Row label="Name" hint="Visible to everyone who works here."><Field label="Workspace name" error={nameError}>{(p) => <Input {...p} className="max-w-md" value={d.name} maxLength={80} disabled={!canEdit} onChange={(e) => set({ name: e.target.value })} />}</Field></Row>
        <Row label="Role"><div className="flex flex-wrap items-center gap-2 pt-1"><Badge tone="accent">{ROLE_LABEL[workspace.role]}</Badge><span className="text-sm text-fg-muted">{workspace.memberCount} {workspace.memberCount === 1 ? "member" : "members"}</span><Link href={`/w/${workspaceId}/members`} className="text-sm font-semibold text-accent-fg">Members</Link></div></Row>
      </Section>

      <Section title="Region and format">
        <Row label="Time zone" hint="Dates and times in this workspace."><TimeZoneRow value={d.timezone} onChange={(tz) => set({ timezone: tz })} h12={h12} disabled={!canEdit} /></Row>
        <Row label="Currency" hint="The default for new pipelines and lead values."><Field label="Default currency">{(p) => <Select {...p} wrapperClassName="max-w-[10rem]" value={d.currency} disabled={!canEdit} onChange={(e) => set({ currency: e.target.value })}>{currencies.map((c) => <option key={c}>{c}</option>)}</Select>}</Field></Row>
        <Row label="Time format" hint="Used in tasks, follow-ups and notifications."><Choice label="Time format" value={d.timeFormat} options={[["12h", "12-hour"], ["24h", "24-hour"]] as const} disabled={!canEdit} onChange={(v) => set({ timeFormat: v })} /></Row>
        <Row label="Week starts on" hint="Used in the date picker for follow-ups."><Choice label="Week starts on" value={d.weekStart} options={[["sat", "Saturday"], ["sun", "Sunday"], ["mon", "Monday"]] as const} disabled={!canEdit} onChange={(v) => set({ weekStart: v })} /></Row>
      </Section>

      <Section title="Business info">
        <Row label="Contact" hint="For your own reference now; web chat and email will use it later.">
          <div className="grid max-w-xl gap-3 sm:grid-cols-2">
            <Field label="Phone" error={issue("business.phone")}>{(p) => <Input {...p} type="tel" autoComplete="off" value={d.business.phone} disabled={!canEdit} onChange={(e) => biz("phone", e.target.value)} />}</Field>
            <Field label="Support email" error={issue("business.email")}>{(p) => <Input {...p} type="email" autoComplete="off" value={d.business.email} disabled={!canEdit} onChange={(e) => biz("email", e.target.value)} />}</Field>
            <Field label="Website" className="sm:col-span-2" error={issue("business.website")} hint="Start with https://">{(p) => <Input {...p} inputMode="url" autoComplete="off" value={d.business.website} disabled={!canEdit} onChange={(e) => biz("website", e.target.value)} />}</Field>
            <Field label="Address" className="sm:col-span-2" error={issue("business.address")}>{(p) => <Input {...p} autoComplete="off" value={d.business.address} disabled={!canEdit} onChange={(e) => biz("address", e.target.value)} />}</Field>
          </div>
        </Row>
      </Section>

      <Section title="Your account">
        <Row label="Name"><NameRow name={me.name} /></Row>
        <Row label="Email"><p className="pt-2 text-base text-fg">{me.email}</p></Row>
        <Row label="Password" hint="Changing it signs you out on other devices."><PasswordRow /></Row>
        <Row label="Session"><Button loading={out} onClick={async () => { setOut(true); await authClient.signOut(); router.replace("/login"); }}><LogOut />Sign out</Button></Row>
        <Link href={`/w/${workspaceId}/settings/notifications`} className="press flex min-h-14 items-center gap-3 border-t border-line px-4 py-3 hover:bg-subtle">
          <Bell className="size-5 text-fg-subtle" aria-hidden /><span className="min-w-0 flex-1"><span className="block font-medium text-fg">Notification preferences</span><span className="block text-xs text-fg-subtle">Choose what shows up in the bell.</span></span><ChevronRight className="size-4 text-fg-subtle" aria-hidden />
        </Link>
      </Section>

      <Panel><div className="flex items-center gap-3 px-4 py-4"><div className="min-w-0 flex-1"><p className="font-medium text-fg">Leave or delete this workspace</p><p className="text-xs text-fg-subtle">Not available yet. Ask us if you need it.</p></div><Badge>Not available</Badge></div></Panel>
    </div>
  );
}
