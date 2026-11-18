"use client";
import * as React from "react";
import { Globe, Send, X } from "lucide-react";
import { WEB_CHAT_LIMITS, type WidgetMessage, type WidgetPublicConfig } from "@crm/contracts";
import { STR, type Lang, type Strings } from "./strings";
import "./widget.css";

type Pending = { clientId: string; body: string; failed: boolean };
type Phase = "connecting" | "ready" | "off" | "blocked" | "error";

const POLL_MS = 3000; // panel open
const POLL_CLOSED_MS = 15000; // panel closed (only to keep the launcher's unread badge honest)
const POLL_HIDDEN_MS = 15000; // panel open but the tab is in the background
const POLL_MAX_MS = 30000;
const CLOSED_STOP_MS = 10 * 60_000; // after this long closed, stop polling until the panel is opened again

const lum = (hex: string) => {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!;
};
/** White or near-black text, whichever is readable on the widget color (WCAG relative luminance). */
const onColor = (hex: string) => (lum(hex) > 0.4 ? "#111827" : "#ffffff");
/** The accent darkened until it reads on white (>= 4.5:1): used for text on the white quick-reply chips. */
function chipInk(hex: string) {
  for (let k = 1; k >= 0; k -= 0.05) {
    const c = [1, 3, 5].map((i) => Math.round(parseInt(hex.slice(i, i + 2), 16) * k));
    const h = `#${c.map((v) => v.toString(16).padStart(2, "0")).join("")}`;
    if (1.05 / (lum(h) + 0.05) >= 4.5) return h;
  }
  return "#1c1d22";
}
const timeOf = (iso: string, lang: Lang) => new Date(iso).toLocaleTimeString(lang === "bn" ? "bn-BD" : [], { hour: "numeric", minute: "2-digit" });
const lsGet = (k: string) => { try { return localStorage.getItem(k); } catch { return null; } };
const lsSet = (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* storage blocked: it works until the page is closed */ } };

function Avatar({ name, url, small }: { name: string; url: string | null; small?: boolean }) {
  const [bad, setBad] = React.useState(false);
  return (
    <span className={`cw-mark${small ? " sm" : ""}`} aria-hidden="true">
      {/* referrerPolicy: the picture's host never learns which page or widget key asked for it */}
      {url && !bad ? <img src={url} alt="" referrerPolicy="no-referrer" onError={() => setBad(true)} /> : (name.trim().charAt(0) || "C").toUpperCase()}
    </span>
  );
}

/**
 * The visitor's chat. Everything the visitor or an agent wrote is rendered as text by React (no HTML is ever interpreted). The session token lives in this origin's localStorage and is sent only as a bearer
 * header to /public/widget/*. Realtime is short polling: 3 s while the panel is open, 15 s while it is closed (so the launcher can show unread replies), paused while the tab is hidden and after 10 minutes closed.
 * It asks for messages after the last one it GOT FROM THE SERVER, so nothing that arrived between two of our own sends is skipped. The loader (parent page) and this page talk by postMessage; both sides check origin and source.
 */
