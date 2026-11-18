"use client";
import * as React from "react";
import { Loader2, Send, X } from "lucide-react";
import { WEB_CHAT_LIMITS, type WidgetMessage, type WidgetPublicConfig } from "@crm/contracts";

type Pending = { clientId: string; body: string; failed: boolean };
type Phase = "connecting" | "ready" | "off" | "blocked" | "error";

const POLL_MS = 3000;
const POLL_HIDDEN_MS = 15000;
const POLL_MAX_MS = 30000;

/** White or near-black text, whichever is readable on the widget color (WCAG relative luminance). */
function onColor(hex: string) {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  const l = 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!;
  return l > 0.4 ? "#111827" : "#ffffff";
}
const timeOf = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

/**
 * The visitor's chat. Everything the visitor or an agent wrote is rendered as text by React (no HTML is ever interpreted). The session token lives in this origin's localStorage and is sent only as a bearer
 * header to /public/widget/*. Realtime is short polling: every 3 s while the page is visible, slower while hidden, with back-off on errors; it asks for messages after the last one it GOT FROM THE SERVER,
 * so nothing that arrived between two of our own sends is skipped.
 */
export function Chat({ widgetKey }: { widgetKey: string }) {
  const base = `/public/widget/${widgetKey}`;
  const storeKey = `crm-chat:${widgetKey}`;
  const [phase, setPhase] = React.useState<Phase>("connecting");
  const [config, setConfig] = React.useState<WidgetPublicConfig | null>(null);
  const [items, setItems] = React.useState<WidgetMessage[]>([]);
  const [pending, setPending] = React.useState<Pending[]>([]);
  const [draft, setDraft] = React.useState("");
  const [trap, setTrap] = React.useState("");
  const [prechat, setPrechat] = React.useState(false);
  const [offline, setOffline] = React.useState(false);
  const [sendError, setSendError] = React.useState<string | null>(null);
  const token = React.useRef<string | null>(null);
  const cursor = React.useRef(0);
  const host = React.useRef("");
  const preview = React.useRef("");
  const timer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const failures = React.useRef(0);
  const inputRef = React.useRef<HTMLTextAreaElement>(null);
  const logRef = React.useRef<HTMLDivElement>(null);

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
    try { localStorage.setItem(storeKey, token.current); } catch { /* storage blocked: the chat works until the page is closed */ }
    cursor.current = 0;
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

  const schedule = React.useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    const hidden = document.visibilityState === "hidden";
    const wait = failures.current > 0 ? Math.min(POLL_MAX_MS, POLL_MS * 2 ** failures.current) : hidden ? POLL_HIDDEN_MS : POLL_MS;
    timer.current = setTimeout(async () => {
      if (navigator.onLine !== false) await poll();
      schedule();
    }, wait);
  }, [poll]);

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
      if (!c.enabled) { setPhase("off"); return; }
      let saved: string | null = null;
      try { saved = localStorage.getItem(storeKey); } catch { /* ignore */ }
      token.current = saved;
      if (!token.current) {
        const s = await newSession();
        if (!s.ok) { if (s.code === "widget_disabled") { setPhase("off"); return; } throw new Error("session"); }
      }
      cursor.current = 0;
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
  }, [call, newSession, poll, schedule, storeKey]);

  React.useEffect(() => {
    const sp = new URLSearchParams(window.location.search);
    const q = sp.get("host") ?? "";
    preview.current = sp.get("preview") ?? ""; // owner preview grant, passed on by widget.js from the sample page
    // location.ancestorOrigins (Chromium, Safari) is set by the browser and cannot be forged by the page; the ?host= value from the loader is the fallback.
    host.current = window.location.ancestorOrigins?.[0] ?? q;
    void Promise.resolve().then(start); // after the first render, so the first state change is not made inside the effect body
    const vis = () => { if (document.visibilityState === "visible" && token.current) { failures.current = 0; void poll().then(schedule); } };
    const on = () => { failures.current = 0; void poll().then(schedule); };
    const off = () => setOffline(true);
    document.addEventListener("visibilitychange", vis);
    window.addEventListener("online", on);
    window.addEventListener("offline", off);
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") close(); };
    document.addEventListener("keydown", esc);
    return () => {
      if (timer.current) clearTimeout(timer.current);
      document.removeEventListener("visibilitychange", vis);
      window.removeEventListener("online", on);
      window.removeEventListener("offline", off);
      document.removeEventListener("keydown", esc);
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  React.useEffect(() => { if (phase === "ready" && !prechat) inputRef.current?.focus(); }, [phase, prechat]);
  React.useEffect(() => { const el = logRef.current; if (el) el.scrollTop = el.scrollHeight; }, [items, pending]);

  function close() {
    // The loader (the page that framed us) closes the panel. targetOrigin is the framing site when the browser tells us, otherwise "*": the message carries no data.
    window.parent?.postMessage({ type: "crm-chat:close" }, window.location.ancestorOrigins?.[0] ?? "*");
  }

  async function submit(p: Pending, again = true): Promise<void> {
    setSendError(null);
    const r = await call("POST", "/messages", { body: p.body, clientId: p.clientId, ...(trap ? { website: trap } : {}) });
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
    setSendError(r.status === 429 ? (r.code === "too_fast" ? "One moment, then send again." : "You are sending messages too quickly. Wait a moment.") : r.status === 403 ? "Chat is not available right now." : "Could not send. Check your connection and try again.");
  }
  function onSend(e?: React.FormEvent) {
    e?.preventDefault();
    const body = draft.trim();
    if (!body) return;
    const p = { clientId: crypto.randomUUID(), body, failed: false };
    setDraft("");
    setPending((cur) => [...cur, p]);
    void submit(p);
  }
  function retry(p: Pending) {
    setPending((cur) => cur.map((x) => (x.clientId === p.clientId ? { ...x, failed: false } : x)));
    void submit(p);
  }

  async function sendPrechat(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const name = String(f.get("name") ?? "").trim();
    const email = String(f.get("email") ?? "").trim();
    if (name || email) await call("POST", "/contact", { ...(name ? { name } : {}), ...(email ? { email } : {}) });
    setPrechat(false);
  }

  const accent = config?.color ?? "#2563eb";
  const accentText = onColor(accent);
  const greeting = config?.greeting || "Hi! Send us a message and we will reply here.";

  return (
    <div className="flex h-dvh flex-col bg-white text-[#111827]" style={{ fontSize: 16 }}>
      <header className="flex items-center justify-between gap-2 px-4 py-3" style={{ background: accent, color: accentText }}>
        <h1 className="truncate text-base font-semibold">{config?.name ?? "Chat"}</h1>
        <button type="button" onClick={close} aria-label="Close chat" className="inline-flex size-9 items-center justify-center rounded-full hover:bg-black/10 focus-visible:outline-2 focus-visible:outline-offset-2" style={{ outlineColor: accentText }}>
          <X className="size-5" aria-hidden />
        </button>
      </header>

      {phase === "connecting" && (
        <div role="status" className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center text-[#374151]">
          <Loader2 className="size-6 animate-spin" aria-hidden />
          <p>Connecting…</p>
        </div>
      )}

      {phase === "error" && (
        <div role="alert" className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
          <p className="font-medium">We could not connect.</p>
          <p className="text-[#374151]">Check your connection and try again.</p>
          <button type="button" onClick={() => { setPhase("connecting"); void start(); }} className="min-h-11 rounded-lg px-4 font-medium" style={{ background: accent, color: accentText }}>Try again</button>
        </div>
      )}

      {phase === "blocked" && (
        <div role="alert" className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center">
          <p className="font-medium">Chat is not available here.</p>
          <p className="text-[#374151]">This chat only works on the website it was set up for.</p>
        </div>
      )}

      {phase === "off" && (
        <div role="status" className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center">
          <p className="font-medium">We are offline right now.</p>
          <p className="text-[#374151]">{config?.offlineMessage || "Chat is not available at the moment. Please try again later."}</p>
        </div>
      )}

      {phase === "ready" && prechat && (
        <form onSubmit={(e) => void sendPrechat(e)} className="flex flex-1 flex-col gap-3 overflow-y-auto p-4">
          <p className="text-[#374151]">{greeting}</p>
          <label className="flex flex-col gap-1 text-sm font-medium">Your name (optional)
            <input name="name" autoComplete="name" maxLength={100} className="min-h-11 rounded-lg border border-[#9ca3af] px-3 text-base font-normal" />
          </label>
          <label className="flex flex-col gap-1 text-sm font-medium">Your email (optional)
            <input name="email" type="email" autoComplete="email" maxLength={254} className="min-h-11 rounded-lg border border-[#9ca3af] px-3 text-base font-normal" />
          </label>
          <div className="flex gap-2">
            <button type="submit" className="min-h-11 rounded-lg px-4 font-medium" style={{ background: accent, color: accentText }}>Start chat</button>
            <button type="button" onClick={() => setPrechat(false)} className="min-h-11 rounded-lg px-4 font-medium text-[#374151] underline">Skip</button>
          </div>
        </form>
      )}

      {phase === "ready" && !prechat && (
        <>
          {offline && <p role="status" className="bg-[#fef3c7] px-4 py-2 text-sm text-[#78350f]">Reconnecting…</p>}
          <div ref={logRef} role="log" aria-live="polite" aria-relevant="additions" aria-label="Conversation" className="flex flex-1 flex-col gap-2 overflow-y-auto p-4">
            {items.length === 0 && pending.length === 0 && <p className="rounded-xl bg-[#f3f4f6] px-3 py-2 text-[#374151]">{greeting}</p>}
            {items.map((m) => (
              <div key={m.seq} className={m.from === "visitor" ? "flex flex-col items-end" : "flex flex-col items-start"}>
                <p className="max-w-[85%] whitespace-pre-wrap break-words rounded-2xl px-3 py-2" style={m.from === "visitor" ? { background: accent, color: accentText } : { background: "#f3f4f6", color: "#111827" }}>
                  <span className="sr-only">{m.from === "visitor" ? "You: " : "Support: "}</span>{m.body}
                </p>
                <time dateTime={m.at} className="mt-0.5 px-1 text-xs text-[#4b5563]">{timeOf(m.at)}</time>
              </div>
            ))}
            {pending.map((p) => (
              <div key={p.clientId} className="flex flex-col items-end">
                <p className="max-w-[85%] whitespace-pre-wrap break-words rounded-2xl px-3 py-2 opacity-70" style={{ background: accent, color: accentText }}><span className="sr-only">You: </span>{p.body}</p>
                {p.failed ? <button type="button" onClick={() => retry(p)} className="mt-0.5 px-1 text-xs font-medium text-[#b91c1c] underline">Not sent. Try again</button> : <span className="mt-0.5 px-1 text-xs text-[#4b5563]">Sending…</span>}
              </div>
            ))}
          </div>
          {sendError && <p role="alert" className="px-4 pb-1 text-sm text-[#b91c1c]">{sendError}</p>}
          <form onSubmit={onSend} className="flex items-end gap-2 border-t border-[#e5e7eb] p-3">
            {/* Honeypot: invisible to people and to assistive technology; bots that fill every field give themselves away. */}
            <div aria-hidden="true" style={{ position: "absolute", left: "-10000px", width: 1, height: 1, overflow: "hidden" }}>
              <input tabIndex={-1} autoComplete="off" name="website" value={trap} onChange={(e) => setTrap(e.target.value)} />
            </div>
            <label htmlFor="chat-input" className="sr-only">Your message</label>
            <textarea
              id="chat-input" ref={inputRef} value={draft} rows={1} maxLength={WEB_CHAT_LIMITS.messageChars} placeholder="Write a message"
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) onSend(e); }}
              className="max-h-32 min-h-11 flex-1 resize-none rounded-lg border border-[#9ca3af] px-3 py-2.5 text-base"
              style={{ fontSize: 16 }}
            />
            <button type="submit" disabled={!draft.trim()} aria-label="Send message" className="inline-flex size-11 shrink-0 items-center justify-center rounded-lg disabled:opacity-50" style={{ background: accent, color: accentText }}>
              <Send className="size-5" aria-hidden />
            </button>
          </form>
        </>
      )}
    </div>
  );
}
