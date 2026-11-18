"use client";
import * as React from "react";
import { Mic, Square } from "lucide-react";
import { cn } from "@/lib/cn";

/** Voice typing: the browser's speech recognition, Bangla or English, written into a text field. The audio goes to the browser's speech service (Chrome: Google, Safari: Apple), never to our server. */
type Rec = { lang: string; continuous: boolean; interimResults: boolean; start(): void; stop(): void; onresult: ((e: { resultIndex: number; results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }> }) => void) | null; onerror: ((e: { error: string }) => void) | null; onend: (() => void) | null };
type RecCtor = new () => Rec;
const ctor = (): RecCtor | null => (typeof window === "undefined" ? null : ((window as unknown as { SpeechRecognition?: RecCtor; webkitSpeechRecognition?: RecCtor }).SpeechRecognition ?? (window as unknown as { webkitSpeechRecognition?: RecCtor }).webkitSpeechRecognition ?? null));

export const VOICE_LANGS = [{ code: "en-US", label: "EN", name: "English" }, { code: "bn-BD", label: "বাংলা", name: "Bangla" }] as const;
const KEY = "crm.voiceLang";

/** Write text into a controlled input or textarea so React's onChange fires. */
function insert(el: HTMLTextAreaElement | HTMLInputElement, text: string) {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const set = Object.getOwnPropertyDescriptor(proto, "value")?.set;
  if (!set) return;
  const cur = el.value;
  let next = cur + (cur && !/\s$/.test(cur) ? " " : "") + text.trim();
  if (el.maxLength > 0) next = next.slice(0, el.maxLength);
  set.call(el, next);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

const ERRORS: Record<string, string> = {
  "not-allowed": "Microphone is blocked. Allow it in your browser's site settings.",
  "service-not-allowed": "Microphone is blocked. Allow it in your browser's site settings.",
  "no-speech": "Didn't hear anything. Try again.",
  "audio-capture": "No microphone found.",
  network: "Voice typing needs an internet connection.",
  "language-not-supported": "This browser can't do that language.",
};

export function VoiceInputButton({ target, disabled, className, variant = "inline" }: { target: React.RefObject<HTMLTextAreaElement | HTMLInputElement | null>; disabled?: boolean; className?: string; variant?: "inline" | "toolbar" }) {
  const supported = React.useSyncExternalStore(() => () => {}, () => ctor() !== null, () => false);
  const [lang, setLang] = React.useState<string>(() => { const s = typeof window === "undefined" ? null : window.localStorage.getItem(KEY); return s && VOICE_LANGS.some((l) => l.code === s) ? s : "en-US"; });
  const [on, setOn] = React.useState(false);
  const [msg, setMsg] = React.useState<string | null>(null);
  const rec = React.useRef<Rec | null>(null);

  React.useEffect(() => {
    return () => rec.current?.stop();
  }, []);

  function stop() { rec.current?.stop(); }
  function start() {
    const C = ctor();
    const el = target.current;
    if (!C || !el) return;
    setMsg(null);
    const r = new C();
    r.lang = lang; r.continuous = true; r.interimResults = false;
    r.onresult = (e) => { for (let i = e.resultIndex; i < e.results.length; i++) { const res = e.results[i]; if (res?.isFinal && res[0].transcript.trim()) insert(el, res[0].transcript); } };
    r.onerror = (e) => { if (e.error !== "aborted") setMsg(ERRORS[e.error] ?? "Voice typing stopped."); };
    r.onend = () => { setOn(false); rec.current = null; };
    rec.current = r;
    try { r.start(); setOn(true); el.focus(); } catch { setMsg("Voice typing could not start."); }
  }
  function pick(code: string) { setLang(code); window.localStorage.setItem(KEY, code); if (on) { rec.current?.stop(); } }

  if (!supported) return null;
  if (variant === "toolbar") {
    const bn = lang === "bn-BD";
    return (
      <span className={cn("inline-flex items-center", className)}>
        <button type="button" disabled={disabled} aria-pressed={on} aria-label={on ? "Stop voice typing" : "Start voice typing"} title="Voice typing uses your browser's speech service" onClick={on ? stop : start} className={cn("press inline-flex size-9 items-center justify-center rounded-control pointer-coarse:size-11 disabled:opacity-45", on ? "bg-danger text-on-accent" : "text-fg-muted hover:bg-hover hover:text-fg")}>
          {on ? <Square className="size-4 fill-current" aria-hidden /> : <Mic className="size-5" aria-hidden />}
        </button>
        <button type="button" disabled={disabled} aria-label={`${bn ? "বাংলা" : "EN"}, voice typing language. Tap to change`} onClick={() => pick(bn ? "en-US" : "bn-BD")} className="press inline-flex h-9 min-w-9 items-center justify-center rounded-control px-0.5 pointer-coarse:h-11 pointer-coarse:min-w-11 disabled:opacity-45">
          <span className="inline-flex h-7 items-center rounded-full bg-hover px-2.5 text-xs font-bold text-fg-muted">{bn ? "বাংলা" : "EN"}</span>
        </button>
        {on && <span role="status" className="ml-1 inline-flex items-center gap-1.5 text-xs text-danger-fg"><span className="size-2 animate-pulse rounded-full bg-danger" aria-hidden />Listening in {bn ? "বাংলা" : "English"}…</span>}
        {msg && <span role="status" className="ml-1 text-xs text-danger-fg">{msg}</span>}
      </span>
    );
  }
  return (
    <span className={cn("inline-flex items-center gap-1", className)}>
      <span role="group" aria-label="Voice typing language" className="inline-flex overflow-hidden rounded-full bg-subtle text-xs">
        {VOICE_LANGS.map((l) => <button key={l.code} type="button" aria-pressed={lang === l.code} aria-label={`${l.label} ${l.name}`} onClick={() => pick(l.code)} className={cn("px-2 py-1 pointer-coarse:min-h-11 pointer-coarse:px-3", lang === l.code ? "bg-fg font-semibold text-surface" : "text-fg-muted hover:text-fg")}>{l.label}</button>)}
      </span>
      <button type="button" disabled={disabled} aria-pressed={on} aria-label={on ? "Stop voice typing" : "Start voice typing"} title="Voice typing uses your browser's speech service" onClick={on ? stop : start} className={cn("press inline-flex h-8 items-center gap-1.5 rounded-full px-3 text-sm font-medium pointer-coarse:h-11 disabled:opacity-50", on ? "bg-danger text-on-accent" : "bg-subtle text-fg hover:bg-hover")}>
        {on ? <Square className="size-3.5 fill-current" aria-hidden /> : <Mic className="size-4" aria-hidden />}
        {on ? "Listening…" : "Voice"}
      </button>
      {msg && <span role="status" className="text-xs text-danger-fg">{msg}</span>}
    </span>
  );
}