export function Chat({ widgetKey }: { widgetKey: string }) {
  const base = `/public/widget/${widgetKey}`;
  const storeKey = `crm-chat:${widgetKey}`;
  const langKey = `crm-chat-lang:${widgetKey}`;
  const seenKey = `crm-chat-seen:${widgetKey}`;
  const [phase, setPhase] = React.useState<Phase>("connecting");
  const [config, setConfig] = React.useState<WidgetPublicConfig | null>(null);
  const [lang, setLang] = React.useState<Lang>("en");
  const [items, setItems] = React.useState<WidgetMessage[]>([]);
  const [pending, setPending] = React.useState<Pending[]>([]);
  const [draft, setDraft] = React.useState("");
  const [trap, setTrap] = React.useState("");
  const [prechat, setPrechat] = React.useState(false);
  const [offline, setOffline] = React.useState(false);
  const [sendError, setSendError] = React.useState<string | null>(null);
  const [isOpen, setIsOpen] = React.useState(true);
  const [awayState, setAwayState] = React.useState<"idle" | "sending" | "done" | "bad" | "fail">("idle");
  const token = React.useRef<string | null>(null);
  const cursor = React.useRef(0);
  const host = React.useRef("");
  const preview = React.useRef("");
  const timer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const failures = React.useRef(0);
  const open = React.useRef(true); // true until a parent page tells us otherwise (the page can also be opened on its own)
  const closedAt = React.useRef(Date.now());
  const seen = React.useRef(0);
  const parentOrigin = React.useRef<string | null>(null);
  const framed = React.useRef(false);
  const page = React.useRef("");
  const langChosen = React.useRef(false);
  const pageWaiters = React.useRef<Array<() => void>>([]);
  const inputRef = React.useRef<HTMLTextAreaElement>(null);
  const logRef = React.useRef<HTMLDivElement>(null);
  const innerRef = React.useRef<HTMLDivElement>(null);
  const topRef = React.useRef<HTMLDivElement>(null);
  const awayRef = React.useRef<HTMLDivElement>(null);
  const composerRef = React.useRef<HTMLFormElement>(null);
  const t: Strings = STR[lang];

  const call = React.useCallback(async (method: "GET" | "POST", path: string, body?: unknown) => {
    const headers: Record<string, string> = { "x-widget-host": host.current, ...(preview.current ? { "x-widget-preview": preview.current } : {}) };
    if (body !== undefined) headers["content-type"] = "application/json";
    if (token.current) headers.authorization = `Bearer ${token.current}`;
    const res = await fetch(`${base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), cache: "no-store" });
    const data = (await res.json().catch(() => ({}))) as { error?: { code?: string; message?: string } } & Record<string, unknown>;
    return { status: res.status, ok: res.ok, data, code: data.error?.code, message: data.error?.message };
  }, [base]);

  const merge = React.useCallback((incoming: WidgetMessage[]) => {
    setItems((cur) => {
      const have = new Set(cur.map((m) => m.seq));
      const add = incoming.filter((m) => m.seq > 0 && !have.has(m.seq));
      return add.length ? [...cur, ...add].sort((a, b) => a.seq - b.seq) : cur;
    });
  }, []);

  const newSession = React.useCallback(async () => {
    const r = await call("POST", "/sessions", {});
    if (!r.ok) return r;
    token.current = r.data.token as string;
    lsSet(storeKey, token.current);
    cursor.current = 0;
    seen.current = 0;
    setItems([]);
    return r;
  }, [call, storeKey]);

  const poll = React.useCallback(async () => {
    if (!token.current) return;
    try {
      const r = await call("GET", `/messages?after=${cursor.current}`);
      if (r.status === 401) { // the session ended (expired, or the key was replaced): start a fresh one, quietly
        const s = await newSession();
        if (!s.ok) throw new Error("session");
      } else if (r.status === 403 && r.code === "widget_disabled") { setPhase("off"); return; }
      else if (!r.ok) throw new Error("poll");
      else {
        const list = (r.data.items as WidgetMessage[]) ?? [];
        if (list.length) { cursor.current = Math.max(cursor.current, ...list.map((m) => m.seq)); merge(list); }
        setPrechat((p) => (list.length ? false : p));
      }
      failures.current = 0;
      setOffline(false);
    } catch {
      failures.current += 1;
      setOffline(true);
    }
  }, [call, merge, newSession]);

  /** Closed panels poll slowly, then stop after 10 minutes; a hidden tab never polls while closed. */
  const shouldPoll = () => open.current || (document.visibilityState === "visible" && Date.now() - closedAt.current < CLOSED_STOP_MS);
  const schedule = React.useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    if (!shouldPoll()) return; // resumed by opening the panel or the tab becoming visible
    const hidden = document.visibilityState === "hidden";
    const base = open.current ? (hidden ? POLL_HIDDEN_MS : POLL_MS) : POLL_CLOSED_MS;
    const wait = failures.current > 0 ? Math.min(POLL_MAX_MS, base * 2 ** failures.current) : base;
    timer.current = setTimeout(async () => {
      if (shouldPoll() && navigator.onLine !== false) await poll();
      schedule();
    }, wait);
  }, [poll]);
  const resume = React.useCallback(() => {
    if (!token.current || !shouldPoll()) return;
    failures.current = 0;
    void poll().then(schedule);
  }, [poll, schedule]);

  const start = React.useCallback(async () => {
    try {
      // The first request after a quiet period can be slow (the server may be waking up): retry a few times before showing an error.
      let cfg: Awaited<ReturnType<typeof call>> | null = null;
      for (let i = 0; i < 4; i++) {
        try { cfg = await call("GET", "/config"); if (cfg.status < 500) break; } catch { cfg = null; }
        await new Promise((r) => setTimeout(r, 1000 * 2 ** i));
      }
      if (!cfg) throw new Error("network");
      if (cfg.code === "origin_not_allowed" || cfg.code === "origin_required" || cfg.status === 404) { setPhase("blocked"); return; }
      if (!cfg.ok) throw new Error("config");
      const c = cfg.data as unknown as WidgetPublicConfig;
      setConfig(c);
      if (!langChosen.current) setLang(c.defaultLanguage);
      if (!c.enabled) { setPhase("off"); return; }
      token.current = lsGet(storeKey);
      if (!token.current) {
        const s = await newSession();
        if (!s.ok) { if (s.code === "widget_disabled") { setPhase("off"); return; } throw new Error("session"); }
      }
      cursor.current = 0;
      seen.current = Number(lsGet(seenKey) ?? 0) || 0;
      setItems([]);
      await poll();
      failures.current = 0;
      setOffline(false);
      setPrechat(c.prechatForm);
      setPhase("ready");
      schedule();
    } catch {
      setPhase("error");
    }
  }, [call, newSession, poll, schedule, storeKey, seenKey]);

  const toParent = React.useCallback((msg: Record<string, unknown>) => {
    if (framed.current) window.parent.postMessage(msg, parentOrigin.current ?? "*"); // the messages carry no personal data: a count, a size, a request for the page address
  }, []);

  React.useEffect(() => {
    const sp = new URLSearchParams(window.location.search);
    const q = sp.get("host") ?? "";
    preview.current = sp.get("preview") ?? ""; // owner preview grant, passed on by widget.js from the sample page
    // location.ancestorOrigins (Chromium, Safari) is set by the browser and cannot be forged by the page; the ?host= value from the loader is the fallback.
    parentOrigin.current = window.location.ancestorOrigins?.[0] ?? null;
    host.current = parentOrigin.current ?? q;
    framed.current = window.parent !== window;
    open.current = !framed.current;
    const stored = lsGet(langKey);
    if (stored === "en" || stored === "bn") { langChosen.current = true; void Promise.resolve().then(() => setLang(stored)); }
    void Promise.resolve().then(() => { setIsOpen(open.current); return start(); }); // after the first render, so the first state change is not made inside the effect body
    const vis = () => resume();
    const on = () => resume();
    const off = () => setOffline(true);
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") close(); };
    // The loader tells us when the panel opens or closes and which page the visitor is on. Only our direct parent counts.
    const msg = (e: MessageEvent) => {
      if (e.source !== window.parent || (parentOrigin.current && e.origin !== parentOrigin.current)) return;
      const d = e.data as { type?: string; open?: unknown; page?: unknown } | null;
      if (!d || typeof d !== "object") return;
      if (d.type === "crm-chat:state" || d.type === "crm-chat:page") {
        if (typeof d.page === "string") page.current = d.page;
        pageWaiters.current.splice(0).forEach((f) => f());
      }
      if (d.type === "crm-chat:state" && typeof d.open === "boolean") {
        const was = open.current;
        open.current = d.open;
        setIsOpen(d.open);
        if (was && !d.open) closedAt.current = Date.now();
        if (!was && d.open) { resume(); setTimeout(() => inputRef.current?.focus(), 30); }
      }
    };
    document.addEventListener("visibilitychange", vis);
    window.addEventListener("online", on);
    window.addEventListener("offline", off);
    window.addEventListener("message", msg);
    document.addEventListener("keydown", esc);
    return () => {
      if (timer.current) clearTimeout(timer.current);
      document.removeEventListener("visibilitychange", vis);
      window.removeEventListener("online", on);
      window.removeEventListener("offline", off);
      window.removeEventListener("message", msg);
      document.removeEventListener("keydown", esc);
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Unread agent replies, counted from the last sequence number seen with the panel open. Reported to the loader for its badge.
  const unread = React.useMemo(() => (isOpen ? 0 : items.filter((m) => m.from === "agent" && m.seq > seen.current).length), [items, isOpen]);
  React.useEffect(() => {
    if (isOpen && items.length) { const max = items[items.length - 1]!.seq; if (max > seen.current) { seen.current = max; lsSet(seenKey, String(max)); } }
  }, [isOpen, items, seenKey]);
  React.useEffect(() => { toParent({ type: "crm-chat:unread", n: unread }); }, [unread, toParent]);

  React.useEffect(() => { document.documentElement.lang = lang; }, [lang]);
  React.useEffect(() => { if (phase === "ready" && !prechat && isOpen) inputRef.current?.focus(); }, [phase, prechat, isOpen]);
  React.useEffect(() => { const el = logRef.current; if (el) el.scrollTop = el.scrollHeight; }, [items, pending]);

  // Ask the loader for the height the content wants (it clamps between 560 and 660 px); the panel grows with the conversation like in the design.
  React.useEffect(() => {
    if (!framed.current) return;
    let last = 0;
    const report = () => {
      const top = topRef.current?.offsetHeight ?? 0;
      const inner = (innerRef.current?.offsetHeight ?? 0) + 24;
      const away = awayRef.current ? awayRef.current.offsetHeight + 10 : 0;
      const composer = composerRef.current ? composerRef.current.offsetHeight + 22 : 0;
      const h = Math.ceil(top + Math.max(inner, 96) + away + composer);
      if (Math.abs(h - last) > 2) { last = h; toParent({ type: "crm-chat:height", h }); }
    };
    const ro = new ResizeObserver(report);
    for (const el of [topRef.current, innerRef.current, awayRef.current, composerRef.current]) if (el) ro.observe(el);
    report();
    return () => ro.disconnect();
  }, [phase, prechat, items.length, pending.length, config?.awayMode, toParent]);

  function close() { toParent({ type: "crm-chat:close" }); }
  function pickLang() { const n: Lang = lang === "en" ? "bn" : "en"; langChosen.current = true; setLang(n); lsSet(langKey, n); }

  /** The loader answers with the page the visitor is on right now (origin + path). We wait a moment at most: a missing answer never blocks a message. */
  function currentPage(): Promise<string> {
    if (!framed.current) return Promise.resolve("");
    return new Promise((resolve) => {
      const done = () => resolve(page.current);
      pageWaiters.current.push(done);
      toParent({ type: "crm-chat:page?" });
      setTimeout(done, 250);
    });
  }

  async function submit(p: Pending, again = true): Promise<void> {
    setSendError(null);
    const pageUrl = await currentPage();
    const r = await call("POST", "/messages", { body: p.body, clientId: p.clientId, ...(trap ? { website: trap } : {}), ...(pageUrl ? { pageUrl } : {}) });
    if (r.status === 401 && again) { const s = await newSession(); if (s.ok) return submit(p, false); }
    // The server wants a moment between opening the chat and the first message (spam check): one automatic retry, the visitor sees "Sending…".
    if (r.code === "too_fast" && again) { await new Promise((res) => setTimeout(res, 1600)); return submit(p, false); }
    if (r.ok) {
      merge([r.data as unknown as WidgetMessage]);
      setPending((cur) => cur.filter((x) => x.clientId !== p.clientId));
      failures.current = 0;
      return;
    }
    setPending((cur) => cur.map((x) => (x.clientId === p.clientId ? { ...x, failed: true } : x)));
    setSendError(r.status === 429 ? (r.code === "too_fast" ? t.tooFast : t.tooMany) : r.status === 403 ? t.unavailable : t.sendFail);
  }
  function sendText(text: string) {
    const body = text.trim();
    if (!body) return;
    const p = { clientId: crypto.randomUUID(), body, failed: false };
    setPending((cur) => [...cur, p]);
    void submit(p);
  }
  function onSend(e?: React.FormEvent) {
    e?.preventDefault();
    if (!draft.trim()) return;
    sendText(draft);
    setDraft("");
  }
  function retry(p: Pending) {
    setPending((cur) => cur.map((x) => (x.clientId === p.clientId ? { ...x, failed: false } : x)));
    void submit(p);
  }
  React.useEffect(() => { const el = inputRef.current; if (el) { el.style.height = "auto"; el.style.height = `${Math.min(el.scrollHeight, 120)}px`; } }, [draft]);

  async function sendPrechat(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const name = String(f.get("name") ?? "").trim();
    const email = String(f.get("email") ?? "").trim();
    if (name || email) await call("POST", "/contact", { ...(name ? { name } : {}), ...(email ? { email } : {}) });
    setPrechat(false);
  }
  /** Away notice: the email goes to the same public contact endpoint as the pre-chat form. Messages can still be sent. */
  async function sendAway(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const email = String(new FormData(e.currentTarget).get("email") ?? "").trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) { setAwayState("bad"); return; }
    setAwayState("sending");
    try { const r = await call("POST", "/contact", { email }); setAwayState(r.ok ? "done" : "fail"); } catch { setAwayState("fail"); }
  }

  const accent = config?.color ?? "#2563eb";
  const title = config?.name ?? "Chat";
  const subtitle = config ? (lang === "bn" && config.subtitle === STR.en.defaultSubtitle ? STR.bn.defaultSubtitle : config.subtitle) : "";
  const greeting = config?.greeting || t.hi;
  const quick = config?.quickReplies ?? [];
  const started = items.length > 0 || pending.length > 0;
  const ready = phase === "ready" && !prechat;
  const style = { "--accent": accent, "--on": onColor(accent), "--chip": chipInk(accent) } as React.CSSProperties;

  return (
    <div className="cw" style={style} lang={lang}>
      <div className="cw-top" ref={topRef}>
        <div className="cw-bar">
          <Avatar name={title} url={config?.avatarUrl ?? null} />
          <div className="cw-who"><h1>{title}</h1>{subtitle && <small>{subtitle}</small>}</div>
          <button type="button" className="cw-ibtn" onClick={pickLang} aria-label={t.langAria}><Globe size={16} strokeWidth={1.8} aria-hidden /><span aria-hidden="true">{t.langShort}</span></button>
          <button type="button" className="cw-ibtn" onClick={close} aria-label={t.close}><X size={20} strokeWidth={1.9} aria-hidden /></button>
        </div>
        <div className={`cw-hero${started || !ready ? " collapsed" : ""}`} aria-hidden={started || !ready ? true : undefined} inert={started || !ready ? true : undefined}>
          <div className="cw-heroin">
            <h2>{greeting}</h2>
            {quick.length > 0 && (
              <div className="cw-chips" role="group" aria-label={t.quick}>
                {quick.map((q) => <button key={q} type="button" onClick={() => sendText(q)}>{q}</button>)}
              </div>
            )}
          </div>
        </div>
      </div>

      {phase === "connecting" && (
        <div role="status" className="cw-state"><div className="cw-spin" aria-hidden="true" /><p>{t.connecting}</p></div>
      )}
      {phase === "error" && (
        <div role="alert" className="cw-state">
          <p><b>{t.errTitle}</b></p><p>{t.errBody}</p>
          <button type="button" className="cw-btn" onClick={() => { setPhase("connecting"); void start(); }}>{t.retry}</button>
        </div>
      )}
      {phase === "blocked" && (
        <div role="alert" className="cw-state"><p><b>{t.blockedTitle}</b></p><p>{t.blockedBody}</p></div>
      )}
      {phase === "off" && (
        <div role="status" className="cw-state"><p><b>{t.offTitle}</b></p><p>{config?.offlineMessage || t.offBody}</p></div>
      )}

      {phase === "ready" && prechat && (
        <form onSubmit={(e) => void sendPrechat(e)} className="cw-pre">
          <p>{greeting === t.hi ? t.preHi : greeting}</p>
          <label>{t.preName}<input name="name" autoComplete="name" maxLength={100} /></label>
          <label>{t.preEmail}<input name="email" type="email" autoComplete="email" maxLength={254} /></label>
          <div style={{ display: "flex", gap: 8 }}>
            <button type="submit" className="cw-btn">{t.preStart}</button>
            <button type="button" className="cw-btn plain" onClick={() => setPrechat(false)}>{t.preSkip}</button>
          </div>
        </form>
      )}

      {ready && (
        <>
          {offline && <p role="status" className="cw-recon">{t.reconnecting}</p>}
          <div ref={logRef} role="log" aria-live="polite" aria-relevant="additions" aria-label={t.conv} className="cw-log">
            <div ref={innerRef} className="cw-log-in">
              {items.map((m) => {
                const me = m.from === "visitor";
                return (
                  <div key={m.seq} className={`cw-row ${me ? "me" : "them"}`}>
                    {!me && <Avatar name={title} url={config?.avatarUrl ?? null} small />}
                    <div className="cw-col">
                      <div className="cw-m"><span className="sr">{me ? t.you : t.support}</span>{m.body}</div>
                      <time className="cw-meta" dateTime={m.at}>{timeOf(m.at, lang)}{me ? ` · ${t.sent}` : ""}</time>
                    </div>
                  </div>
                );
              })}
              {pending.map((p) => (
                <div key={p.clientId} className="cw-row me">
                  <div className="cw-col">
                    <div className="cw-m"><span className="sr">{t.you}</span>{p.body}</div>
                    {p.failed ? <button type="button" className="cw-retry" onClick={() => retry(p)}>{t.notSent}</button> : <span className="cw-meta">{t.sending}</span>}
                  </div>
                </div>
              ))}
            </div>
          </div>
          {sendError && <p role="alert" className="cw-err">{sendError}</p>}
          {config?.awayMode && (
            <div className="cw-away" ref={awayRef}>
              <span>{config.awayText || t.away}</span>
              {awayState === "done" ? <p role="status" className="cw-ok" style={{ marginTop: 8 }}>{t.emailDone}</p> : (
                <form onSubmit={(e) => void sendAway(e)} noValidate>
                  <label className="sr" htmlFor="cw-away-email">{t.emailLabel}</label>
                  <input id="cw-away-email" name="email" type="email" autoComplete="email" maxLength={254} placeholder={t.emailPh} aria-invalid={awayState === "bad" ? true : undefined} aria-describedby={awayState === "bad" || awayState === "fail" ? "cw-away-err" : undefined} />
                  <button type="submit" disabled={awayState === "sending"}>{t.send}</button>
                </form>
              )}
              {(awayState === "bad" || awayState === "fail") && <p id="cw-away-err" role="alert" className="cw-fe">{awayState === "bad" ? t.emailBad : t.emailFail}</p>}
            </div>
          )}
          <form ref={composerRef} onSubmit={onSend} className={`cw-composer${draft.trim() ? " ready" : ""}`}>
            {/* Honeypot: invisible to people and to assistive technology; bots that fill every field give themselves away. */}
            <div aria-hidden="true" style={{ position: "absolute", left: "-10000px", width: 1, height: 1, overflow: "hidden" }}>
              <input tabIndex={-1} autoComplete="off" name="website" value={trap} onChange={(e) => setTrap(e.target.value)} />
            </div>
            <label htmlFor="chat-input" className="sr">{t.msgLabel}</label>
            <textarea
              id="chat-input" ref={inputRef} value={draft} rows={1} maxLength={WEB_CHAT_LIMITS.messageChars} placeholder={t.ph}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) onSend(e); }}
            />
            <button type="submit" disabled={!draft.trim()} aria-label={t.sendAria}><Send size={18} strokeWidth={2} aria-hidden /></button>
          </form>
        </>
      )}
    </div>
  );
}
